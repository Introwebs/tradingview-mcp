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
import {
  readPanelMetrics as realReadPanelMetrics, ensureTesterPanel as realEnsureTesterPanel,
  aggiornaReportSeObsoleto as realAggiornaReport,
  attendiReportAggiornato as realAttendiReport,
  setPanelMaximized as realSetPanelMaximized,
} from './btPanel.js';
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
import { resolveCommissionIds, checkImpliedRate, checkControlRun, resolveStrategyEntity } from './btCost.js';
import { toFinalizePayload, fingerprint, detectAnomaly } from './btMetrics.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Firma delle metriche solo se ci SONO metriche, altrimenti il fallback ricevuto.
 * Un report senza metriche non e' una baseline: e' l'ASSENZA di una baseline, e le due cose vanno
 * tenute distinguibili (vedi il commento su `prevFp` in grindSession).
 */
function fpNotoO(fallback, metrics) {
  return metrics && Object.keys(metrics).length ? fingerprint(metrics) : fallback;
}

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
export async function waitForRecalc(entityId, prevFp, {
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
export async function applicaContestoRun(run, ctx) {
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
    // Anche il PERIODO e' un cambio di contesto: una finestra diversa non puo' produrre le stesse
    // identiche metriche. Senza questa riga, su una matrice che varia solo il periodo — cioe' il
    // caso classico — il controllo `stale_metrics` non sarebbe mai scattato.
    if (res.applied) contestoRicaricato = true;
    if (!res.applied) {
      problemi.push({
        kind: 'period_not_applied',
        detail: res.error || `chiesto ${from} → ${to}, TradingView ha applicato ${res.from ?? '?'} → ${res.to ?? '?'}`,
      });
    }
  }

  return { problemi, periodo, contestoCambiato: contestoRicaricato };
}

/**
 * Il pannello e' ASINCRONO rispetto al ricalcolo: `isLoading()` torna false quando il motore ha
 * finito, ma il DOM puo' mostrare ancora i numeri della run PRECEDENTE. Letto in quell'istante, si
 * registra un backtest con gli input della run corrente e le metriche di quella prima.
 *
 * Misurato il 2026-08-11 sulla sessione 43: 15 backtest M5 su 19 con metriche identiche al bit
 * (667 trade, +15,26%, PF 1,045) pur avendo `input_set` diversi e readback corretto. La prova che
 * non fosse un caso: lo stesso identico risultato (246 trade, -8,50%, PF 0,920) compariva su TUTTI
 * i 9 backtest M15 **e su uno M5** — e cambiare timeframe non puo' lasciare i numeri invariati.
 *
 * Qui si rilegge finche' la firma cambia. Se non cambia, chi chiama decide: e' `stale_metrics`.
 */
// 15 x 1,5 s = 22 s di margine. Il ricalcolo del report, una volta innescato con "Aggiorna report",
// ha impiegato 10,6 s su un anno di M5 con 200 trade (misurato). I 4,8 s della prima stesura erano
// una scommessa, non una misura.
async function rileggiFinoACambio(entityId, prevFp, {
  leggiMetriche, periodoRistretto, sleep, aggiornaReport = null, tentativi = 15, attesaMs = 1500,
}) {
  let ultimo = null;
  for (let i = 0; i < tentativi; i++) {
    // Il banner "Il report e' obsoleto" va ricercato a OGNI giro, non una volta sola dopo il set.
    // Misurato il 2026-08-11: compare ~226 ms dopo il cambio di input e resta finche' non lo si
    // preme, ma puo' arrivare dopo la finestra in cui lo cerchiamo, o il click puo' non atterrare
    // se il pannello si sta ridisegnando. In quel caso la run moriva di `stale_metrics` con RR
    // gia' applicato e il pannello fermo sul risultato precedente — cioe' esattamente il difetto
    // che questo controllo dovrebbe impedire, riprodotto dal rimedio stesso.
    if (aggiornaReport) {
      try { await aggiornaReport(); } catch { /* si riprova al giro dopo */ }
    }
    await sleep(attesaMs);
    ultimo = await leggiMetriche(entityId, periodoRistretto);
    if (ultimo?.success !== false && fingerprint(ultimo?.metrics || {}) !== prevFp) {
      return { results: ultimo, cambiato: true, tentativi: i + 1 };
    }
  }
  return { results: ultimo, cambiato: false, tentativi };
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
export async function leggiMetricheEffettive(entityId, { readReportFor, readPanelMetrics, periodoRistretto = false }) {
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
    ensureTesterPanel = realEnsureTesterPanel,
    aggiornaReportSeObsoleto = realAggiornaReport,
    attendiReportAggiornato = realAttendiReport,
    setPanelMaximized = realSetPanelMaximized,
    sleep = realSleep,
  } = deps;

  // Il dettaglio passo-passo passa da qui: si vede solo con `verbose`. Gli eventi (✔ ⛔ ○) chiamano
  // `api.progress` direttamente, cosi' non c'e' modo di silenziarli per sbaglio.
  const nota = async (msg) => { if (verbose) await api.progress(command_id, msg); };

  // Il lettore di metriche che sceglie la fonte da solo (API interna vs pannello): lo usano sia
  // l'attesa del ricalcolo sia il payload, cosi' non possono divergere.
  const leggiMetriche = (id, periodoRistretto) => leggiMetricheEffettive(id, { readReportFor, readPanelMetrics, periodoRistretto });
  const ctxRun = { getChartState, setSymbol, setTimeframe, setCustomPeriod, readTestPeriod, ensureTesterPanel, sleep };

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
  // Snapshot delle Proprieta' PRIMA della prima variante: a fine giro si rimettono com'erano.
  // Non "0": il chart puo' avere una sua commissione, e cancellarla falserebbe il prossimo backtest.
  let snapshotCommissione = null;

  // Con `run_ids` le run si leggono per id nell'ordine dato; senza, dalla coda `?next=1` come sempre.
  const codaPerId = Array.isArray(run_ids) ? [...run_ids] : null;
  const prossimaRun = async () => {
    if (!codaPerId) return api.nextRun(session_id);
    while (codaPerId.length) {
      const id = codaPerId.shift();
      const r = await api.getRun(id);
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
  let prevFp = fpNotoO(null, (await readReportFor(entity_id))?.metrics);
  // Fallimenti CONSECUTIVI in finalize: un 422 isolato è un test storto e non deve fermare
  // la matrice, ma se la causa è sistemica (es. initialCapital sempre null perché "Initial
  // Capital" non viene riconosciuto tra gli input) ogni run fallisce allo stesso modo e senza
  // questo contatore il grind macinerebbe l'intera coda a vuoto. Si azzera a ogni successo.
  let consecutiveFinalizeFailures = 0;
  // Run consecutive senza alcun trade: una e' un dato sul periodo, tante di fila sono una
  // configurazione rotta (vedi il ramo zero_trades nel loop).
  let consecutiveZeroTrades = 0;

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

  for (;;) {
    if (stopped_reason) break;
    if (max_runs && executed + failed >= max_runs) break;

    const run = await prossimaRun();
    if (!run) break;

    await api.markRunning(run.id);
    await nota(`run ${run.id}${run.label ? ` (${run.label})` : ''}: applico gli input`);

    // Rete di sicurezza: QUALUNQUE eccezione qui dentro deve comunque togliere la run dallo
    // stato `running`. Senza questo catch, un throw dopo markRunning la lasciava appesa per
    // sempre — e siccome `nextRun` serve solo le `pending`, quella run spariva dalla matrice.
    // Successo il 2026-08-11 sulla run 1140: il grind e' uscito per un'eccezione, le 10 run M15
    // non sono mai partite e la sessione risultava chiusa con 10 backtest su 20.
    try {

      // Se la run dichiara un periodo, il pannello e' l'unica fonte ammessa (l'API interna lo ignora).
      const periodoRistretto = !!(giornoISO(run.period_start) && giornoISO(run.period_end));

      // Fotografia PRIMA di toccare il contesto, e SOLO per le run che non cambiano input.
      //
      // Perche' solo quelle: se la run cambia anche gli input, il confronto baseline(post-contesto)
      // vs risultato(post-input) copre gia' tutto — se il pannello e' rimasto indietro la baseline
      // e' il valore vecchio e il confronto successivo se ne accorge. Aggiungere qui un secondo
      // vincolo ("il contesto DEVE aver mosso i numeri") non aggiungerebbe protezione e potrebbe
      // fermare la matrice per niente.
      // Le run a `input_set` vuoto invece non hanno un secondo confronto: se il cambio di periodo o
      // di timeframe non muove nulla, senza questa fotografia si registrerebbe il report del
      // contesto precedente sotto l'etichetta di quello nuovo.
      const soloContesto = Object.keys(run.input_set || {}).length === 0;
      let preContestoFp = null;
      if (soloContesto) {
        try {
          const p = await leggiMetriche(entity_id, periodoRistretto);
          if (p?.success !== false && Object.keys(p?.metrics || {}).length) preContestoFp = fingerprint(p.metrics);
        } catch { /* senza riferimento il controllo sul contesto si salta */ }
      }

      // PRIMA il contesto (symbol, timeframe, periodo), POI gli input: cambiare symbol o timeframe
      // ricarica la serie e farebbe ripartire il calcolo dopo il set, falsando l'attesa.
      const { problemi, periodo, contestoCambiato } = await applicaContestoRun(run, ctxRun);
      if (problemi.length) {
        const a = problemi[0];
        await api.markFailed(run.id, `${a.kind}: ${a.detail}`);
        stopped_reason = { ...a, run_id: run.id, label: run.label ?? null };
        await api.progress(command_id, `⛔ run ${run.id}: ${a.kind} — mi fermo`);
        break;
      }

      // BASELINE — va presa QUI: contesto gia' applicato, input ANCORA da applicare.
      //
      // Prima veniva letta all'inizio della run, cioe' PRIMA del cambio di symbol/timeframe. Su una
      // transizione M5→M15 la baseline era quindi un valore M5, e il pannello — che dopo il cambio
      // mostrava ancora il risultato M15 della run PRECEDENTE — risultava "diverso dalla baseline"
      // e passava il controllo. Successo il 2026-08-11: il backtest #638 ("Solo Long", short
      // disattivato) ha registrato i 169 trade di #637 ("Solo Conferma", short attivo).
      //
      // Perche' serve stabilizzare prima di leggerla: il cambio di contesto manda il report in
      // "obsoleto" a sua volta. Se la baseline si prendesse a report obsoleto sarebbe di nuovo un
      // valore vecchio, e il confronto successivo non direbbe niente. Quindi: si aggiorna il report,
      // si aspetta che i numeri si assestino, e SOLO ALLORA si fotografa lo stato "contesto nuovo,
      // input vecchi". Da li' in poi qualunque immobilita' e' colpa degli input non applicati.
      if (contestoCambiato) {
        const rinfresco = await aggiornaReportSeObsoleto();
        if (rinfresco.cliccato) {
          await nota(`run ${run.id}: contesto cambiato, report aggiornato prima della baseline`);
        }
      }
      let baselineFp = prevFp;
      try {
        const prima = await waitByFingerprint(entity_id, null, {
          readReport: (id) => leggiMetriche(id, periodoRistretto), sleep,
          deadline: Date.now() + Math.min(recalc_timeout_ms, 30000),
          stepMs: recalc_step_ms, stableChecks: recalc_stable_checks,
        });
        baselineFp = fpNotoO(baselineFp, prima?.success !== false ? prima?.metrics : null);
      } catch { /* si tiene prevFp */ }

      // Il pannello puo' essere STABILE e VUOTO insieme: `waitByFingerprint` non lo distingue,
      // perche' una firma di soli null e' immediatamente stabile e quindi "assestata". Qui si
      // aspetta che le metriche compaiano davvero — senza una baseline non esiste il confronto su
      // cui poggia tutto il rilevamento dello stale.
      if (baselineFp === null) {
        const scadenza = Date.now() + Math.min(recalc_timeout_ms, 30000);
        while (baselineFp === null && Date.now() < scadenza) {
          const r = await leggiMetriche(entity_id, periodoRistretto);
          baselineFp = fpNotoO(null, r?.success !== false ? r?.metrics : null);
          if (baselineFp === null) await sleep(recalc_step_ms);
        }
        if (baselineFp !== null) {
          await nota(`run ${run.id}: pannello ancora senza metriche, baseline presa dopo l'attesa`);
        }
      }

      // Il contesto e' cambiato ma i numeri sono gli stessi di prima del cambio: impossibile.
      // Un altro symbol, un altro timeframe o un'altra finestra temporale non possono produrre lo
      // stesso identico report. Se succede, il pannello non si e' aggiornato e proseguire
      // significherebbe etichettare col contesto nuovo dei numeri che appartengono a quello vecchio.
      const staleContesto = !!(contestoCambiato && preContestoFp !== null && baselineFp === preContestoFp);

      const requested = run.input_set || {};

      // Variante di costo: le due Proprieta' della commissione entrano nel set INSIEME agli input
      // di logica, per id esatto. `commission_per_contract` arriva gia' convertito dal server.
      const costo = run.cost_params && run.parent_backtest_id ? run.cost_params : null;
      let inputsCosto = {};
      if (costo) {
        if (!idsCommissione) {
          await api.markFailed(run.id, 'commission_ids_not_found: "Commission Type"/"Commission Value" non trovati fra gli input della strategia');
          failed++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: 'commission_ids_not_found' });
          stopped_reason = { kind: 'commission_ids_not_found', detail: 'le Proprieta della commissione non sono nella mappa degli input', run_id: run.id, label: run.label ?? null };
          await api.progress(command_id, `⛔ run ${run.id}: Proprieta commissione non trovate — mi fermo`);
          break;
        }
        if (snapshotCommissione === null) {
          const v = await readInputValues(entity_id);
          snapshotCommissione = { [idsCommissione.typeId]: v[idsCommissione.typeId], [idsCommissione.valueId]: v[idsCommissione.valueId] };
        }
        inputsCosto = {
          [idsCommissione.typeId]: costo.commission_type || 'cash_per_contract',
          [idsCommissione.valueId]: Number(costo.commission_per_contract) || 0,
        };
      }
      const richiesti = { ...requested, ...inputsCosto };

      // Gli input erano GIA' quelli richiesti? Succede regolarmente: la prima run di una matrice e'
      // quasi sempre la configurazione di default, cioe' quella gia' sul chart. In quel caso non
      // c'e' nessun ricalcolo da attendere e le metriche restano — legittimamente — identiche alla
      // baseline. Senza questa distinzione la run 1 di ogni sessione moriva di `silent_noop`.
      let deltaReale = Object.keys(richiesti).length > 0;
      if (deltaReale) {
        try {
          const valoriPrima = await readInputValues(entity_id);
          if (readbackMatches(richiesti, valoriPrima)) deltaReale = false;
        } catch { /* in dubbio si assume che un cambiamento ci sia */ }
      }

      let setResult = { updated_inputs: {}, missing: [] };
      if (Object.keys(richiesti).length) {
        setResult = await setInputs({ entity_id, inputs: richiesti });
      }

      // ⛔ IL PASSO SENZA IL QUALE NIENTE FUNZIONA ⛔
      // Con un periodo di test personalizzato TradingView NON ricalcola il report da solo: lo marca
      // obsoleto e aspetta il pulsante "Aggiorna report". Senza questa chiamata il pannello resta sui
      // numeri della configurazione precedente e ogni backtest della matrice esce identico al primo.
      // Vedi il commento in btPanel.js: RR 2->6 e trenta secondi di attesa non muovono nulla, il
      // click porta i numeri nuovi in 10,6 s.
      // Si aspetta che TradingView dichiari il report ATTUALE, non che i numeri si muovano.
      // Due input_set diversi possono dare lo stesso identico report (misurato: RR target 1.5/2/3
      // -> sempre 651 trade, perche' agisce solo in mgmt mode "Classic"), quindi "numeri fermi" non
      // e' una prova di niente. Banner sparito = report attuale per QUESTI input.
      const report = await attendiReportAggiornato({ timeoutMs: Math.max(recalc_timeout_ms, 30000) });
      if (report.click > 0) {
        await nota(`run ${run.id}: report obsoleto → premuto "Aggiorna report"${report.click > 1 ? ` (${report.click}x)` : ''}`);
      }

      const { results: results0, recalcObserved } = await waitForRecalc(entity_id, baselineFp, {
        readReport: (id) => leggiMetriche(id, periodoRistretto), readLoading: readStrategyLoading, sleep,
        timeoutMs: recalc_timeout_ms, stableChecks: recalc_stable_checks,
        stepMs: recalc_step_ms, startGraceMs: recalc_start_grace_ms,
      });
      let results = results0;
      let sameAsPrevious = !!results?.metrics && fingerprint(results.metrics) === baselineFp;

      // Metriche identiche alla run precedente DOPO aver chiesto un cambiamento: quasi sempre e' il
      // pannello che non si e' ancora ridisegnato. Si rilegge invece di scrivere. Se il contesto e'
      // cambiato (symbol o timeframe) l'identita' e' addirittura impossibile, non solo sospetta.
      // Solo gli INPUT: il cambio di contesto e' gia' assorbito nella baseline, che viene
      // fotografata dopo averlo applicato. Tenerlo qui dentro renderebbe `stale_metrics` inevitabile
      // per ogni run con `input_set` vuoto — quella run misura legittimamente lo stato post-contesto,
      // che e' esattamente la baseline.
      const cambiamentoChiesto = deltaReale;
      let staleConfermato = false;
      // Un quasi-incidente recuperato: non merita una riga sua, ma non va perso. Finisce in coda
      // alla riga della run conclusa, dove chi legge lo vede accanto al risultato che spiega.
      let avviso = null;
      // ⛔ IL BANNER E IL RIDISEGNO DEL PANNELLO NON SONO LA STESSA COSA ⛔
      //
      // Qui c'era `&& !report.aggiornato`: se TradingView dichiarava il report attuale, l'identita'
      // con la run precedente veniva accettata come legittima (regola C4) e non si rileggeva.
      // Sessione 54 (2026-08-12): 8 coppie CONSECUTIVE di backtest con input diversi e metriche
      // identiche al bit — #812 (Impulse Cont Bullish+Bearish) e #813 (Morning Star Soft), pattern
      // completamente diversi, stesso 334 trade / +8,57%. Tutte a 7,0 s contro una mediana di 8,0.
      //
      // La meccanica: `isLoading()` non vede il ricalcolo innescato dal pulsante, quindi
      // `waitForRecalc` esaurisce la grace di avvio (5 s) e torna con le metriche ANCORA vecchie;
      // il banner intanto e' gia' sparito, perche' sparisce quando il calcolo finisce, non quando
      // il DOM si ridipinge. In quella finestra si registravano i numeri della run precedente.
      //
      // C4 resta valida — due input diversi POSSONO dare lo stesso risultato — ma la domanda giusta
      // non e' "cosa dice il banner": e' "rileggendo, i numeri si muovono?". Se si muovono era
      // stale; se non si muovono nemmeno insistendo, l'identita' e' vera.
      if (sameAsPrevious && cambiamentoChiesto) {
        // Budget diverso a seconda di chi dice cosa. Banner ancora su = il ricalcolo non e' partito,
        // vale la pena insistere a lungo. Banner sparito = e' una CORSA col ridisegno, e una corsa
        // si risolve in un paio di secondi o non era una corsa: insistere di piu' rallenterebbe
        // soltanto le run legittimamente identiche.
        const corsaColRidisegno = report.aggiornato;
        const ri = await rileggiFinoACambio(entity_id, baselineFp, {
          leggiMetriche, periodoRistretto, sleep, aggiornaReport: aggiornaReportSeObsoleto,
          ...(corsaColRidisegno ? { tentativi: 4, attesaMs: 1000 } : {}),
        });
        if (ri.cambiato) {
          results = ri.results;
          sameAsPrevious = false;
          avviso = `pannello in ritardo, metriche rilette al tentativo ${ri.tentativi}`;
        } else if (!report.aggiornato) {
          // Numeri fermi E banner ancora su: non e' un'identita' legittima, e' un report mai
          // ricalcolato.
          staleConfermato = true;
        }
        // Numeri fermi ma banner sparito, anche dopo aver riletto: identita' LEGITTIMA (C4).
        // Si accetta — il costo di un falso allarme e' una matrice interrotta.
      }
      // I due controlli confluiscono: contesto fermo O input fermi, in entrambi i casi si scrive
      // qualcosa che non appartiene a questa run.
      if (staleContesto && !report.aggiornato) staleConfermato = true;

      const actual = await readInputValues(entity_id);
      const readbackOk = readbackMatches(richiesti, actual);

      // "il motore non ha ricalcolato" è un'accusa sensata solo se qualcosa È stato chiesto:
      // una run con input_set vuoto gira sugli input correnti, e non ricalcolare è il
      // comportamento giusto, non un no-op silenzioso.
      const anomaly = detectAnomaly({
        setResult, results, readbackOk, sameAsPrevious, staleConfermato, contestoCambiato,
        baselineAssente: baselineFp === null,
        // Due casi in cui NON si accusa un no-op, per ragioni diverse ma entrambe autoritative:
        //  - gli input erano gia' quelli richiesti: non ricalcolare e' corretto;
        //  - TradingView dichiara il report ATTUALE (banner sparito): il calcolo e' avvenuto, e se
        //    i numeri coincidono con quelli di prima e' perche' quell'input non li muove — misurato
        //    su RR target 1.5/2/3, sempre 651 trade. `isLoading()` non vede il ricalcolo innescato
        //    dal pulsante, quindi qui varrebbe zero.
        recalcObserved: (deltaReale && !report.aggiornato) ? recalcObserved : null,
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

      // Variante di costo: NON ci si fida del ritorno del set. Il rate implicito
      // `commission_paid / Σqty` deve coincidere col valore scritto; la variante 0 (controllo)
      // deve riprodurre il padre. Se il controllo fallisce, l'identita' del re-run non e' preservata
      // e NESSUNA variante della batch e' attendibile: si marcano failed anche quelle in coda.
      // "Non verificabile" (padre non letto, nessun fill) marca la sola run, non annulla la batch.
      let verificaCosto = null;
      if (costo) {
        const c = await readCommissionFor(entity_id);
        const perContratto = Number(costo.commission_per_contract) || 0;
        let esito;
        if (!c?.success) {
          esito = { ok: false, kind: 'commission_unreadable', detail: c?.error || 'commissioni non leggibili dal report' };
        } else if (perContratto === 0) {
          const padre = await api.getBacktest(run.parent_backtest_id);
          const ctrl = checkControlRun({
            variant: { total_trades: results.metrics.total_trades, net_profit: results.metrics.net_profit, commission_paid: c.commission_paid },
            parent: padre || {},
          });
          esito = ctrl.ok ? { ok: true }
            : { ok: false, kind: ctrl.kind === 'unverifiable' ? 'control_run_unverifiable' : 'control_run_mismatch', detail: ctrl.detail };
        } else {
          const rate = checkImpliedRate({ commission_paid: c.commission_paid, filled_qty_sum: c.filled_qty_sum, expected: perContratto });
          esito = rate.ok ? { ok: true, implied_rate: rate.implied_rate }
            : { ok: false, kind: rate.kind === 'unverifiable' ? 'commission_rate_unverifiable' : 'commission_rate_mismatch', detail: rate.detail };
        }

        if (!esito.ok) {
          const msg = `${esito.kind}: ${esito.detail}`;
          await api.markFailed(run.id, msg);
          failed++;
          rows.push({ run_id: run.id, label: run.label ?? null, status: 'failed', error: msg.slice(0, 300), commission_per_lot: Number(costo.commission_per_lot ?? 0) });
          if (esito.kind === 'control_run_mismatch') {
            for (const id of (codaPerId || []).splice(0)) {
              await api.markFailed(id, `control_run_mismatch: il run di controllo non ha riprodotto il padre (${esito.detail})`);
              failed++;
              rows.push({ run_id: id, label: null, status: 'failed', error: 'control_run_mismatch' });
            }
            stopped_reason = { kind: esito.kind, detail: esito.detail, run_id: run.id, label: run.label ?? null };
            await api.progress(command_id, `⛔ run ${run.id}: il controllo a commissione 0 non riproduce il padre (${esito.detail}) — batch annullata`);
            break;
          }
          await api.progress(command_id, `○ run ${run.id}: ${msg} — proseguo`);
          prevFp = fingerprint(results.metrics);
          continue;
        }
        verificaCosto = { ...c, implied_rate: esito.implied_rate ?? 0 };
      }

      // Il periodo si rilegge dal tester DOPO il ricalcolo, e si registra QUELLO. Mai quello
      // richiesto: api.md lo dice da sempre ("popola SEMPRE col range REALE"), e scriverlo a fiducia
      // e' esattamente ciò che ha prodotto dieci backtest identici con dieci etichette diverse.
      const periodoFinale = await readTestPeriod();
      const { inputs, properties, initialCapital, appliedInputs } = buildInputsPayload(info, actual);
      const payload = toFinalizePayload(results.metrics, {
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

      prevFp = fingerprint(results.metrics);
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

  // Le Proprieta' della commissione tornano com'erano PRIMA della prima variante. Un chart lasciato
  // con una commissione appiccicata falserebbe il prossimo backtest ordinario.
  let commissionRestored;
  if (snapshotCommissione) {
    try { await setInputs({ entity_id, inputs: snapshotCommissione }); commissionRestored = true; }
    catch { commissionRestored = false; }
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
  const righe = digest
    ? rows.map((r) => (r.status === 'done' && r.commission_per_lot == null ? { run_id: r.run_id, label: r.label, status: r.status } : r))
    : rows;

  return {
    success: true, session_id, entity_id, executed, failed, stopped_reason, rows: righe,
    digest, ...(digest_error && { digest_error }),
    ...(restoreHidden && { visibility_restored: restored }),
    ...(commissionRestored !== undefined && { commission_restored: commissionRestored }),
  };
}
