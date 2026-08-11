import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grindSession } from '../src/core/backtest.js';

function makeDeps({ runs, metricsSeq }) {
  const queue = [...runs];
  const finalized = [];
  const seen = { reportIds: [], loadingIds: [] };
  let call = 0;
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
        progress: async () => null,
      },
      setInputs: async ({ inputs }) => { applied = { ...applied, ...inputs }; loadingPending = true; return { updated_inputs: inputs, missing: [] }; },
      readReportFor: async (id) => {
        seen.reportIds.push(id);
        return { success: true, metrics: metricsSeq[Math.min(call++, metricsSeq.length - 1)] };
      },
      readStrategyLoading: async (id) => {
        seen.loadingIds.push(id);
        if (loadingPending) { loadingPending = false; return true; }
        return false;
      },
      ensureTesterPanel: async () => ({ ok: true, altezza: 400 }),
      ensureVisibleFor: async () => ({ found: true, wasHidden: false, visible: true }),
      setStrategyVisibility: async () => true,
      // Chart finto: tiene davvero symbol/timeframe/periodo, cosi' le verifiche di
      // applicaContestoRun esercitano il comportamento vero invece di passare a vuoto.
      getChartState: async () => ({ symbol: chart.symbol, resolution: chart.resolution }),
      setSymbol: async ({ symbol }) => { chart.symbol = symbol; return { success: true }; },
      setTimeframe: async ({ timeframe }) => { chart.resolution = String(timeframe); return { success: true }; },
      readTestPeriod: async () => ({ ...chart.periodo }),
      setCustomPeriod: async (from, to) => {
        chart.periodo = { label: `${from} — ${to}`, from, to };
        return { applied: true, ...chart.periodo };
      },
      // Il pannello finto serve le stesse metriche dell'API: le run che dichiarano un periodo
      // leggono SOLO da qui, quindi senza di lui fallirebbero (ed e' il comportamento voluto).
      // Il pannello SBIRCIA la stessa metrica dell'API senza far avanzare la sequenza: cosi' le
      // due fonti concordano e i test restano leggibili. Chi vuole esercitare la divergenza
      // (periodo ristretto) sovrascrive questa dep.
      readPanelMetrics: async () => ({ success: true, source: 'panel', metrics: metricsSeq[Math.min(call, metricsSeq.length - 1)] }),
      captureScreenshot: async () => ({ file_path: '/tmp/shot.png' }),
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
    metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 })],
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
  });
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
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: {} }],
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
  deps.readPanelMetrics = async () => ({
    success: true, source: 'panel',
    metrics: { total_trades: 3, net_profit: -101.14, net_profit_percent: -0.001, max_drawdown: 2104.68, max_drawdown_percent: 0.0206, percent_profitable: 0.3333, profit_factor: 0.952 },
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
  deps.readPanelMetrics = async () => {
    tentativi++;
    if (tentativi <= 3) return { success: false, retryable: true, metrics: {}, source: 'panel', error: 'in ridisegno' };
    return { success: true, source: 'panel', metrics: M({ total_trades: 5, net_profit: 42 }) };
  };

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01', recalc_timeout_ms: 3000, recalc_stable_checks: 1 }, deps);

  assert.equal(out.executed, 1);
  assert.equal(finalized[0].payload.total_trades, 5);
  assert.ok(tentativi > 3);
});

test('senza filtro di periodo si usa l API interna, piu ricca (Sharpe e Sortino)', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } }],
    metricsSeq: [M({ total_trades: 288, sharpe_ratio: 0.3, sortino_ratio: 0.77 })],
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

