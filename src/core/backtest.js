/**
 * Grind della matrice di backtest: esegue le run pending di una sessione senza far tornare
 * il controllo al modello a ogni passo.
 *
 * Perché esiste: il ciclo per-run (apri → applica input → attendi ricalcolo → scrape →
 * screenshot → finalize) non contiene NESSUNA decisione — l'input_set viene dal DB, le
 * metriche da un'API, il payload è un mapping fisso. Farlo girare a colpi di tool-call
 * costava ~5 turni e ~1,5-2k token di contesto per run, cioè ~120k su una sessione da 60:
 * è quello che saturava la finestra a metà grind. Qui il modello paga UNA chiamata e
 * riceve una tabella.
 *
 * Il modello resta nel giro dove serve davvero: decide la matrice prima, e riprende il
 * controllo appena compare un'anomalia (circuit breaker).
 */
import { setInputs as realSetInputs } from './indicators.js';
import { getStrategyResults as realGetStrategyResults } from './data.js';
import { captureScreenshot as realCaptureScreenshot } from './capture.js';
import {
  readInputsInfo as realReadInputsInfo,
  readInputValues as realReadInputValues,
  readComputedReportEntityId as realReadComputedReportEntityId,
  readbackMatches,
} from './btChart.js';
import { buildInputsPayload } from './btInputs.js';
import { toFinalizePayload, fingerprint, detectAnomaly } from './btMetrics.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attende che il report della strategia sia CAMBIATO rispetto a prima **e si sia STABILIZZATO**.
 *
 * Le due condizioni sono entrambe necessarie, e la seconda è quella che costa cara se manca.
 * TradingView pubblica risultati PARZIALI mentre ricalcola: il report cresce trade dopo trade
 * fino al valore finale. Una versione precedente si fermava al primo cambiamento e registrava
 * un fotogramma di mezzo — misurato dal vivo il 2026-08-11: salvati 208 trade / -1,86% mentre
 * il risultato vero, un paio di secondi dopo, era 288 trade / +41,57%. Numeri plausibili e
 * completamente falsi, senza nessun errore da nessuna parte.
 *
 * Quindi: prima si aspetta che la firma cambi (il ricalcolo è partito), poi che resti IDENTICA
 * per `stableChecks` letture consecutive (il ricalcolo è finito).
 *
 * Se scade il tempo ritorna comunque l'ultimo report: metriche invariate NON sono un errore di
 * per sé (due input diversi possono dare lo stesso risultato) — la discriminazione la fa il
 * readback in detectAnomaly.
 */
async function waitForRecalc(prevFp, { getStrategyResults, sleep, timeoutMs = 45000, stepMs = 700, stableChecks = 3 }) {
  let last = null;
  let lastFp = null;
  let stable = 0;
  let changed = false;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    last = await getStrategyResults();
    if (!last || last.success === false) return last;

    const fp = fingerprint(last.metrics);
    if (fp !== prevFp) changed = true;
    stable = fp === lastFp ? stable + 1 : 0;
    lastFp = fp;

    if (changed && stable >= stableChecks) return last;
    if (Date.now() >= deadline) return last;
    await sleep(stepMs);
  }
}

export async function grindSession(opts, deps = {}) {
  const {
    session_id, entity_id, command_id = null, max_runs = 0,
    // 45s: un ricalcolo su un anno di dati intraday impiega diversi secondi, e a questi va
    // sommato il tempo di stabilizzazione. Meglio abbondare: il costo di aspettare troppo e'
    // qualche secondo per run, quello di aspettare troppo poco e' un backtest falso.
    period_start = null, period_end = null, recalc_timeout_ms = 45000, recalc_stable_checks = 3,
    max_consecutive_failures = 3,
  } = opts;

  const {
    api,
    setInputs = realSetInputs,
    getStrategyResults = realGetStrategyResults,
    captureScreenshot = realCaptureScreenshot,
    readInputsInfo = realReadInputsInfo,
    readInputValues = realReadInputValues,
    readComputedReportEntityId = realReadComputedReportEntityId,
    sleep = realSleep,
  } = deps;

  if (!session_id) throw new Error('session_id è obbligatorio');
  if (!entity_id) throw new Error('entity_id è obbligatorio (prendilo da chart_get_state)');

  // La mappa id→nome→tipo si legge UNA volta: non cambia tra le run della stessa strategia.
  const info = await readInputsInfo(entity_id);
  if (!info.length) throw new Error(`nessun input leggibile per entity_id=${entity_id}: la strategia è sul chart?`);

  // Il report lo legge getStrategyResults(), che NON accetta un entity_id: prende la prima
  // strategia con un report calcolato, cioè quella selezionata nel pannello Strategy Tester.
  // Se non è la nostra, il grind applicherebbe gli input a una strategia e registrerebbe le
  // metriche di un'altra — con numeri perfettamente plausibili e nessun errore. Si verifica
  // una volta sola: la selezione del pannello non cambia da sé durante il grind.
  const reportOwner = await readComputedReportEntityId();
  if (reportOwner && reportOwner !== entity_id) {
    throw new Error(
      `il pannello Strategy Tester sta mostrando la strategia ${reportOwner}, non ${entity_id}: `
      + 'seleziona la strategia giusta nel pannello prima di far partire il grind, '
      + 'altrimenti i backtest registrerebbero le metriche di quella sbagliata.'
    );
  }

  const rows = [];
  let executed = 0;
  let failed = 0;
  let stopped_reason = null;
  let prevFp = fingerprint((await getStrategyResults())?.metrics || {});
  // Fallimenti CONSECUTIVI in finalize: un 422 isolato è un test storto e non deve fermare
  // la matrice, ma se la causa è sistemica (es. initialCapital sempre null perché "Initial
  // Capital" non viene riconosciuto tra gli input) ogni run fallisce allo stesso modo e senza
  // questo contatore il grind macinerebbe l'intera coda a vuoto. Si azzera a ogni successo.
  let consecutiveFinalizeFailures = 0;

  for (;;) {
    if (max_runs && executed + failed >= max_runs) break;

    const run = await api.nextRun(session_id);
    if (!run) break;

    await api.markRunning(run.id);
    await api.progress(command_id, `run ${run.id}${run.label ? ` (${run.label})` : ''}: applico gli input`);

    const requested = run.input_set || {};
    let setResult = { updated_inputs: {}, missing: [] };
    if (Object.keys(requested).length) {
      setResult = await setInputs({ entity_id, inputs: requested });
    }

    const results = await waitForRecalc(prevFp, {
      getStrategyResults, sleep, timeoutMs: recalc_timeout_ms, stableChecks: recalc_stable_checks,
    });
    const sameAsPrevious = !!results?.metrics && fingerprint(results.metrics) === prevFp;

    const actual = await readInputValues(entity_id);
    const readbackOk = readbackMatches(requested, actual);

    const anomaly = detectAnomaly({ setResult, results, readbackOk, sameAsPrevious });
    if (anomaly) {
      // Circuit breaker: NON si ritenta e NON si va avanti a variare a caso. La run resta
      // failed col motivo reale e il controllo torna al modello, che scala all'utente.
      await api.markFailed(run.id, `${anomaly.kind}: ${anomaly.detail}`);
      stopped_reason = { ...anomaly, run_id: run.id, label: run.label ?? null };
      await api.progress(command_id, `⛔ run ${run.id}: ${anomaly.kind} — mi fermo`);
      break;
    }

    const { inputs, properties, initialCapital } = buildInputsPayload(info, actual);
    const payload = toFinalizePayload(results.metrics, {
      symbol: run.symbol,
      timeframe: run.timeframe,
      period_start: run.period_start || period_start,
      period_end: run.period_end || period_end,
      initial_capital: initialCapital,
      inputs,
      properties,
    });

    const shot = await captureScreenshot({ region: 'strategy_tester' });
    if (!shot?.file_path) {
      await api.markFailed(run.id, 'screenshot equity non prodotto');
      failed++;
      rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: 'no screenshot' });
      continue;
    }

    try {
      await api.stageEquity(run.id, shot.file_path);
      await api.finalize(run.id, payload);
      executed++;
      consecutiveFinalizeFailures = 0;
      rows.push({
        run_id: run.id, label: run.label ?? null, status: 'done',
        symbol: run.symbol, timeframe: run.timeframe, period_label: run.period_label ?? null,
        net_profit_pct: payload.net_profit_pct, max_dd_pct: payload.max_drawdown_pct,
        win_rate: payload.win_rate, profit_factor: payload.profit_factor, trades: payload.total_trades,
      });
      await api.progress(command_id, `✔ run ${run.id}: ${payload.total_trades} trade, PF ${payload.profit_factor}`);
    } catch (err) {
      // Un 422 isolato non blocca la matrice (garanzia della piattaforma): la run resta
      // failed e si prosegue. Ma se il fallimento si ripete N volte DI FILA è un guasto
      // sistemico (stesso campo obbligatorio sempre rifiutato): ci si ferma e si restituisce
      // il controllo, invece di macinare l'intera matrice senza produrre nulla.
      await api.markFailed(run.id, err.message);
      failed++;
      consecutiveFinalizeFailures++;
      rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: err.message.slice(0, 300) });

      if (consecutiveFinalizeFailures >= max_consecutive_failures) {
        stopped_reason = {
          kind: 'systemic_failure', detail: err.message,
          run_id: run.id, label: run.label ?? null,
        };
        await api.progress(command_id, `⛔ ${consecutiveFinalizeFailures} fallimenti consecutivi in finalize (run ${run.id}: ${err.message}) — mi fermo`);
        break;
      }
    }

    prevFp = fingerprint(results.metrics);
  }

  return { success: true, session_id, executed, failed, stopped_reason, rows };
}
