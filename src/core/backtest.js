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
import { captureScreenshot as realCaptureScreenshot } from './capture.js';
import { setSymbol as realSetSymbol, setTimeframe as realSetTimeframe, getState as realGetState } from './chart.js';
import { setCustomPeriod as realSetCustomPeriod, readTestPeriod as realReadTestPeriod } from './btPeriod.js';
import { readPanelMetrics as realReadPanelMetrics, ensureTesterPanel as realEnsureTesterPanel } from './btPanel.js';
import {
  readInputsInfo as realReadInputsInfo,
  readInputValues as realReadInputValues,
  readReportFor as realReadReportFor,
  readStrategyLoading as realReadStrategyLoading,
  ensureVisibleFor as realEnsureVisibleFor,
  setStrategyVisibility as realSetStrategyVisibility,
  readbackMatches,
} from './btChart.js';
import { buildInputsPayload } from './btInputs.js';
import { toFinalizePayload, fingerprint, detectAnomaly } from './btMetrics.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Attende che il ricalcolo della strategia sia PARTITO e poi FINITO, sincronizzandosi sul
 * segnale autoritativo di TradingView (`isLoading()` della data source) invece di indovinarlo
 * dal movimento dei numeri.
 *
 * Perché non basta guardare le firme. Una versione precedente si fermava al primo cambiamento
 * e una successiva aspettava che i numeri si assestassero; entrambe deducevano lo stato del
 * motore da ciò che pubblicava. È fragile in due direzioni: il report può restare fermo mentre
 * il calcolo è in corso, e può assestarsi su un plateau intermedio.
 *
 * Tempi misurati dal vivo il 2026-08-11 (campionamento a 50 ms nella stessa evaluate del set,
 * quindi senza latenza di round-trip fra i due):
 *
 *   setValue → isLoading=true   616 ms e 670 ms su due ripetizioni
 *   durata isLoading=true      1243 ms e 1088 ms
 *   metriche nuove             pubblicate al ritorno a false
 *
 * NOTA per chi legge il git log: il commit 870cd44 giustificava l'attesa di stabilizzazione con
 * un incidente da "risultato parziale" (208 trade / -1,86% salvati al posto di 288 / +41,57%).
 * Quella diagnosi era SBAGLIATA, verificato il 2026-08-11: 208 trade / -1,86% era il report
 * completo di un'ALTRA strategia del chart, letta al posto della nostra. La causa vera è il
 * difetto che `readReportFor` chiude leggendo per entity_id. La conferma di stabilità qui sotto
 * resta come rete di sicurezza — costa qualche centinaio di ms — ma non è lei a reggere la
 * correttezza.
 *
 * @returns {Promise<{results: Object, recalcObserved: boolean|null}>}
 *          `recalcObserved` è null quando `isLoading()` non è leggibile: in quel caso si degrada
 *          all'euristica sulle firme e NON si accusa un no-op che non si è in grado di vedere.
 */
async function waitForRecalc(entityId, prevFp, {
  readReport, readLoading, sleep,
  timeoutMs = 45000, stepMs = 250, stableChecks = 3, startGraceMs = 5000,
}) {
  const deadline = Date.now() + timeoutMs;
  const graceEnd = Date.now() + Math.min(startGraceMs, timeoutMs);
  let last = await readReport(entityId);
  let recalcObserved = false;

  // Fase 1 — il ricalcolo è partito? Misurato a ~0,6 s dal set, quindi la grazia di default
  // (5 s) è larga otto volte il necessario. Il polling a 250 ms sta comodo dentro la finestra
  // di ~1,1 s in cui isLoading resta true.
  for (;;) {
    const loading = await readLoading(entityId);
    if (loading === null) {
      // isLoading non leggibile (strategia sparita dal chart, o API di TV cambiata): non si può
      // né confermare né negare il ricalcolo. Si torna all'euristica storica.
      return { results: await waitByFingerprint(entityId, prevFp, { readReport, sleep, deadline, stepMs, stableChecks }), recalcObserved: null };
    }
    if (loading === true) { recalcObserved = true; break; }

    // Il ricalcolo può essere iniziato E finito fra due campioni: se le metriche sono già
    // cambiate è avvenuto, e chiamarlo no-op sarebbe un falso allarme.
    last = await readReport(entityId);
    if (last?.success !== false && fingerprint(last?.metrics || {}) !== prevFp) { recalcObserved = true; break; }

    if (Date.now() >= graceEnd) break;
    await sleep(stepMs);
  }

  // Fase 2 — attesa della fine. Se il ricalcolo non è mai partito si salta: non c'è nulla da
  // attendere, e il chiamante lo tratterà come no-op silenzioso.
  while (recalcObserved && Date.now() < deadline) {
    if (await readLoading(entityId) === false) break;
    await sleep(stepMs);
  }

  // Fase 3 — conferma di stabilità: rete di sicurezza, non il meccanismo portante.
  const results = await waitByFingerprint(entityId, null, { readReport, sleep, deadline, stepMs, stableChecks });
  return { results, recalcObserved };
}

/**
 * Legge finché la firma delle metriche resta identica per `stableChecks` letture consecutive.
 * Con `requireChangeFrom` valorizzato pretende anche che sia DIVERSA da quella firma (è la
 * vecchia euristica, usata solo come fallback quando `isLoading()` non è leggibile).
 */
async function waitByFingerprint(entityId, requireChangeFrom, { readReport, sleep, deadline, stepMs, stableChecks }) {
  let last = null;
  let lastFp = null;
  let stable = 0;
  let changed = requireChangeFrom === null;

  for (;;) {
    last = await readReport(entityId);
    // `retryable` = "non ancora pronto" (tipicamente il pannello in ridisegno dopo un cambio di
    // timeframe o periodo). Si continua a leggere finche' c'e' tempo, invece di far fallire la run
    // per un ritardo di rendering — o, peggio, di accontentarsi di una fonte sbagliata.
    if (last && last.success === false && last.retryable && Date.now() < deadline) {
      await sleep(stepMs);
      continue;
    }
    if (!last || last.success === false) return last;

    const fp = fingerprint(last.metrics);
    if (requireChangeFrom !== null && fp !== requireChangeFrom) changed = true;
    stable = fp === lastFp ? stable + 1 : 0;
    lastFp = fp;

    if (changed && stable >= stableChecks) return last;
    if (Date.now() >= deadline) return last;
    await sleep(stepMs);
  }
}

/** "2026-08-08T00:00:00.000000Z" o "2026-08-08" -> "2026-08-08". null se non riconoscibile. */
export function giornoISO(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
  return m ? m[1] : null;
}

/** Due ticker coincidono anche se uno e' senza exchange ("TVC:NDQ" vs "NDQ"). */
function stessoSymbol(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).toUpperCase().split(':').pop();
  return String(a).toUpperCase() === String(b).toUpperCase() || norm(a) === norm(b);
}

/**
 * Porta il chart nello stato che la run dichiara — symbol, timeframe, periodo di test — e
 * VERIFICA che ci sia arrivato davvero.
 *
 * E' la funzione che mancava del tutto fino al 2026-08-11: bt_grind applicava solo gli input e
 * scriveva symbol/timeframe/periodo nel payload come se li avesse imposti. Dieci run con dieci
 * periodi diversi hanno prodotto dieci copie dello stesso backtest, ognuna con un'etichetta falsa.
 *
 * Ogni asse che non si verifica torna come problema: il chiamante NON finalizza. Meglio una run
 * fallita con un motivo vero che un backtest plausibile e sbagliato.
 */
async function applicaContestoRun(run, ctx) {
  const { getChartState, setSymbol, setTimeframe, setCustomPeriod, readTestPeriod, ensureTesterPanel, sleep } = ctx;
  const problemi = [];
  let contestoRicaricato = false;

  const stato = await getChartState();

  if (run.symbol && !stessoSymbol(stato?.symbol, run.symbol)) {
    await setSymbol({ symbol: run.symbol });
    await sleep(500);
    const dopo = await getChartState();
    if (!stessoSymbol(dopo?.symbol, run.symbol)) {
      problemi.push({ kind: 'symbol_not_applied', detail: `chiesto ${run.symbol}, il chart e' su ${dopo?.symbol ?? '?'}` });
    }
    contestoRicaricato = true;
  }

  if (run.timeframe && String(stato?.resolution) !== String(run.timeframe)) {
    await setTimeframe({ timeframe: String(run.timeframe) });
    await sleep(500);
    const dopo = await getChartState();
    if (String(dopo?.resolution) !== String(run.timeframe)) {
      problemi.push({ kind: 'timeframe_not_applied', detail: `chiesto ${run.timeframe}, il chart e' su ${dopo?.resolution ?? '?'}` });
    }
    contestoRicaricato = true;
  }

  // Cambiare symbol o timeframe RICHIUDE il pannello Strategy Tester: il blocco "Statistiche
  // chiave" sparisce dal DOM e le run con periodo, che leggono solo da li', si fermano tutte.
  // Misurato dal vivo il 2026-08-11: nove run M5 filate lisce, poi il passaggio a M15 e stop.
  // Aprirlo una volta a inizio grind non basta: va riaperto dopo ogni ricarica del contesto.
  if (contestoRicaricato && ensureTesterPanel) {
    await sleep(400);
    const p = await ensureTesterPanel();
    if (!p.ok) {
      problemi.push({ kind: 'panel_not_open', detail: p.error || 'pannello Strategy Tester non pronto dopo il cambio di contesto' });
    }
  }

  // Il periodo si rilegge SEMPRE, anche quando non lo cambiamo: e' quello che finira' nel payload,
  // e deve essere il range vero, non quello che la run sperava (regola di api.md).
  let periodo = await readTestPeriod();
  const from = giornoISO(run.period_start);
  const to = giornoISO(run.period_end);
  if (from && to && (periodo.from !== from || periodo.to !== to)) {
    const res = await setCustomPeriod(from, to);
    periodo = { label: res.label, from: res.from, to: res.to };
    if (!res.applied) {
      problemi.push({
        kind: 'period_not_applied',
        detail: res.error || `chiesto ${from} → ${to}, TradingView ha applicato ${res.from ?? '?'} → ${res.to ?? '?'}`,
      });
    }
  }

  return { problemi, periodo };
}

/**
 * Le metriche EFFETTIVE, scegliendo la fonte giusta invece di fidarsi di una sola.
 *
 * `reportData()` (readReportFor) e' cieco al periodo di test: con un periodo ristretto continua a
 * rispondere sull'intero storico caricato. Il pannello invece mostra il periodo selezionato.
 * Misurato nello stesso istante: pannello 24 trade / -5,71%, API interna 288 trade / +28,31%.
 *
 * Invece di tenere uno stato "c'e' un filtro attivo?" — che si sfasa al primo imprevisto — si
 * leggono entrambe e si confrontano: se il numero di trade coincide non c'e' filtro e si usa
 * l'API, che porta 19 metriche fra cui Sharpe e Sortino; se differisce il filtro c'e', e si usa il
 * pannello. Il confronto vale anche da controllo di coerenza.
 */
async function leggiMetricheEffettive(entityId, { readReportFor, readPanelMetrics, periodoRistretto = false }) {
  // Con un periodo di test ristretto il pannello e' l'UNICA fonte valida: l'API interna risponde
  // sull'intero storico. Se il pannello non e' leggibile si segnala "riprova", non si ripiega --
  // un fallback verso una sorgente che si SA sbagliata per questa configurazione produce numeri
  // plausibili e falsi, che e' il difetto che questo file esiste per non ripetere.
  // Successo dal vivo il 2026-08-11: la prima run dopo un cambio di timeframe trovava il pannello
  // ancora in ridisegno e registrava i 288 trade dello storico intero al posto dei 3 del periodo.
  if (periodoRistretto) {
    let p = null;
    try { p = await readPanelMetrics(); } catch { p = null; }
    if (p?.success) return { ...p, source: 'panel' };
    return {
      success: false, retryable: p?.retryable !== false, metrics: {}, source: 'panel',
      error: p?.error || 'periodo ristretto ma pannello illeggibile: non ripiego sull API interna, che ignora il periodo',
    };
  }

  const api = await readReportFor(entityId);
  let panel = null;
  try { panel = await readPanelMetrics(); } catch { panel = null; }

  if (!panel?.success) return { ...api, source: 'internal_api', panel_available: false };
  if (api?.success === false) return { ...panel, source: 'panel' };

  const tApi = Math.round(api?.metrics?.total_trades ?? -1);
  const tPanel = Math.round(panel?.metrics?.total_trades ?? -2);
  if (tApi === tPanel) return { ...api, source: 'internal_api' };

  return { ...panel, source: 'panel', internal_api_trades: tApi };
}

export async function grindSession(opts, deps = {}) {
  const {
    session_id, entity_id, command_id = null, max_runs = 0,
    // 45s: un ricalcolo su un anno di dati intraday impiega diversi secondi, e a questi va
    // sommato il tempo di stabilizzazione. Meglio abbondare: il costo di aspettare troppo e'
    // qualche secondo per run, quello di aspettare troppo poco e' un backtest falso.
    period_start = null, period_end = null, recalc_timeout_ms = 45000, recalc_stable_checks = 3,
    recalc_step_ms = 250, recalc_start_grace_ms = 5000,
    max_consecutive_failures = 3,
  } = opts;

  const {
    api,
    setInputs = realSetInputs,
    captureScreenshot = realCaptureScreenshot,
    readInputsInfo = realReadInputsInfo,
    readInputValues = realReadInputValues,
    readReportFor = realReadReportFor,
    readStrategyLoading = realReadStrategyLoading,
    ensureVisibleFor = realEnsureVisibleFor,
    setStrategyVisibility = realSetStrategyVisibility,
    setSymbol = realSetSymbol,
    setTimeframe = realSetTimeframe,
    getChartState = realGetState,
    setCustomPeriod = realSetCustomPeriod,
    readTestPeriod = realReadTestPeriod,
    readPanelMetrics = realReadPanelMetrics,
    ensureTesterPanel = realEnsureTesterPanel,
    sleep = realSleep,
  } = deps;

  // Il lettore di metriche che sceglie la fonte da solo (API interna vs pannello): lo usano sia
  // l'attesa del ricalcolo sia il payload, cosi' non possono divergere.
  const leggiMetriche = (id, periodoRistretto) => leggiMetricheEffettive(id, { readReportFor, readPanelMetrics, periodoRistretto });
  const ctxRun = { getChartState, setSymbol, setTimeframe, setCustomPeriod, readTestPeriod, ensureTesterPanel, sleep };

  if (!session_id) throw new Error('session_id è obbligatorio');
  if (!entity_id) throw new Error('entity_id è obbligatorio (prendilo da chart_get_state)');

  // La mappa id→nome→tipo si legge UNA volta: non cambia tra le run della stessa strategia.
  const info = await readInputsInfo(entity_id);
  if (!info.length) throw new Error(`nessun input leggibile per entity_id=${entity_id}: la strategia è sul chart?`);

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

  const rows = [];
  let executed = 0;
  let failed = 0;
  let stopped_reason = null;
  let prevFp = fingerprint((await readReportFor(entity_id))?.metrics || {});
  // Fallimenti CONSECUTIVI in finalize: un 422 isolato è un test storto e non deve fermare
  // la matrice, ma se la causa è sistemica (es. initialCapital sempre null perché "Initial
  // Capital" non viene riconosciuto tra gli input) ogni run fallisce allo stesso modo e senza
  // questo contatore il grind macinerebbe l'intera coda a vuoto. Si azzera a ogni successo.
  let consecutiveFinalizeFailures = 0;
  // Run consecutive senza alcun trade: una e' un dato sul periodo, tante di fila sono una
  // configurazione rotta (vedi il ramo zero_trades nel loop).
  let consecutiveZeroTrades = 0;

  for (;;) {
    if (max_runs && executed + failed >= max_runs) break;

    const run = await api.nextRun(session_id);
    if (!run) break;

    await api.markRunning(run.id);
    await api.progress(command_id, `run ${run.id}${run.label ? ` (${run.label})` : ''}: applico gli input`);

    // PRIMA il contesto (symbol, timeframe, periodo), POI gli input: cambiare symbol o timeframe
    // ricarica la serie e farebbe ripartire il calcolo dopo il set, falsando l'attesa.
    const { problemi, periodo } = await applicaContestoRun(run, ctxRun);
    if (problemi.length) {
      const a = problemi[0];
      await api.markFailed(run.id, `${a.kind}: ${a.detail}`);
      stopped_reason = { ...a, run_id: run.id, label: run.label ?? null };
      await api.progress(command_id, `⛔ run ${run.id}: ${a.kind} — mi fermo`);
      break;
    }

    const requested = run.input_set || {};
    let setResult = { updated_inputs: {}, missing: [] };
    if (Object.keys(requested).length) {
      setResult = await setInputs({ entity_id, inputs: requested });
    }

    // Se la run dichiara un periodo, il pannello e' l'unica fonte ammessa (l'API interna lo ignora).
    const periodoRistretto = !!(giornoISO(run.period_start) && giornoISO(run.period_end));
    const { results, recalcObserved } = await waitForRecalc(entity_id, prevFp, {
      readReport: (id) => leggiMetriche(id, periodoRistretto), readLoading: readStrategyLoading, sleep,
      timeoutMs: recalc_timeout_ms, stableChecks: recalc_stable_checks,
      stepMs: recalc_step_ms, startGraceMs: recalc_start_grace_ms,
    });
    const sameAsPrevious = !!results?.metrics && fingerprint(results.metrics) === prevFp;

    const actual = await readInputValues(entity_id);
    const readbackOk = readbackMatches(requested, actual);

    // "il motore non ha ricalcolato" è un'accusa sensata solo se qualcosa È stato chiesto:
    // una run con input_set vuoto gira sugli input correnti, e non ricalcolare è il
    // comportamento giusto, non un no-op silenzioso.
    const anomaly = detectAnomaly({
      setResult, results, readbackOk, sameAsPrevious,
      recalcObserved: Object.keys(requested).length ? recalcObserved : null,
    });

    // `zero_trades` NON ferma piu' la matrice da solo. Su un asse periodo una finestra corta senza
    // trade e' un DATO, non un guasto: verificato il 2026-08-11, la strategia su M15 a 7 giorni
    // fa davvero zero trade, e fermarsi li' buttava via le altre diciannove run. La protezione
    // originale — "0 trade = di solito leva/size/errore di runtime" — resta, ma scatta solo se il
    // sintomo si ripete: se sono TUTTE a zero il problema e' di configurazione, non di periodo.
    if (anomaly?.kind === 'zero_trades') {
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
        break;
      }
      prevFp = fingerprint(results.metrics);
      continue;
    }
    consecutiveZeroTrades = 0;

    if (anomaly) {
      // Circuit breaker: NON si ritenta e NON si va avanti a variare a caso. La run resta
      // failed col motivo reale e il controllo torna al modello, che scala all'utente.
      await api.markFailed(run.id, `${anomaly.kind}: ${anomaly.detail}`);
      stopped_reason = { ...anomaly, run_id: run.id, label: run.label ?? null };
      await api.progress(command_id, `⛔ run ${run.id}: ${anomaly.kind} — mi fermo`);
      break;
    }

    // Il periodo si rilegge dal tester DOPO il ricalcolo, e si registra QUELLO. Mai quello
    // richiesto: api.md lo dice da sempre ("popola SEMPRE col range REALE"), e scriverlo a fiducia
    // e' esattamente ciò che ha prodotto dieci backtest identici con dieci etichette diverse.
    const periodoFinale = await readTestPeriod();
    const { inputs, properties, initialCapital } = buildInputsPayload(info, actual);
    const payload = toFinalizePayload(results.metrics, {
      symbol: run.symbol,
      timeframe: run.timeframe,
      period_start: periodoFinale.from || periodo.from || run.period_start || period_start,
      period_end: periodoFinale.to || periodo.to || run.period_end || period_end,
      initial_capital: initialCapital,
      inputs,
      properties,
    });
    // Tracciabilita': da dove vengono i numeri, e se il range ottenuto e' quello chiesto.
    payload.extra_metrics = {
      ...(payload.extra_metrics || {}),
      metrics_source: results.source || 'internal_api',
      period_requested: giornoISO(run.period_start) && giornoISO(run.period_end)
        ? `${giornoISO(run.period_start)} → ${giornoISO(run.period_end)}`
        : null,
      period_applied: periodoFinale.label || null,
    };

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

  // Il chart va restituito com'era: se la strategia era nascosta e l'abbiamo accesa noi per
  // farle calcolare il report, la si rimette nascosta. Un fallimento qui non deve invalidare
  // un grind riuscito, quindi non propaga.
  let restored = null;
  if (restoreHidden) {
    try { restored = await setStrategyVisibility(entity_id, false); }
    catch { restored = false; }
  }

  return { success: true, session_id, executed, failed, stopped_reason, rows, ...(restoreHidden && { visibility_restored: restored }) };
}
