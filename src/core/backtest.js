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
import { creaCronometro, riassumi, FASI } from './cronometro.js';
import { captureScreenshot as realCaptureScreenshot } from './capture.js';
import { setSymbol as realSetSymbol, setTimeframe as realSetTimeframe, getState as realGetState } from './chart.js';
import { setCustomPeriod as realSetCustomPeriod, readTestPeriod as realReadTestPeriod } from './btPeriod.js';
import {
  readPanelMetrics as realReadPanelMetrics, ensureTesterPanel as realEnsureTesterPanel,
  aggiornaReportSeObsoleto as realAggiornaReport,
  attendiReportAggiornato as realAttendiReport,
  setPanelMaximized as realSetPanelMaximized,
  readPeriodReport as realReadPeriodReport,
  reportObsoleto as realReportObsoleto,
} from './btPanel.js';
import { readDeepState as realReadDeepState } from './btDeep.js';
import {
  readInputsInfo as realReadInputsInfo,
  readInputValues as realReadInputValues,
  readReportFor as realReadReportFor,
  readStrategyLoading as realReadStrategyLoading,
  readStudyStatus as realReadStudyStatus,
  ensureVisibleFor as realEnsureVisibleFor,
  setStrategyVisibility as realSetStrategyVisibility,
  readCommissionFor as realReadCommissionFor,
  readbackMatches,
} from './btChart.js';
import { buildInputsPayload } from './btInputs.js';
import { resolveCommissionIds, resolveStrategyEntity } from './btCost.js';
import { toFinalizePayload, fingerprint } from './btMetrics.js';
import { misuraProva, giornoISO, fpNotoO } from './btProva.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gli aiuti della misura vivono in btProva.js, accanto al nucleo per-prova. Si riesportano da qui
// perche' btApply.js e i test li importano da questo file.
export { waitForRecalc, rileggiFinoACambio, leggiMetricheEffettive, applicaContestoRun, giornoISO, fpNotoO } from './btProva.js';

export async function grindSession(opts, deps = {}) {
  let {
    session_id, entity_id, command_id = null, max_runs = 0,
    // 45s: un ricalcolo su un anno di dati intraday impiega diversi secondi, e a questi va
    // sommato il tempo di stabilizzazione. Meglio abbondare: il costo di aspettare troppo e'
    // qualche secondo per run, quello di aspettare troppo poco e' un backtest falso.
    period_start = null, period_end = null, recalc_timeout_ms = 45000, recalc_stable_checks = 3,
    recalc_step_ms = 250, recalc_start_grace_ms = 5000,
    max_consecutive_failures = 3,
    // I progress finiscono nella chat dell'operatore, dove restano per tutta la sessione. Con tre
    // righe per run una matrice da 20 ne produce 60 e il pannello diventa illeggibile. Di default
    // parlano solo gli EVENTI — run conclusa, anomalia, stop — non i passaggi interni.
    // `verbose: true` riaccende la diagnostica passo-passo per il debug.
    verbose = false,
    // Massimizzare il pannello per lo scatto e rimetterlo subito com'era. Costa ~1,3 s per run.
    maximize_for_screenshot = true,
    // Restituisce in `timing` la scomposizione del tempo di ogni run. Il cronometro gira sempre
    // (costa pochi now()): cambia solo se il ritorno lo mostra.
    measure_timing = false,
    // Varianti di costo: le run si eseguono PER ID (il `?next=1` le filtra apposta) e l'entity_id
    // puo' arrivare come nome della strategia, risolto qui sul chart.
    run_ids = null,
    strategy_name = null,
  } = opts;

  const {
    api,
    setInputs = realSetInputs,
    captureScreenshot = realCaptureScreenshot,
    readInputsInfo = realReadInputsInfo,
    readInputValues = realReadInputValues,
    readReportFor = realReadReportFor,
    readStrategyLoading = realReadStrategyLoading,
    readStudyStatus = realReadStudyStatus,
    readCommissionFor = realReadCommissionFor,
    ensureVisibleFor = realEnsureVisibleFor,
    setStrategyVisibility = realSetStrategyVisibility,
    setSymbol = realSetSymbol,
    setTimeframe = realSetTimeframe,
    getChartState = realGetState,
    setCustomPeriod = realSetCustomPeriod,
    readTestPeriod = realReadTestPeriod,
    readPanelMetrics = realReadPanelMetrics,
    readPeriodReport = realReadPeriodReport,
    ensureTesterPanel = realEnsureTesterPanel,
    aggiornaReportSeObsoleto = realAggiornaReport,
    attendiReportAggiornato = realAttendiReport,
    readDeepState = realReadDeepState,
    reportObsoleto = realReportObsoleto,
    setPanelMaximized = realSetPanelMaximized,
    sleep = realSleep,
    now = () => performance.now(),
  } = deps;

  const t0 = now();
  const cron = creaCronometro(now);

  // Il dettaglio passo-passo passa da qui: si vede solo con `verbose`. Gli eventi (✔ ⛔ ○) chiamano
  // `api.progress` direttamente, cosi' non c'e' modo di silenziarli per sbaglio.
  const nota = async (msg) => { if (verbose) await api.progress(command_id, msg); };

  if (!session_id) throw new Error('session_id è obbligatorio');
  if (!entity_id && strategy_name) {
    const ris = resolveStrategyEntity(await getChartState(), strategy_name);
    if (ris.error) throw new Error(`${ris.error.kind}: ${ris.error.detail}`);
    entity_id = ris.entity_id;
  }
  if (!entity_id) throw new Error('entity_id è obbligatorio (prendilo da chart_get_state, o passa strategy_name)');

  // La mappa id→nome→tipo si legge UNA volta: non cambia tra le run della stessa strategia.
  const info = await readInputsInfo(entity_id);
  if (!info.length) throw new Error(`nessun input leggibile per entity_id=${entity_id}: la strategia è sul chart?`);

  // Le due Proprieta' della commissione, trovate PER NOME: si usano solo per le run con
  // `cost_params`. Sulle altre run questa riga non ha effetti.
  const idsCommissione = resolveCommissionIds(info);

  // Con `run_ids` le run si leggono per id nell'ordine dato; senza, dalla coda `?next=1` come sempre.
  const codaPerId = Array.isArray(run_ids) ? [...run_ids] : null;
  const prossimaRun = async () => {
    if (!codaPerId) return api.nextRun(session_id);
    while (codaPerId.length) {
      const id = codaPerId.shift();
      let r;
      try { r = await api.getRun(id); }
      catch (e) { await api.progress(command_id, `run ${id}: non leggibile (${e.message}), salto`); continue; }
      if (!r) { await api.progress(command_id, `run ${id}: non trovata, salto`); continue; }
      if (r.status !== 'pending') { await api.progress(command_id, `run ${id}: stato ${r.status}, salto`); continue; }
      return r;
    }
    return null;
  };

  // TradingView non calcola il report di una strategia invisibile. Serve quindi che la NOSTRA
  // sia visibile — e solo la nostra: l'unhide indiscriminato di ensureStrategyTesterReady()
  // accendeva ogni strategia nascosta del chart, e quella appena accesa poteva prendersi il
  // report. Si annota lo stato precedente per rimettere il chart come l'utente l'aveva.
  // Il pannello serve sia per gli screenshot equity sia — per le run con periodo — come UNICA
  // fonte di metriche. Se e' collassato il blocco "Statistiche chiave" non e' nel DOM.
  // Fail-closed: senza pannello le run con periodo non hanno una fonte di metriche valida e il
  // pulsante del periodo non esiste nemmeno. Partire lo stesso significa fallire alla run 1 con un
  // motivo che punta altrove — successo il 2026-08-11, due volte di fila. Meglio fermarsi qui,
  // dove il motivo e' ancora vero.
  const pannello = await ensureTesterPanel();
  if (!pannello.ok) {
    throw new Error(`${pannello.error || 'pannello Strategy Tester non pronto'}. Aprilo (ui_open_panel strategy-tester) e rilancia: il grind riparte dalle run pending.`);
  }

  const vis = await ensureVisibleFor(entity_id);
  if (!vis.found) {
    throw new Error(`la strategia ${entity_id} non è fra le data source del chart: aprila prima di far partire il grind.`);
  }
  const restoreHidden = vis.wasHidden;

  // Recupero delle run orfane: se un grind precedente e' morto dopo `markRunning`, quella run e'
  // rimasta `running` — e `nextRun` serve SOLO le `pending`, quindi era persa per sempre e la
  // matrice non poteva piu' chiudersi. Successo il 2026-08-11 (run 1140): sessione dichiarata
  // completata con 10 backtest su 20. Qui le si rimette in coda prima di cominciare.
  // Presuppone un solo grind alla volta sulla stessa sessione, che e' il modello d'uso reale.
  if (typeof api.listRuns === 'function' && typeof api.reclaimRun === 'function') {
    try {
      const orfane = await api.listRuns(session_id, 'running');
      for (const r of orfane) {
        await api.reclaimRun(r.id);
        await api.progress(command_id, `run ${r.id}: era rimasta appesa in running, rimessa in coda`);
      }
    } catch { /* il recupero e' un di piu': se fallisce si prosegue con le pending */ }
  }

  const rows = [];
  let executed = 0;
  let failed = 0;
  let stopped_reason = null;
  // `null` = baseline ASSENTE, che non e' una baseline vuota. Il pannello puo' non avere ancora
  // metriche (chart in caricamento, tipicamente subito dopo un rilancio di TradingView):
  // fotografarlo lo stesso produce una firma di soli null, e rispetto al nulla QUALUNQUE numero
  // sembra nuovo — compreso quello della configurazione salvata sul chart, che il pannello continua
  // a mostrare finche' non ricalcola. Incidenti #999 (sessione 63) e #1006 (sessione 64): 553 trade
  // e -14.049,87 registrati due volte a settimane di distanza, da configurazioni DIVERSE.
  // Lo stato che passa da una prova all'altra: il nucleo (misuraProva) lo legge e lo aggiorna.
  const statoProva = {
    prevFp: fpNotoO(null, (await readReportFor(entity_id))?.metrics),
    // Snapshot delle Proprieta' PRIMA della prima variante: a fine giro si rimettono com'erano.
    // Non "0": il chart puo' avere una sua commissione, e cancellarla falserebbe il prossimo backtest.
    snapshotCommissione: null,
  };
  // Cio' che la misura di ogni prova riceve: le dipendenze TradingView gia' risolte, mai `api`.
  const amb = {
    entity_id, info, idsCommissione, stato: statoProva, cron, nota,
    deps: {
      setInputs, readInputValues, readReportFor, readStrategyLoading, readStudyStatus, readCommissionFor,
      setSymbol, setTimeframe, getChartState, setCustomPeriod, readTestPeriod, readPanelMetrics,
      readPeriodReport, ensureTesterPanel, aggiornaReportSeObsoleto, attendiReportAggiornato,
      readDeepState, reportObsoleto, sleep, now,
    },
    opzioni: { recalc_timeout_ms, recalc_stable_checks, recalc_step_ms, recalc_start_grace_ms },
    leggiPadre: (id) => api.getBacktest(id),
  };
  // Fallimenti CONSECUTIVI in finalize: un 422 isolato è un test storto e non deve fermare
  // la matrice, ma se la causa è sistemica (es. initialCapital sempre null perché "Initial
  // Capital" non viene riconosciuto tra gli input) ogni run fallisce allo stesso modo e senza
  // questo contatore il grind macinerebbe l'intera coda a vuoto. Si azzera a ogni successo.
  let consecutiveFinalizeFailures = 0;
  // Run consecutive senza alcun trade: una e' un dato sul periodo, tante di fila sono una
  // configurazione rotta (vedi il ramo zero_trades nel loop).
  let consecutiveZeroTrades = 0;

  // Il report degli input correnti non e' arrivato: TradingView l'ha rifiutato (es. "not_allowed",
  // visto dal vivo il 2026-11-23: da li' in poi ogni richiesta estesa falliva finche' TradingView non
  // e' stato riavviato) oppure la richiesta non e' atterrata in tempo. In nessuno dei due casi c'e'
  // qualcosa da misurare, e qualunque numero resti sul pannello e' di una configurazione precedente.
  // Il grind si ferma perche' le run successive farebbero lo stesso. La run torna in coda UNA volta
  // sola: se la causa e' sua (un periodo che TradingView rifiuta per quel mercato, una richiesta piu'
  // lunga del timeout) rimetterla in coda a ogni giro bloccherebbe la matrice per sempre, quindi al
  // secondo tentativo resta `failed` col motivo vero.
  const fermaReportNonArrivato = async (run, sinc) => {
    const rifiuto = sinc.motivo === 'errore_tradingview';
    const cosa = rifiuto ? `TradingView ha rifiutato il backtest esteso ("${sinc.errore}")` : `il report del backtest esteso non e' arrivato (${sinc.motivo})`;
    let inCoda = false;
    const primoTentativo = (Number(run.attempts) || 0) < 1;
    const motivoRun = `${rifiuto ? 'deep_backtest_error' : 'report_not_synced'}: ${rifiuto ? sinc.errore : sinc.motivo}`;
    try {
      if (primoTentativo && typeof api.reclaimRun === 'function') { await api.reclaimRun(run.id, `${motivoRun} — rimessa in coda`); inCoda = true; }
      else { await api.markFailed(run.id, motivoRun); failed++; }
    } catch { /* la diagnosi vera e' lo stop qui sotto, non l'esito di questa chiamata */ }
    stopped_reason = {
      kind: rifiuto ? 'deep_backtest_error' : 'report_not_synced',
      detail: `${cosa}: non c'e' un report da misurare e nessuna run e' stata registrata con numeri non suoi.`
        + `${inCoda ? ` La run ${run.id} e' tornata in coda.` : ` La run ${run.id} e' segnata fallita con questo motivo.`}`
        + `${rifiuto ? ' Riavvia TradingView e rilancia' : ' Controlla il tester su TradingView e rilancia'}: il grind riparte dalle pending.`,
      run_id: run.id, label: run.label ?? null,
    };
    rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: `${stopped_reason.kind}: ${rifiuto ? sinc.errore : sinc.motivo}${inCoda ? ' (run rimessa in coda)' : ''}`.slice(0, 300) });
    await api.progress(command_id, `⛔ run ${run.id}: ${cosa} — mi fermo`);
  };

  // ⛔ LO STATO D'ERRORE SI CHIEDE, NON SI DEDUCE ⛔
  // Una strategia in errore di runtime non produce report: da fuori e' indistinguibile da una che
  // semplicemente non fa trade. Prima di questa guardia il grind macinava l'intera coda a zero
  // trade e poi concludeva «non e' il periodo, e' la configurazione» — una diagnosi mai verificata,
  // e sbagliata, che mandava a controllare leva e size mentre il problema era lo studio rotto.
  // Sessione 66, 2026-08-24: tre run, controllo compreso, e diciotto minuti.
  // Si guarda UNA volta, prima della run 1: se lo studio e' rotto lo e' per tutta la matrice. E
  // nessuna run va marcata `failed` — non e' colpa loro: restano `pending` per quando si ripara.
  try {
    const stato = await readStudyStatus(entity_id);
    if (stato && stato.ok === false) {
      const err = stato.error || 'errore di runtime';
      stopped_reason = {
        kind: 'study_runtime_error',
        detail: `la strategia ${entity_id} e' in errore di runtime su TradingView: "${err}". Nessuna run eseguita: riparala sul chart (ricaricala, oppure correggi l'input che la rompe) e rilancia — il grind riparte dalle pending.`,
        entity_id, status_type: stato.type,
      };
      await api.progress(command_id, `⛔ strategia in errore di runtime ("${err}") — non eseguo nessuna run`);
    }
  } catch { /* guardia, non oracolo: se lo stato non e' leggibile si prosegue */ }

  // Le Proprieta' della commissione devono tornare com'erano su OGNI uscita dal ciclo, anche per
  // un'eccezione fuori dal try per-run (es. `prossimaRun`): un chart lasciato con una commissione
  // appiccicata falserebbe il prossimo backtest ordinario. Da qui il `finally` intorno al ciclo.
  // Il corpo del ciclo NON e' rientrato apposta: sul percorso ordinario (nessuno snapshot) il
  // finally e' un no-op e il diff resta leggibile.
  let commissionRestored;
  const avvio_ms = Math.round(now() - t0);
  let tChiusura = 0;
  try {
  ciclo: for (;;) {
    if (stopped_reason) break;
    if (max_runs && executed + failed >= max_runs) break;

    cron.apri();
    const run = await prossimaRun();
    if (!run) { cron.scarta(); break; }

    await api.markRunning(run.id);
    cron.assegna(run.id);
    cron.segna('coda');
    await nota(`run ${run.id}${run.label ? ` (${run.label})` : ''}: applico gli input`);

    // Rete di sicurezza: QUALUNQUE eccezione qui dentro deve comunque togliere la run dallo
    // stato `running`. Senza questo catch, un throw dopo markRunning la lasciava appesa per
    // sempre — e siccome `nextRun` serve solo le `pending`, quella run spariva dalla matrice.
    // Successo il 2026-08-11 sulla run 1140: il grind e' uscito per un'eccezione, le 10 run M15
    // non sono mai partite e la sessione risultava chiusa con 10 backtest su 20.
    try {

      // La misura della prova e' in btProva.js (la condivide lo strumento di fase). Qui restano gli
      // esiti: per ogni uscita gli stessi passi di prima, nello stesso ordine.
      const prova = await misuraProva(run, amb);
      switch (prova.uscita) {
        case 'contesto': {
          const a = prova.problema;
          await api.markFailed(run.id, `${a.kind}: ${a.detail}`);
          stopped_reason = { ...a, run_id: run.id, label: run.label ?? null };
          await api.progress(command_id, `⛔ run ${run.id}: ${a.kind} — mi fermo`);
          break ciclo;
        }
        case 'report_prima':
        case 'report_dopo':
          await fermaReportNonArrivato(run, prova.sinc);
          break ciclo;
        case 'costo_non_valido': {
          const { msg, costo } = prova;
          await api.markFailed(run.id, msg);
          failed++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: msg, commission_per_lot: Number(costo.commission_per_lot ?? 0) });
          await api.progress(command_id, `○ run ${run.id}: ${msg} — proseguo`);
          continue ciclo;
        }
        case 'commissione_assente':
          await api.markFailed(run.id, 'commission_ids_not_found: "Commission Type"/"Commission Value" non trovati fra gli input della strategia');
          failed++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: 'commission_ids_not_found' });
          stopped_reason = { kind: 'commission_ids_not_found', detail: 'le Proprieta della commissione non sono nella mappa degli input', run_id: run.id, label: run.label ?? null };
          await api.progress(command_id, `⛔ run ${run.id}: Proprieta commissione non trovate — mi fermo`);
          break ciclo;
        case 'versione_diversa': {
          const { detail, costo } = prova;
          await api.markFailed(run.id, `version_mismatch: ${detail}`);
          failed++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: `version_mismatch: ${detail}`.slice(0, 300), commission_per_lot: Number(costo.commission_per_lot ?? 0) });
          stopped_reason = { kind: 'version_mismatch', detail, run_id: run.id, label: run.label ?? null };
          await api.progress(command_id, `⛔ run ${run.id}: version_mismatch — mi fermo`);
          break ciclo;
        }
        case 'studio_rotto': {
          const rottaOra = prova.errore;
          await api.markFailed(run.id, `study_runtime_error: ${rottaOra}`);
          failed++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: `study_runtime_error: ${rottaOra}`.slice(0, 300) });
          stopped_reason = {
            kind: 'study_runtime_error',
            detail: `la strategia e' andata in errore di runtime su TradingView ("${rottaOra}") mentre la matrice girava: da qui in poi ogni run darebbe zero trade. Riparala sul chart (ricaricala, o togli l'input che la rompe) e rilancia: il grind riparte dalle pending.`,
            run_id: run.id, label: run.label ?? null,
          };
          await api.progress(command_id, `⛔ run ${run.id}: strategia in errore di runtime ("${rottaOra}") — mi fermo`);
          break ciclo;
        }
        case 'zero_trade': {
          // `zero_trades` NON ferma la matrice da solo: una finestra senza trade e' un DATO. Lo stop
          // scatta solo se il sintomo si ripete (il ragionamento completo e' in btProva.js).
          const { anomaly } = prova;
          await api.markFailed(run.id, `${anomaly.kind}: ${anomaly.detail}`);
          failed++;
          consecutiveZeroTrades++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: 'zero_trades', trades: 0 });
          await api.progress(command_id, `○ run ${run.id}: nessun trade nel periodo — proseguo`);

          if (consecutiveZeroTrades >= max_consecutive_failures) {
            stopped_reason = {
              kind: 'zero_trades_systemic',
              detail: `${consecutiveZeroTrades} run consecutive senza alcun trade: non e' il periodo, e' la configurazione (badge errore, leva, size — vedi properties.md)`,
              run_id: run.id, label: run.label ?? null,
            };
            await api.progress(command_id, `⛔ ${consecutiveZeroTrades} run di fila a zero trade — mi fermo`);
            break ciclo;
          }
          continue ciclo;
        }
        case 'anomalia': {
          consecutiveZeroTrades = 0;
          // Circuit breaker: NON si ritenta e NON si va avanti a variare a caso. La run resta
          // failed col motivo reale e il controllo torna al modello, che scala all'utente.
          const { anomaly } = prova;
          await api.markFailed(run.id, `${anomaly.kind}: ${anomaly.detail}`);
          stopped_reason = { ...anomaly, run_id: run.id, label: run.label ?? null };
          await api.progress(command_id, `⛔ run ${run.id}: ${anomaly.kind} — mi fermo`);
          break ciclo;
        }
        case 'costo_non_verificato': {
          consecutiveZeroTrades = 0;
          const { esito, costo } = prova;
          const msg = `${esito.kind}: ${esito.detail}`;
          await api.markFailed(run.id, msg);
          failed++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: msg.slice(0, 300), commission_per_lot: Number(costo.commission_per_lot ?? 0) });
          if (esito.kind === 'control_run_mismatch') {
            // Le run in coda si marcano failed una per una, e ogni passo e' guardato: un getRun o un
            // markFailed che lancia qui non deve mai sostituire la diagnosi vera (control_run_mismatch)
            // con un runtime_error. Si toccano solo le `pending`: le altre non sono di questa batch.
            for (const id of (codaPerId || []).splice(0)) {
              const r = await api.getRun(id).catch(() => null);
              if (r?.status !== 'pending') continue;
              try {
                await api.markFailed(id, `control_run_mismatch: il run di controllo non ha riprodotto il padre (${esito.detail})`);
                failed++;
                rows.push({ run_id: id, label: r.label ?? null, status: 'failed', error: 'control_run_mismatch', commission_per_lot: Number(r.cost_params?.commission_per_lot ?? 0) });
              } catch (e) {
                rows.push({ run_id: id, label: r.label ?? null, status: 'failed', error: `control_run_mismatch (mark failed: ${e.message})` });
              }
            }
            stopped_reason = { kind: esito.kind, detail: esito.detail, run_id: run.id, label: run.label ?? null };
            await api.progress(command_id, `⛔ run ${run.id}: il controllo a commissione 0 non riproduce il padre (${esito.detail}) — batch annullata`);
            break ciclo;
          }
          await api.progress(command_id, `○ run ${run.id}: ${msg} — proseguo`);
          continue ciclo;
        }
        case 'misurata':
          consecutiveZeroTrades = 0;
          break;
        default:
          throw new Error(`misuraProva: uscita sconosciuta "${prova.uscita}"`);
      }
      const { results, metricheFinali, actual, periodo, periodoFinale, rischio, avviso, costo, verificaCosto } = prova;

      const { inputs, properties, initialCapital, appliedInputs } = buildInputsPayload(info, actual);
      const payload = toFinalizePayload(metricheFinali, {
        symbol: run.symbol,
        timeframe: run.timeframe,
        period_start: periodoFinale.from || periodo.from || run.period_start || period_start,
        period_end: periodoFinale.to || periodo.to || run.period_end || period_end,
        initial_capital: initialCapital,
        inputs,
        properties,
        // L'archivio per id e col tipo, accanto al dizionario per nome. Chi congela la
        // configurazione di una madre legge QUESTO: dal nome non si risale ne' al tipo ne'
        // all'id, e ricostruirla per nome e' cio' che ha rotto la sessione 66 (btInputs.js).
        applied_inputs: appliedInputs,
      });
      // Tracciabilita': da dove vengono i numeri, e se il range ottenuto e' quello chiesto.
      payload.extra_metrics = {
        ...(payload.extra_metrics || {}),
        metrics_source: results.source || 'internal_api',
        period_requested: giornoISO(run.period_start) && giornoISO(run.period_end)
          ? `${giornoISO(run.period_start)} → ${giornoISO(run.period_end)}`
          : null,
        period_applied: periodoFinale.label || null,
        ...(rischio?.ok && { risk_metrics_source: 'period_report' }),
        ...(rischio && !rischio.ok && { risk_metrics_unavailable: rischio.reason }),
      };
      if (costo) {
        payload.extra_metrics = {
          ...payload.extra_metrics,
          commission_type: costo.commission_type || 'cash_per_contract',
          commission_per_contract: Number(costo.commission_per_contract) || 0,
          commission_per_lot: Number(costo.commission_per_lot ?? 0),
          contract_size: Number(costo.contract_size) || 1,
          commission_paid: verificaCosto.commission_paid,
          filled_qty_sum: verificaCosto.filled_qty_sum,
          implied_rate: verificaCosto.implied_rate,
        };
      }

      // Lo screenshot si scatta col pannello MASSIMIZZATO e poi si rimette tutto com'era.
      // A pannello normale il tester e' ~370px su 994: la curva equity esce alta un centinaio di
      // pixel, illeggibile. Massimizzato occupa la finestra intera.
      // Il ripristino sta in `finally` perche' un pannello lasciato massimizzato non rovinerebbe
      // solo lo scatto: coprirebbe il chart per tutte le run successive.
      // Nessuno dei due passi puo' far fallire la run — il backtest a questo punto e' gia' misurato
      // e valido; se la massimizzazione non riesce si ottiene lo scatto piccolo di prima.
      let shot = null;
      let modoPrima = null;
      try {
        if (maximize_for_screenshot) {
          try {
            const max = await setPanelMaximized(true);
            if (max?.ok) modoPrima = max.prima ?? null;
          } catch { /* si scatta con il pannello com'e' */ }
        }
        shot = await captureScreenshot({ region: 'strategy_tester' });
      } finally {
        if (modoPrima && modoPrima !== 'maximized') {
          try { await setPanelMaximized(false); } catch { /* il grind non si ferma per il layout */ }
        }
      }
      cron.segna('screenshot');
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
          ...(costo && { commission_per_lot: Number(costo.commission_per_lot ?? 0), net_profit: payload.net_profit }),
        });
        await api.progress(command_id, `✔ run ${run.id}: ${payload.total_trades} trade, PF ${payload.profit_factor}${avviso ? ` — ${avviso}` : ''}`);
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
      cron.segna('salvataggio');

      statoProva.prevFp = fingerprint(results.metrics);
    } catch (err) {
      // Non si sa cosa sia andato storto, ma si sa che la run non deve restare `running`.
      await api.markFailed(run.id, `runtime_error: ${err.message}`);
      failed++;
      rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: String(err.message).slice(0, 300) });
      stopped_reason = {
        kind: 'runtime_error',
        detail: `eccezione durante la run: ${err.message}`,
        run_id: run.id, label: run.label ?? null,
      };
      await api.progress(command_id, `⛔ run ${run.id}: errore imprevisto — ${err.message}`);
      break;
    }
  }
  } finally {
    cron.chiudi();
    tChiusura = now();
    // Ripristino dallo snapshot, e `commission_restored` e' il READBACK — non "il set non ha
    // lanciato": un set accettato e non applicato e' esattamente il difetto da cui nasce tutto.
    if (statoProva.snapshotCommissione) {
      try {
        await setInputs({ entity_id, inputs: statoProva.snapshotCommissione });
        commissionRestored = readbackMatches(statoProva.snapshotCommissione, await readInputValues(entity_id));
      } catch { commissionRestored = false; }
    }
  }

  // Il chart va restituito com'era: se la strategia era nascosta e l'abbiamo accesa noi per
  // farle calcolare il report, la si rimette nascosta. Un fallimento qui non deve invalidare
  // un grind riuscito, quindi non propaga.
  let restored = null;
  if (restoreHidden) {
    try { restored = await setStrategyVisibility(entity_id, false); }
    catch { restored = false; }
  }

  // Lo stato della sessione torna INSIEME al risultato del grind: l'operatore non deve ricordarsi
  // di chiederlo, e quindi non puo' dimenticarsene. E' la differenza fra una regola e un
  // meccanismo — vedi il difetto C1, dove una sessione fu chiusa a 10 run su 20 fidandosi di
  // `executed`, che dice quante ne ha fatte QUESTA chiamata, non quante ne mancano.
  //
  // Non puo' far fallire il grind: a questo punto i backtest sono gia' finalizzati e validi, e
  // perderli per un 500 sull'endpoint sarebbe assurdo.
  let digest = null;
  let digest_error = null;
  if (typeof api.sessionDigest === 'function') {
    try {
      digest = (await api.sessionDigest(session_id))?.data ?? null;
    } catch (err) {
      digest_error = String(err.message).slice(0, 300);
    }
  }

  // Con il digest allegato le metriche delle run riuscite arrivano da `moves`: ripeterle anche nei
  // `rows` significherebbe pagarle due volte. La divisione diventa netta e senza sovrapposizione —
  //   rows   = cosa e' successo alle RUN (ed e' l'unico posto dove vivono i fallimenti: una run
  //            fallita non produce un backtest, quindi in `moves` NON c'e')
  //   digest = lo stato della SESSIONE
  // Lo sfoltimento avviene qui e non nel loop di proposito: prima di aver visto arrivare il digest
  // non si sa se le metriche saranno altrove. Se non arriva, i rows restano completi — il grind non
  // deve mai diventare muto.
  // I tempi si riassumono sulle righe COMPLETE: lo sfoltimento col digest toglie le metriche, non gli esiti.
  const timing = measure_timing ? {
    unita: 'ms', fasi: FASI, avvio_ms,
    chiusura_ms: Math.round(now() - tChiusura), totale_ms: Math.round(now() - t0),
    ...riassumi(cron.records(), rows),
  } : null;

  const righe = digest
    ? rows.map((r) => (r.status === 'done' && r.commission_per_lot == null ? { run_id: r.run_id, label: r.label, status: r.status } : r))
    : rows;

  return {
    success: true, session_id, entity_id, executed, failed, stopped_reason, rows: righe,
    digest, ...(digest_error && { digest_error }),
    ...(timing && { timing }),
    ...(restoreHidden && { visibility_restored: restored }),
    ...(commissionRestored !== undefined && { commission_restored: commissionRestored }),
  };
}
