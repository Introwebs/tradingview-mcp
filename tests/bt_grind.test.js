import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grindSession } from '../src/core/backtest.js';

function makeDeps({ runs, metricsSeq, metricheFerme = false }) {
  const queue = [...runs];
  const finalized = [];
  const seen = { reportIds: [], loadingIds: [], refreshChiamato: 0, maximize: [], progress: [] };
  // `call` NON avanza piu' a ogni lettura: un motore non cambia risultato perche' lo guardi, e
  // quella finzione mascherava il difetto vero (il report obsoleto che non si ricalcola). Avanza
  // quando cambia qualcosa: input, symbol, timeframe, periodo. Chi vuole simulare metriche che si
  // muovono DURANTE il ricalcolo sovrascrive readReportFor.
  let call = 0;
  // Esaurita la sequenza NON si ripete l'ultimo valore: ripeterlo simula un pannello fermo, che e'
  // il difetto del 2026-08-11 (report obsoleto mai aggiornato), e faceva passare per scenari neutri
  // dei test che stavano descrivendo un bug. Chi vuole le metriche immobili passa `metricheFerme`.
  const metricaCorrente = () => {
    if (call < metricsSeq.length) return metricsSeq[call];
    const ultimo = metricsSeq[metricsSeq.length - 1];
    return metricheFerme ? ultimo : { ...ultimo, net_profit: 100000 + call };
  };
  // Il chart finto tiene davvero lo stato degli input: se non lo facesse, il readback di
  // grindSession vedrebbe valori diversi da quelli richiesti e ogni run finirebbe in
  // readback_mismatch. È esattamente il controllo che vogliamo esercitare.
  let applied = { in_0: 1, in_40: 10000 };
  // Il motore finto: applicare input accende il ricalcolo per una lettura, come TradingView.
  let loadingPending = false;
  const chart = { symbol: 'EURUSD', resolution: '15', periodo: { label: 'Storico completo', from: null, to: null } };
  return {
    finalized,
    seen,
    chart,
    deps: {
      api: {
        nextRun: async () => queue.shift() ?? null,
        markRunning: async () => ({}),
        markFailed: async () => ({}),
        stageEquity: async () => ({}),
        finalize: async (runId, payload) => { finalized.push({ runId, payload }); return { data: { id: runId * 10 } }; },
        progress: async (_cmd, msg) => { seen.progress.push(String(msg)); return null; },
        // Il digest si allega al ritorno di OGNI grind: senza stub i test cadrebbero
        // sull'implementazione vera, che cerca la rete, e la suite si IMPIANTA invece di fallire.
        sessionDigest: async (id) => ({ data: { session: { id }, compact: true, groups: [], moves: { total: 0, omitted: 0, items: [] } } }),
      },
      setInputs: async ({ inputs }) => { applied = { ...applied, ...inputs }; loadingPending = true; call += 1; return { updated_inputs: inputs, missing: [] }; },
      readReportFor: async (id) => {
        seen.reportIds.push(id);
        return { success: true, metrics: metricaCorrente() };
      },
      readStrategyLoading: async (id) => {
        seen.loadingIds.push(id);
        if (loadingPending) { loadingPending = false; return true; }
        return false;
      },
      ensureTesterPanel: async () => ({ ok: true, altezza: 400 }),
      // Col periodo di test personalizzato TradingView non ricalcola da solo: marca il report
      // obsoleto e aspetta il pulsante "Aggiorna report". Lo stub registra se il grind lo cerca.
      aggiornaReportSeObsoleto: async () => { seen.refreshChiamato = (seen.refreshChiamato || 0) + 1; return { obsoleto: false, cliccato: false }; },
      // Segnale AUTORITATIVO: TradingView dichiara il report attuale. Di default si assume di si',
      // cosi' i test descrivono il caso sano; chi vuole il banner che non se ne va lo sovrascrive.
      attendiReportAggiornato: async () => { seen.refreshChiamato = (seen.refreshChiamato || 0) + 1; return { aggiornato: true, click: 0 }; },
      ensureVisibleFor: async () => ({ found: true, wasHidden: false, visible: true }),
      setStrategyVisibility: async () => true,
      // Chart finto: tiene davvero symbol/timeframe/periodo, cosi' le verifiche di
      // applicaContestoRun esercitano il comportamento vero invece di passare a vuoto.
      getChartState: async () => ({ symbol: chart.symbol, resolution: chart.resolution }),
      setSymbol: async ({ symbol }) => { chart.symbol = symbol; call += 1; return { success: true }; },
      setTimeframe: async ({ timeframe }) => { chart.resolution = String(timeframe); call += 1; return { success: true }; },
      readTestPeriod: async () => ({ ...chart.periodo }),
      setCustomPeriod: async (from, to) => {
        chart.periodo = { label: `${from} — ${to}`, from, to };
        call += 1;
        return { applied: true, ...chart.periodo };
      },
      // Il pannello finto serve le stesse metriche dell'API: le run che dichiarano un periodo
      // leggono SOLO da qui, quindi senza di lui fallirebbero (ed e' il comportamento voluto).
      // Il pannello SBIRCIA la stessa metrica dell'API senza far avanzare la sequenza: cosi' le
      // due fonti concordano e i test restano leggibili. Chi vuole esercitare la divergenza
      // (periodo ristretto) sovrascrive questa dep.
      readPanelMetrics: async () => ({ success: true, source: 'panel', metrics: metricaCorrente() }),
      captureScreenshot: async () => { seen.maximize.push('scatto'); return { file_path: '/tmp/shot.png' }; },
      // Il pannello finto parte da 'normal', come dopo ensureTesterPanel. Si registra la SEQUENZA e
      // non il conteggio: se lo scatto non cade FRA la massimizzazione e il ripristino, l'immagine
      // e' comunque quella piccola — ed e' esattamente il difetto da cui nasce questo stub.
      setPanelMaximized: async (m) => {
        seen.maximize.push(m ? 'max' : 'normal');
        return { ok: true, prima: m ? 'normal' : 'maximized', mode: m ? 'maximized' : 'normal' };
      },
      readInputsInfo: async () => ([
        { id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Ingressi' },
        { id: 'in_40', name: 'Initial Capital', type: 'float', group: null },
      ]),
      readInputValues: async () => ({ ...applied }),
      sleep: async () => {},
    },
  };
}

const M = (over = {}) => ({
  net_profit: 100, net_profit_percent: 1, max_drawdown: 10, max_drawdown_percent: 0.5,
  profit_factor: 1.5, total_trades: 20, percent_profitable: 50,
  ...over,
});

test('esegue tutte le run pending e finalizza ognuna', async () => {
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 }, label: 'a' },
      { id: 2, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 3 }, label: 'b' },
    ],
    // La sequenza deve avere abbastanza valori: il grind legge piu' volte per run (attesa del
    // ricalcolo + stabilizzazione) e lo stub, esaurita la sequenza, ripete l'ultimo valore — cioe'
    // simula un pannello fermo, che da oggi e' `stale_metrics`. Serve un valore FRESCO per run.
    metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 300 }), M({ net_profit: 400 })],
  });
  const out = await grindSession({
    session_id: 7, entity_id: 'ent1',
    period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(out.executed, 2);
  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 2);
  assert.equal(finalized[0].payload.symbol, 'EURUSD');
  // Il valore finalizzato è quello RILETTO dal chart dopo il set, non quello richiesto a occhi chiusi.
  assert.equal(finalized[0].payload.inputs['Risk/Reward'], 2);
  assert.equal(finalized[1].payload.inputs['Risk/Reward'], 3);
  assert.equal(finalized[0].payload.initial_capital, 10000);
  assert.equal(out.rows[0].label, 'a');
});

test('si ferma se il readback non conferma i valori richiesti', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 5 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  // Dropdown che accetta il set ma non lo applica: il no-op silenzioso noto.
  deps.setInputs = async () => ({ updated_inputs: {}, missing: [] });
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.stopped_reason.kind, 'readback_mismatch');
  assert.equal(finalized.length, 0);
});

test('una run senza trade non viene finalizzata ma NON ferma la matrice', async () => {
  // Su un asse periodo una finestra corta senza trade e' un dato, non un guasto: verificato dal
  // vivo il 2026-08-11 (M15 su 7 giorni fa davvero zero trade). Fermarsi li' buttava via le altre
  // diciannove run della sessione.
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } },
      { id: 2, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 3 } },
    ],
    metricsSeq: [M({ total_trades: 0 })],
  });
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  // Entrambe le run sono state TENTATE: la prima a zero trade non ha abortito la matrice.
  assert.equal(out.failed, 2);
  assert.equal(out.stopped_reason, null);   // due non bastano a dichiarare il guasto sistemico
  assert.equal(finalized.length, 0);        // ma nessuna viene registrata come backtest valido
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].error, 'zero_trades');
});

test('tre run consecutive a zero trade sono una configurazione rotta, non un periodo corto', async () => {
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } },
      { id: 2, symbol: 'X', timeframe: '15', input_set: { in_0: 3 } },
      { id: 3, symbol: 'X', timeframe: '15', input_set: { in_0: 4 } },
      { id: 4, symbol: 'X', timeframe: '15', input_set: { in_0: 5 } },
    ],
    metricsSeq: [M({ total_trades: 0, net_profit: 1 }), M({ total_trades: 0, net_profit: 2 }), M({ total_trades: 0, net_profit: 3 }), M({ total_trades: 0, net_profit: 4 })],
  });
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(out.stopped_reason.kind, 'zero_trades_systemic');
  assert.equal(out.failed, 3);
  assert.equal(finalized.length, 0);
});

test('rispetta max_runs', async () => {
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 2, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 3, symbol: 'X', timeframe: '15', input_set: {} },
    ],
    metricsSeq: [M(), M({ net_profit: 2 }), M({ net_profit: 3 }), M({ net_profit: 4 })],
  });
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', max_runs: 2, period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.executed, 2);
  assert.equal(finalized.length, 2);
});

test('la run usa i propri period_start/period_end quando li ha', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: {}, period_start: '2020-01-01', period_end: '2021-01-01' }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(finalized[0].payload.period_start, '2020-01-01');
  assert.equal(finalized[0].payload.period_end, '2021-01-01');
});

test('un 422 sul finalize marca la run failed e prosegue con la successiva', async () => {
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 2, symbol: 'X', timeframe: '15', input_set: {} },
    ],
    metricsSeq: [M(), M({ net_profit: 2 }), M({ net_profit: 3 })],
  });
  let first = true;
  deps.api.finalize = async (runId, payload) => {
    if (first) { first = false; throw new Error('HTTP 422: Incomplete inputs'); }
    finalized.push({ runId, payload });
    return { data: { id: 20 } };
  };
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.failed, 1);
  assert.equal(out.executed, 1);
  assert.equal(out.stopped_reason, null);
});

test('tre fallimenti consecutivi in finalize sono un guasto sistemico: il grind si ferma e non tocca le run successive', async () => {
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 2, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 3, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 4, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 5, symbol: 'X', timeframe: '15', input_set: {} },
    ],
    metricsSeq: [M(), M({ net_profit: 2 }), M({ net_profit: 3 }), M({ net_profit: 4 }), M({ net_profit: 5 }), M({ net_profit: 6 })],
  });
  deps.api.finalize = async () => { throw new Error('HTTP 422: Initial Capital mancante'); };
  let nextRunCalls = 0;
  const origNextRun = deps.api.nextRun;
  deps.api.nextRun = async (...args) => { nextRunCalls++; return origNextRun(...args); };

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(out.stopped_reason.kind, 'systemic_failure');
  assert.equal(out.stopped_reason.run_id, 3);
  assert.equal(out.failed, 3);
  assert.equal(out.executed, 0);
  assert.equal(finalized.length, 0);
  assert.equal(nextRunCalls, 3); // non chiamata per la run 4 o 5: il breaker ha fermato tutto prima
});

test('il contatore dei fallimenti consecutivi si azzera a ogni successo (fallimenti sparsi non sono un guasto sistemico)', async () => {
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 2, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 3, symbol: 'X', timeframe: '15', input_set: {} },
      { id: 4, symbol: 'X', timeframe: '15', input_set: {} },
    ],
    metricsSeq: [M(), M({ net_profit: 2 }), M({ net_profit: 3 }), M({ net_profit: 4 }), M({ net_profit: 5 })],
  });
  const outcomes = [false, true, false, true]; // fallisce, ok, fallisce, ok
  let i = 0;
  deps.api.finalize = async (runId, payload) => {
    const ok = outcomes[i++];
    if (!ok) throw new Error('HTTP 422: errore isolato');
    finalized.push({ runId, payload });
    return { data: { id: runId * 10 } };
  };
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.stopped_reason, null);
  assert.equal(out.executed, 2);
  assert.equal(out.failed, 2);
});

test('rifiuta di partire se la strategia bersaglio non è sul chart', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  deps.ensureVisibleFor = async () => ({ found: false, wasHidden: false, visible: false });

  await assert.rejects(
    () => grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps),
    /ent1.*data source/s
  );
  assert.equal(finalized.length, 0);
});

test('ogni lettura di metriche è indirizzata all entity_id bersaglio, mai "la prima con un report"', async () => {
  // È IL test che il difetto reale richiedeva: su un chart con più strategie, leggere quella
  // sbagliata produce numeri plausibili e nessun errore. L'unica difesa è che l'id richiesto
  // arrivi a ogni singola lettura.
  const { deps, seen } = makeDeps({
    runs: [
      { id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } },
      { id: 2, symbol: 'X', timeframe: '15', input_set: { in_0: 3 } },
    ],
    metricsSeq: [M(), M({ net_profit: 2 }), M({ net_profit: 3 })],
  });
  await grindSession({ session_id: 7, entity_id: 'GoZBF3', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.ok(seen.reportIds.length > 0);
  assert.deepEqual([...new Set(seen.reportIds)], ['GoZBF3']);
  assert.deepEqual([...new Set(seen.loadingIds)], ['GoZBF3']);
});

test('se il ricalcolo non parte mai e le metriche non cambiano è un no-op silenzioso: niente finalize', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [M()], // saturato: le metriche non cambiano mai
    metricheFerme: true, // il pannello NON si aggiorna: e' il difetto che il test descrive
  });
  // Perche' sia un no-op vero serve anche che TradingView NON dichiari il report attuale:
  // se lo dichiara, numeri fermi significano solo che quell'input non li muove.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 0 });
  deps.readStrategyLoading = async () => false; // isLoading non passa mai a true

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(out.stopped_reason.kind, 'silent_noop');
  assert.equal(finalized.length, 0);
});

test('se isLoading non è leggibile si degrada all euristica e NON si accusa un no-op invisibile', async () => {
  // Se un domani TradingView togliesse isLoading(), il grind deve continuare a funzionare
  // come prima, non dichiarare no-op ogni singola run e fermare la matrice.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  deps.readStrategyLoading = async () => null;

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 1);
});

test('registra il valore FINALE quando le metriche cambiano solo alla fine del ricalcolo', async () => {
  // Il ciclo reale misurato dal vivo: isLoading true per ~1,1 s, metriche nuove pubblicate al
  // ritorno a false. Il grind deve salvare quelle, non ciò che c'era mentre calcolava.
  const vecchio = M({ total_trades: 208, net_profit: -18 });
  const finale = M({ total_trades: 288, net_profit: 415 });

  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [vecchio, vecchio, finale],
  });
  // isLoading: true per due letture, poi false — le metriche cambiano solo dopo.
  let ticks = 0;
  deps.readStrategyLoading = async () => (ticks++ < 2);

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1',
    period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 2000, recalc_stable_checks: 3,
  }, deps);

  assert.equal(out.executed, 1);
  assert.equal(finalized[0].payload.total_trades, 288);
  assert.equal(finalized[0].payload.net_profit, 415);
  assert.notEqual(finalized[0].payload.total_trades, 208);
});

test('una run con input_set vuoto non viene scambiata per un no-op silenzioso', async () => {
  // Girare sugli input correnti è legittimo: senza set non c'è ricalcolo, e non ricalcolare
  // NON è un difetto. Fermare la matrice qui sarebbe un falso allarme.
  const { deps, finalized } = makeDeps({
    // Il chart finto parte da EURUSD/15, quindi questa run NON cambia contesto: e' il punto del
    // test. Prima chiedeva symbol 'X', cioe' un cambio di simbolo — e li' metriche identiche non
    // sono legittime ma IMPOSSIBILI. Il test passava solo perche' il controllo non esisteva.
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: {} }],
    metricsSeq: [M()], // metriche invariate, come è giusto che sia
  });
  deps.readStrategyLoading = async () => false;

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 1);
});

// --- I QUATTRO ASSI DELLA MATRICE ------------------------------------------------------------
// Questi test esistono per un disastro reale (2026-08-11): bt_grind applicava SOLO l'input_set e
// scriveva symbol, timeframe e periodo della run nel payload come se li avesse imposti. Venti run
// richieste su due timeframe e dieci periodi hanno prodotto dieci copie dello stesso backtest,
// ognuna con un'etichetta che non le apparteneva. Nessuno dei 57 test di allora se ne accorgeva,
// perche' nessuno faceva variare quegli assi.

test('applica symbol e timeframe della run al chart, non solo gli input', async () => {
  const { deps, chart } = makeDeps({
    runs: [{ id: 1, symbol: 'TVC:NDQ', timeframe: '5', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(chart.symbol, 'TVC:NDQ');
  assert.equal(chart.resolution, '5');
});

test('si ferma se il timeframe non viene applicato davvero', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '5', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  deps.setTimeframe = async () => ({ success: true }); // accetta ma non cambia nulla
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.stopped_reason.kind, 'timeframe_not_applied');
  assert.equal(finalized.length, 0);
});

test('si ferma se il periodo non viene applicato davvero', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', period_start: '2026-08-04', period_end: '2026-08-11', input_set: {} }],
    metricsSeq: [M()],
  });
  deps.setCustomPeriod = async () => ({ applied: false, label: null, from: null, to: null, error: 'dialog non compilabile' });
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.stopped_reason.kind, 'period_not_applied');
  assert.equal(finalized.length, 0);
});

test('registra il periodo REALE applicato da TradingView, non quello richiesto', async () => {
  // Caso vero: si chiede dal 2020 ma la storia disponibile parte dal 2023. Il backtest e' valido,
  // ma va etichettato con quello che e' stato davvero misurato.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', period_start: '2020-01-01', period_end: '2026-08-11', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  deps.setCustomPeriod = async () => ({ applied: true, label: '4 ago 2023 — 11 ago 2026', from: '2023-08-04', to: '2026-08-11' });
  deps.readTestPeriod = async () => ({ label: '4 ago 2023 — 11 ago 2026', from: '2023-08-04', to: '2026-08-11' });

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.executed, 1);
  assert.equal(finalized[0].payload.period_start, '2023-08-04');
  assert.notEqual(finalized[0].payload.period_start, '2020-01-01');
  assert.equal(finalized[0].payload.extra_metrics.period_requested, '2020-01-01 → 2026-08-11');
  assert.equal(finalized[0].payload.extra_metrics.period_applied, '4 ago 2023 — 11 ago 2026');
});

test('con un periodo ristretto le metriche vengono dal PANNELLO, non dall API interna cieca al periodo', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', period_start: '2026-08-04', period_end: '2026-08-11', input_set: { in_0: 2 } }],
    metricsSeq: [M({ total_trades: 288, net_profit: 28309 })], // l'API interna vede tutto lo storico
  });
  // Il pannello deve CAMBIARE dopo il set: uno stub che risponde sempre lo stesso valore e' il
  // pannello fermo che dal 2026-08-11 rifiutiamo (stale_metrics), non un caso legittimo.
  let dopoIlSet = false;
  const setOriginale = deps.setInputs;
  deps.setInputs = async (arg) => { const r = await setOriginale(arg); dopoIlSet = true; return r; };
  deps.readPanelMetrics = async () => ({
    success: true, source: 'panel',
    metrics: dopoIlSet
      ? { total_trades: 3, net_profit: -101.14, net_profit_percent: -0.001, max_drawdown: 2104.68, max_drawdown_percent: 0.0206, percent_profitable: 0.3333, profit_factor: 0.952 }
      : { total_trades: 9, net_profit: -50, net_profit_percent: -0.0005, max_drawdown: 1000, max_drawdown_percent: 0.01, percent_profitable: 0.2, profit_factor: 0.8 },
  });

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(out.executed, 1);
  assert.equal(finalized[0].payload.total_trades, 3);
  assert.equal(finalized[0].payload.net_profit, -101.14);
  assert.equal(finalized[0].payload.extra_metrics.metrics_source, 'panel');
});

test('periodo ristretto e pannello illeggibile: NON si ripiega sull API interna, si fallisce', async () => {
  // Difetto trovato dal vivo il 2026-08-11: dopo un cambio di timeframe il pannello era ancora in
  // ridisegno, il codice ripiegava sull'API interna — che ignora il periodo — e la run "3 giorni"
  // ha registrato i 288 trade dello storico intero. Un ripiego su una fonte che si SA sbagliata
  // per questa configurazione e' peggio di un fallimento.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', period_start: '2026-08-08', period_end: '2026-08-11', input_set: { in_0: 2 } }],
    metricsSeq: [M({ total_trades: 288, net_profit: 28309 })],
  });
  deps.readPanelMetrics = async () => ({ success: false, retryable: true, metrics: {}, source: 'panel', error: 'pannello in ridisegno' });

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(out.executed, 0);
  assert.equal(finalized.length, 0);
  assert.equal(out.stopped_reason.kind, 'runtime_error');
  assert.match(out.stopped_reason.detail, /pannello/i);
});

test('periodo ristretto: il pannello che arriva in ritardo viene atteso, non fatto fallire', async () => {
  // Il rovescio del test precedente: un ritardo di rendering non deve bruciare la run.
  let tentativi = 0;
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', period_start: '2026-08-08', period_end: '2026-08-11', input_set: { in_0: 2 } }],
    metricsSeq: [M()],
  });
  // Dopo il ridisegno il pannello deve dare un valore NUOVO: restare su una costante sarebbe il
  // pannello fermo, cioe' un difetto, non un ritardo.
  let applicato = false;
  const setOrig = deps.setInputs;
  deps.setInputs = async (arg) => { const r = await setOrig(arg); applicato = true; return r; };
  deps.readPanelMetrics = async () => {
    tentativi++;
    if (tentativi <= 3) return { success: false, retryable: true, metrics: {}, source: 'panel', error: 'in ridisegno' };
    return applicato
      ? { success: true, source: 'panel', metrics: M({ total_trades: 5, net_profit: 42 }) }
      : { success: true, source: 'panel', metrics: M({ total_trades: 11, net_profit: 7 }) };
  };

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 3000, recalc_stable_checks: 1 }, deps);

  assert.equal(out.executed, 1);
  assert.equal(finalized[0].payload.total_trades, 5);
  assert.ok(tentativi > 3);
});

test('senza filtro di periodo si usa l API interna, piu ricca (Sharpe e Sortino)', async () => {
  const { deps, finalized } = makeDeps({
    // Due valori in sequenza: il primo e' la baseline letta a inizio grind, il secondo il
    // risultato DOPO il set. Con un valore solo il risultato sarebbe identico alla baseline —
    // che dal 2026-08-11 e' `stale_metrics`, non un dato.
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [
      M({ total_trades: 288, net_profit: 1 }),
      M({ total_trades: 288, sharpe_ratio: 0.3, sortino_ratio: 0.77 }),
    ],
  });
  // pannello e API concordano sul numero di trade => nessun filtro attivo
  deps.readPanelMetrics = async () => ({ success: true, source: 'panel', metrics: { total_trades: 288, net_profit: 1 } });

  await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.equal(finalized[0].payload.extra_metrics.metrics_source, 'internal_api');
  assert.equal(finalized[0].payload.sharpe, 0.3);
  assert.equal(finalized[0].payload.sortino, 0.77);
});

test('rimette nascosta la strategia se era nascosta prima del grind', async () => {
  const { deps } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  deps.ensureVisibleFor = async () => ({ found: true, wasHidden: true, visible: true });
  const restored = [];
  deps.setStrategyVisibility = async (id, visible) => { restored.push({ id, visible }); return true; };

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(out.executed, 1);
  assert.deepEqual(restored, [{ id: 'ent1', visible: false }]);
});

test('non tocca la visibilità se la strategia era già visibile', async () => {
  const { deps } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  const restored = [];
  deps.setStrategyVisibility = async (id, visible) => { restored.push({ id, visible }); return true; };

  await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);
  assert.deepEqual(restored, []);
});


// --- METRICHE FERME (incidente sessione 43, 2026-08-11) ---------------------------------------
// Il pannello Strategy Tester e' ASINCRONO rispetto al ricalcolo: isLoading() torna false e il DOM
// mostra ancora i numeri della run PRECEDENTE. detectAnomaly accettava quel caso — bastava che il
// motore avesse ricalcolato e il readback fosse corretto — e finalizzava. Risultato misurato in
// produzione: 15 backtest M5 su 19 identici al bit con input_set diversi, e lo stesso identico
// risultato su tutti i 9 M15 e su uno M5.

test('metriche identiche dopo un cambio di TIMEFRAME: impossibile, si ferma', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '5', input_set: {} }],
    metricsSeq: [M()], // il pannello resta fermo sui numeri di prima
    metricheFerme: true, // il pannello NON si aggiorna: e' il difetto che il test descrive
  });
  // Il banner NON se ne va: TradingView continua a dichiarare il report obsoleto. E' questa la
  // condizione che rende sospetta l'identita' dei numeri — non l'identita' in se'.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 1 });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(out.stopped_reason?.kind, 'stale_metrics');
  assert.match(out.stopped_reason.detail, /impossibile/);
  assert.equal(finalized.length, 0, 'non deve finalizzare NIENTE con metriche ferme');
});

test('metriche identiche dopo un cambio di INPUT: si ferma invece di scrivere', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 3 } }],
    metricsSeq: [M()],
    metricheFerme: true, // il pannello NON si aggiorna: e' il difetto che il test descrive
  });
  // Il banner NON se ne va: TradingView continua a dichiarare il report obsoleto. E' questa la
  // condizione che rende sospetta l'identita' dei numeri — non l'identita' in se'.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 1 });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(out.stopped_reason?.kind, 'stale_metrics');
  assert.equal(finalized.length, 0);
});

test('pannello LENTO: le riletture recuperano il valore nuovo e la run si finalizza', async () => {
  // Il caso che il fix deve salvare, non uccidere: il pannello arriva in ritardo ma ARRIVA.
  // baseline -> ancora baseline (ritardo) -> valore nuovo.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 3 } }],
    metricsSeq: [M({ total_trades: 100, net_profit: 10 })],
  });
  // Il banner NON se ne va: TradingView continua a dichiarare il report obsoleto. E' questa la
  // condizione che rende sospetta l'identita' dei numeri — non l'identita' in se'.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 1 });
  // Il pannello arriva in ritardo: due letture col valore vecchio, poi quello nuovo. Serve uno
  // stub esplicito perche' le letture di makeDeps sono (giustamente) idempotenti.
  let letture = 0;
  let cambiato = false;
  const setOrig = deps.setInputs;
  deps.setInputs = async (arg) => { const r = await setOrig(arg); cambiato = true; letture = 0; return r; };
  deps.readReportFor = async () => {
    if (!cambiato) return { success: true, metrics: M({ total_trades: 100, net_profit: 10 }) };
    letture += 1;
    return { success: true, metrics: letture <= 3 ? M({ total_trades: 100, net_profit: 10 }) : M({ total_trades: 100, net_profit: 999 }) };
  };
  deps.readPanelMetrics = async () => ({ success: false, retryable: true, metrics: {}, source: 'panel' });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].payload.net_profit, 999, 'deve registrare il valore RILETTO, non quello fermo');
});

test('cambio di PERIODO: metriche identiche = stale (l asse periodo da solo deve bastare)', async () => {
  // Il caso classico della matrice: stesso symbol, stesso timeframe, stesso input_set, cambia solo
  // la finestra. Se il periodo non contasse come cambio di contesto, il controllo non scatterebbe
  // proprio dove serve di piu'.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: {}, period_start: '2026-07-12', period_end: '2026-08-11' }],
    metricsSeq: [M()],
    metricheFerme: true, // il pannello NON si aggiorna: e' il difetto che il test descrive
  });
  // Il banner NON se ne va: TradingView continua a dichiarare il report obsoleto. E' questa la
  // condizione che rende sospetta l'identita' dei numeri — non l'identita' in se'.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 1 });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(out.stopped_reason?.kind, 'stale_metrics');
  assert.equal(finalized.length, 0);
});

// --- "Il report è obsoleto" (causa radice, 2026-08-11) ----------------------------------------
// Col Periodo di test su un intervallo personalizzato (modalita' ESTESO) TradingView NON ricalcola
// il report quando cambia un input: lo marca obsoleto e aspetta il pulsante "Aggiorna report".
// Misurato: RR 2->6 + 30 s di attesa = pannello fermo; click = numeri nuovi dopo 10,6 s.
// Senza questo passo OGNI run della matrice registra le metriche della configurazione precedente.

test('ogni run chiede l aggiornamento del report obsoleto', async () => {
  const { deps, seen } = makeDeps({
    runs: [
      { id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } },
      { id: 2, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 3 } },
    ],
    metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 300 }), M({ net_profit: 400 })],
  });

  await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(seen.refreshChiamato, 2, 'va chiamato una volta per run, dopo il set degli input');
});

test('la baseline viene dallo stesso canale delle metriche, non dall API interna', async () => {
  // Il buco che produceva l'alternanza done/stale/done/stale in produzione: a inizio grind
  // `prevFp` veniva da readReportFor (API interna, cieca al periodo), quindi con un periodo
  // ristretto la PRIMA run di ogni invocazione non veniva mai confrontata col pannello e
  // finalizzava i numeri della configurazione precedente.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 }, period_start: '2026-07-12', period_end: '2026-08-11' }],
    metricsSeq: [M()],
  });
  // Il banner NON se ne va: TradingView continua a dichiarare il report obsoleto. E' questa la
  // condizione che rende sospetta l'identita' dei numeri — non l'identita' in se'.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 1 });
  // Il pannello resta FERMO su un valore, mentre l'API interna ne dà un altro (è cieca al periodo).
  deps.readPanelMetrics = async () => ({ success: true, source: 'panel', metrics: M({ total_trades: 777 }) });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(out.stopped_reason?.kind, 'stale_metrics');
  assert.equal(finalized.length, 0, 'il pannello fermo non deve piu sfuggire alla prima run');
});

// --- Sessione "completata" che non lo era (incidente 2026-08-11, run 1140) --------------------
// bt_grind e' uscito per un'eccezione DOPO markRunning: la run e' rimasta `running`, e siccome
// nextRun serve solo le `pending` era persa per sempre. Risultato: sessione chiusa con 10
// backtest su 20 e nessun errore visibile.

test('un eccezione durante la run NON la lascia appesa in running', async () => {
  const { deps } = makeDeps({
    // TF 5 contro il chart finto che parte da 15: cosi' il cambio di timeframe avviene davvero
    // ed e' quello a esplodere. Con '15' non sarebbe stato chiamato affatto.
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '5', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  const falliti = [];
  deps.api.markFailed = async (runId, err) => { falliti.push({ runId, err }); return {}; };
  // Qualunque cosa esploda a meta' run: qui il cambio di timeframe, che e' il punto in cui e'
  // successo davvero.
  deps.setTimeframe = async () => { throw new Error('CDP timeout durante il cambio di timeframe'); };

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.equal(falliti.length, 1, 'la run va marcata failed, non lasciata running');
  assert.match(falliti[0].err, /CDP timeout/);
  assert.equal(out.stopped_reason?.kind, 'runtime_error');
  assert.match(out.stopped_reason.detail, /CDP timeout/);
});

test('le run rimaste appese in running vengono rimesse in coda a inizio grind', async () => {
  const { deps } = makeDeps({
    runs: [{ id: 9, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  const recuperate = [];
  deps.api.listRuns = async (sid, status) => (status === 'running' ? [{ id: 1140 }, { id: 1141 }] : []);
  deps.api.reclaimRun = async (id) => { recuperate.push(id); return {}; };

  await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 50, recalc_stable_checks: 1 }, deps);

  assert.deepEqual(recuperate, [1140, 1141]);
});

// --- La baseline va presa DOPO il cambio di contesto (incidente #638, 2026-08-11) -------------
// Prima veniva letta a inizio run, cioe' prima del cambio di timeframe. Su una transizione M5→M15
// la baseline era un valore M5, mentre il pannello mostrava ancora il risultato M15 della run
// PRECEDENTE: diverso dalla baseline, quindi "cambiato", quindi accettato. Il backtest #638
// ("Solo Long", short disattivato) ha cosi' registrato i 169 trade di #637 (short attivo).

test('cambio di timeframe + pannello fermo sui numeri della run prima = stale, non "cambiato"', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '5', input_set: { in_0: 7 }, period_start: '2024-08-11', period_end: '2026-08-11' }],
    metricsSeq: [M()],
  });
  // Il banner NON se ne va: TradingView continua a dichiarare il report obsoleto. E' questa la
  // condizione che rende sospetta l'identita' dei numeri — non l'identita' in se'.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 1 });

  // Il chart finto parte da TF 15. Il pannello simula il difetto reale:
  //  - finche' siamo su TF 15 (prima del cambio) mostra il valore della run precedente;
  //  - dopo il passaggio a TF 5 continua a mostrare LO STESSO valore, perche' non si e' aggiornato.
  // Con la baseline presa prima del cambio, quel valore sembrava "nuovo". Ora no.
  const { chart } = makeDeps({ runs: [], metricsSeq: [M()] }); // solo per non confondere le closure
  void chart;
  deps.readPanelMetrics = async () => ({ success: true, source: 'panel', metrics: M({ total_trades: 169, net_profit: -630 }) });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2024-08-11', period_end: '2026-08-11',
    recalc_timeout_ms: 300, recalc_stable_checks: 1, recalc_step_ms: 10,
  }, deps);

  assert.equal(out.stopped_reason?.kind, 'stale_metrics');
  assert.equal(finalized.length, 0, 'non deve registrare i numeri della run precedente');
});

test('la baseline viene fotografata DOPO l applicazione del contesto', async () => {
  // Ordine atteso: setTimeframe -> (report) -> letture di baseline -> setInputs.
  const ordine = [];
  const { deps } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '5', input_set: { in_0: 7 } }],
    metricsSeq: [M(), M({ net_profit: 999 })],
  });
  const tfOrig = deps.setTimeframe;
  deps.setTimeframe = async (a) => { ordine.push('timeframe'); return tfOrig(a); };
  const readOrig = deps.readReportFor;
  deps.readReportFor = async (id) => { ordine.push('lettura'); return readOrig(id); };
  const setOrig = deps.setInputs;
  deps.setInputs = async (a) => { ordine.push('inputs'); return setOrig(a); };

  await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 300, recalc_stable_checks: 1, recalc_step_ms: 10 }, deps);

  const iTf = ordine.indexOf('timeframe');
  const iInputs = ordine.indexOf('inputs');
  const letturePrimaDegliInput = ordine.slice(iTf, iInputs).filter((x) => x === 'lettura').length;
  assert.ok(iTf >= 0 && iInputs > iTf, 'il timeframe si applica prima degli input');
  assert.ok(letturePrimaDegliInput > 0, 'la baseline va letta fra il cambio di contesto e il set degli input');
});

// --- Una baseline VUOTA non e' una baseline (incidenti #999 e #1006, 2026-08-23) --------------
// Dopo un rilancio di TradingView il chart sta ancora caricando e il pannello non ha metriche. La
// baseline usciva quindi vuota, e rispetto al nulla QUALUNQUE numero sembra "cambiato" — compreso
// quello che il pannello mostra ancora della configurazione salvata sul chart. Da qui #999
// (sessione 63) e #1006 (sessione 64): 553 trade e -14.049,87 identici al centesimo, prodotti a
// settimane di distanza da due configurazioni DIVERSE. Nessuno dei due era storico troncato: erano
// due letture dello stesso stato di partenza, accettate perche' non c'era niente con cui smentirle.

test('baseline vuota: il primo numero che compare non e un risultato, e non va finalizzato', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 7 } }],
    metricsSeq: [M()],
  });
  const stale = M({ total_trades: 553, net_profit: -14049.87 });
  // Il pannello non ha metriche finche' il chart sta caricando — cioe' per tutta la fase in cui si
  // fotografa la baseline. Poi compare lo stato salvato sul chart, che NON e' il risultato di questa
  // run: e' quello che c'era prima. Modellato sul tempo del grind (prima/dopo il set), non sul numero
  // di letture: il grind ne fa migliaia, e un contatore si esaurirebbe prima ancora della baseline.
  let inputApplicati = false;
  const setOrig = deps.setInputs;
  deps.setInputs = async (a) => { inputApplicati = true; return setOrig(a); };
  deps.readReportFor = async () => (inputApplicati ? { success: true, metrics: stale } : { success: true, metrics: {} });
  deps.readPanelMetrics = async () => (inputApplicati
    ? { success: true, source: 'panel', metrics: stale }
    : { success: true, source: 'panel', metrics: {} });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 300, recalc_stable_checks: 1, recalc_step_ms: 10,
  }, deps);

  assert.equal(finalized.length, 0, 'una baseline vuota non autorizza a finalizzare il primo numero che compare');
  assert.ok(out.stopped_reason, 'senza una baseline con cui confrontarsi il grind deve fermarsi, non accettare');
});

test('input gia uguali a quelli richiesti: nessun ricalcolo atteso, la run passa', async () => {
  // La prima run di una matrice e' quasi sempre la configurazione di default, cioe' quella gia'
  // sul chart. Nessun input cambia, quindi nessun ricalcolo e metriche identiche alla baseline:
  // e' il comportamento GIUSTO. Il 2026-08-11 questa run moriva di `silent_noop` e la matrice
  // non partiva nemmeno.
  const { deps, finalized } = makeDeps({
    // in_0 vale gia' 1 nel chart finto: la run chiede esattamente quello.
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 1 } }],
    metricsSeq: [M()],
    metricheFerme: true,
  });
  deps.readStrategyLoading = async () => false;

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 50, recalc_stable_checks: 1,
  }, deps);

  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 1);
});

test('il banner "report obsoleto" viene ricercato a OGNI rilettura, non solo dopo il set', async () => {
  // Riprodotto dal vivo il 2026-08-11 (run 1156, "M5 - RR target 3.0"): RR applicato a 3, pannello
  // fermo sui 651 trade della run precedente, nessun banner nella finestra in cui lo cercavamo.
  // Il banner compare ~226 ms dopo il cambio ma puo' arrivare tardi, o il click puo' non atterrare
  // se il pannello si sta ridisegnando: va ritentato a ogni giro di rilettura.
  let chiamate = 0;
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 9 } }],
    metricsSeq: [M()],
  });
  // Il banner NON se ne va: TradingView continua a dichiarare il report obsoleto. E' questa la
  // condizione che rende sospetta l'identita' dei numeri — non l'identita' in se'.
  deps.attendiReportAggiornato = async () => ({ aggiornato: false, click: 1 });
  // Il pannello si sblocca solo al TERZO tentativo di aggiornamento.
  let sbloccato = false;
  deps.aggiornaReportSeObsoleto = async () => {
    chiamate += 1;
    if (chiamate >= 3) sbloccato = true;
    return { obsoleto: !sbloccato, cliccato: !sbloccato };
  };
  const metriche = () => (sbloccato ? M({ total_trades: 77, net_profit: 4242 }) : M());
  deps.readReportFor = async () => ({ success: true, metrics: metriche() });
  // Anche il pannello deve raccontare la stessa storia, altrimenti le due fonti divergono e la
  // scelta cade sul pannello prima ancora che il ritardo si manifesti.
  deps.readPanelMetrics = async () => ({ success: true, source: 'panel', metrics: metriche() });

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 200, recalc_stable_checks: 1, recalc_step_ms: 10,
  }, deps);

  assert.ok(chiamate >= 3, `il refresh va ritentato: chiamate=${chiamate}`);
  assert.equal(out.stopped_reason, null);
  assert.equal(finalized[0].payload.total_trades, 77);
});

test('report dichiarato ATTUALE + numeri identici = risultato legittimo, non anomalia', async () => {
  // Misurato dal vivo: RR target (Classic) a 1.5, 2 e 3 da' sempre 651 trade, perche' agisce solo
  // in mgmt mode "Classic" che non era attivo. Tre run legittimamente identiche fermavano il grind
  // prima con `stale_metrics`, poi con `silent_noop`. Se TradingView dice che il report e' attuale,
  // il risultato e' valido anche se coincide con quello di prima.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 42 } }],
    metricsSeq: [M()],
    metricheFerme: true,
  });
  deps.attendiReportAggiornato = async () => ({ aggiornato: true, click: 1 });
  deps.readStrategyLoading = async () => false; // nessun ricalcolo visibile: lo innesca il pulsante

  const out = await grindSession({
    session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
    recalc_timeout_ms: 60, recalc_stable_checks: 1, recalc_step_ms: 10,
  }, deps);

  assert.equal(out.stopped_reason, null, 'un risultato identico ma confermato non e un guasto');
  assert.equal(finalized.length, 1);
});

// ── Screenshot: il pannello si massimizza per lo scatto ─────────────────────────────────────────
// Contesto: fino al 2026-08-12 lo scatto usciva col pannello a ~370px su 994 di finestra, e per di
// piu' `captureScreenshot` non riusciva a ritagliarlo (selettori morti) e fotografava tutto lo
// schermo. Risultato: la curva equity era una striscia in un angolo.

const unaRun = () => ({
  runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 42 } }],
  metricsSeq: [M()],
});
const opzioni = (over = {}) => ({
  session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01',
  recalc_timeout_ms: 60, recalc_stable_checks: 1, recalc_step_ms: 10, ...over,
});

test('lo scatto cade fra la massimizzazione e il ripristino', async () => {
  const { deps, seen } = makeDeps(unaRun());
  await grindSession(opzioni(), deps);
  assert.deepEqual(seen.maximize, ['max', 'scatto', 'normal'],
    'massimizzare DOPO lo scatto non serve a niente: l ordine e tutto');
});

test('un pannello gia massimizzato non viene rimesso a normale', async () => {
  // Se l'utente lavora col tester a tutto schermo, il grind non deve restituirgli un layout diverso
  // da quello che aveva: si ripristina solo cio' che si e' cambiato.
  const { deps, seen } = makeDeps(unaRun());
  deps.setPanelMaximized = async (m) => {
    seen.maximize.push(m ? 'max' : 'normal');
    return { ok: true, prima: 'maximized', mode: 'maximized' };
  };
  await grindSession(opzioni(), deps);
  assert.deepEqual(seen.maximize, ['max', 'scatto']);
});

test('maximize_for_screenshot:false lascia il pannello dov e', async () => {
  const { deps, seen } = makeDeps(unaRun());
  await grindSession(opzioni({ maximize_for_screenshot: false }), deps);
  assert.deepEqual(seen.maximize, ['scatto']);
});

test('il pannello torna normale anche se lo scatto esplode', async () => {
  // Senza il `finally` un errore qui lascerebbe il tester a tutto schermo, coprendo il chart per
  // tutte le run successive — e il pulsante del periodo con lui.
  const { deps, seen } = makeDeps(unaRun());
  deps.captureScreenshot = async () => { throw new Error('CDP giu'); };
  const out = await grindSession(opzioni(), deps);
  assert.deepEqual(seen.maximize, ['max', 'normal']);
  assert.equal(out.stopped_reason?.kind, 'runtime_error');
});

// ── Console: solo gli eventi, non i passaggi ────────────────────────────────────────────────────
// Tre righe per run x 20 run = 60 messaggi nella chat dell'operatore, dove restano per sempre.

test('di default la console vede solo la run conclusa', async () => {
  const { deps, seen } = makeDeps(unaRun());
  deps.attendiReportAggiornato = async () => ({ aggiornato: true, click: 1 });
  await grindSession(opzioni(), deps);

  assert.equal(seen.progress.length, 1, `una riga per run, non tre: ${JSON.stringify(seen.progress)}`);
  assert.match(seen.progress[0], /^✔ run 1: /);
  assert.ok(!seen.progress.some((m) => /applico gli input|report obsoleto/.test(m)));
});

test('verbose riaccende la diagnostica passo-passo', async () => {
  // La diagnostica che serviva a inseguire i difetti del 2026-08-11 resta disponibile: e' spenta,
  // non rimossa.
  const { deps, seen } = makeDeps(unaRun());
  deps.attendiReportAggiornato = async () => ({ aggiornato: true, click: 1 });
  await grindSession(opzioni({ verbose: true }), deps);

  assert.ok(seen.progress.some((m) => /applico gli input/.test(m)));
  assert.ok(seen.progress.some((m) => /report obsoleto/.test(m)));
  assert.ok(seen.progress.some((m) => /^✔ run 1: /.test(m)));
});

test('gli stop restano visibili anche in modalita compatta', async () => {
  // Silenziare i passaggi non deve silenziare i guasti: e' la differenza fra meno rumore e meno
  // informazione.
  const { deps, seen } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_999: 1 } }],
    metricsSeq: [M()],
  });
  deps.setInputs = async () => ({ updated_inputs: {}, missing: ['in_999'] });
  const out = await grindSession(opzioni(), deps);

  assert.equal(out.stopped_reason?.kind, 'inputs_not_applied');
  assert.ok(seen.progress.some((m) => /^⛔ run 1:/.test(m)), JSON.stringify(seen.progress));
});

// ── Il digest torna insieme al risultato ────────────────────────────────────────────────────────
// Un passo che il modello deve ricordarsi di fare, prima o poi non lo fa: e' il difetto C1, dove
// una sessione fu chiusa a 10 run su 20 fidandosi di `executed`. Qui lo stato ARRIVA.

test('il digest torna col risultato, senza doverlo chiedere', async () => {
  const { deps } = makeDeps(unaRun());
  const out = await grindSession(opzioni(), deps);
  assert.equal(out.digest.session.id, 7);
  assert.equal(out.digest.compact, true);
});

test('un digest irraggiungibile non fa fallire un grind riuscito', async () => {
  // A questo punto i backtest sono gia' finalizzati e validi: perderli per un 500 sull'endpoint
  // sarebbe assurdo.
  const { deps, finalized } = makeDeps(unaRun());
  deps.api.sessionDigest = async () => { throw new Error('500 dal server'); };
  const out = await grindSession(opzioni(), deps);

  assert.equal(out.executed, 1);
  assert.equal(finalized.length, 1);
  assert.equal(out.digest, null);
  assert.match(out.digest_error, /500/);
});

test('col digest le metriche non si pagano due volte nei rows', async () => {
  const { deps } = makeDeps(unaRun());
  const out = await grindSession(opzioni(), deps);
  assert.deepEqual(Object.keys(out.rows[0]).sort(), ['label', 'run_id', 'status']);
});

test('senza digest i rows restano completi: il grind non diventa muto', async () => {
  const { deps } = makeDeps(unaRun());
  deps.api.sessionDigest = async () => { throw new Error('giu'); };
  const out = await grindSession(opzioni(), deps);
  assert.ok('profit_factor' in out.rows[0], JSON.stringify(out.rows[0]));
  assert.ok('trades' in out.rows[0]);
});

test('una run fallita tiene il suo errore anche col digest allegato', async () => {
  // I fallimenti NON sono nel digest: una run fallita non produce un backtest, quindi in `moves`
  // non compare. Se lo sfoltimento li toccasse, il motivo del fallimento sparirebbe.
  const { deps } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 42 } }],
    metricsSeq: [M()],
  });
  deps.captureScreenshot = async () => ({ file_path: null });
  const out = await grindSession(opzioni(), deps);

  assert.equal(out.rows[0].status, 'failed');
  assert.equal(out.rows[0].error, 'no screenshot');
});

// ── La corsa fra il banner e il ridisegno del pannello ───────────────────────────────────────────
// Sessione 54 (2026-08-12): 8 coppie CONSECUTIVE di backtest con input diversi e metriche identiche
// al bit. Es. #812 (Impulse Cont Bullish+Bearish) e #813 (Morning Star Soft): pattern completamente
// diversi, stesso identico 334 trade / +8,57%. Tutte le coppie a 7,0 s contro una mediana di 8,0 s.
//
// Il buco era nella regola C4. C4 diceva — giustamente — che due input diversi possono dare lo
// stesso risultato, e che quindi l'identita' non e' una prova di guasto se TradingView dichiara il
// report attuale. Ma il banner e il RIDISEGNO del pannello non sono la stessa cosa: il banner
// sparisce quando il ricalcolo e' finito, il DOM si aggiorna un istante dopo. In quella finestra
// leggevamo i numeri della run precedente e li accettavamo, perche' il banner diceva "attuale".
//
// La distinzione vera non e' "cosa dice il banner" ma "rileggendo, i numeri si muovono?".

test('pannello non ancora ridisegnato: si rilegge anche se il banner dice ATTUALE', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 42 }, label: 'Morning Star' }],
    metricsSeq: [M()],
  });
  deps.attendiReportAggiornato = async () => ({ aggiornato: true, click: 1 });
  // `isLoading()` NON vede il ricalcolo innescato dal pulsante (§4.4): resta false, quindi
  // `waitForRecalc` esaurisce la grace di avvio e torna con le metriche ANCORA vecchie.
  deps.readStrategyLoading = async () => false;

  const vecchio = M({ total_trades: 334, net_profit_percent: 0.0857 });
  const nuovo = M({ total_trades: 91, net_profit_percent: -0.0213 });
  // Il pannello si ridipinge TARDI: dopo che waitForRecalc ha gia' rinunciato. Lo si simula
  // facendolo arrivare solo quando qualcuno torna a guardare (il ciclo di rilettura) — che e'
  // esattamente cio' che il codice deve fare e prima non faceva.
  let ridipinto = false;
  let setFatto = false;
  const setOrig = deps.setInputs;
  deps.setInputs = async (a) => { setFatto = true; return setOrig(a); };
  deps.aggiornaReportSeObsoleto = async () => { if (setFatto) ridipinto = true; return { obsoleto: false, cliccato: false }; };
  deps.readPanelMetrics = async () => ({ success: true, source: 'panel', metrics: ridipinto ? nuovo : vecchio });
  deps.readReportFor = async () => ({ success: true, metrics: ridipinto ? nuovo : vecchio });

  const out = await grindSession(opzioni(), deps);

  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].payload.total_trades, 91, 'deve finalizzare i numeri NUOVI, non quelli della run prima');
});

test('identita che resiste alla rilettura resta un dato, non un guasto', async () => {
  // Il rovescio: se anche rileggendo i numeri non si muovono E il banner dice attuale, l'identita'
  // e' legittima (RR target 1.5/2/3 -> sempre 651 trade, perche' agisce solo in mgmt mode Classic).
  // Questa e' la regola C4, e deve continuare a valere: il costo di un falso allarme e' una matrice
  // interrotta e un utente che non sa piu' a cosa credere.
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 42 } }],
    metricsSeq: [M()],
    metricheFerme: true,
  });
  deps.attendiReportAggiornato = async () => ({ aggiornato: true, click: 1 });
  deps.readStrategyLoading = async () => false;

  const out = await grindSession(opzioni(), deps);

  assert.equal(out.stopped_reason, null, 'un risultato identico ma confermato non e un guasto');
  assert.equal(finalized.length, 1);
});
