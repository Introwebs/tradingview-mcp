import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grindSession } from '../src/core/backtest.js';

function makeDeps({ runs, metricsSeq }) {
  const queue = [...runs];
  const finalized = [];
  let call = 0;
  // Il chart finto tiene davvero lo stato degli input: se non lo facesse, il readback di
  // grindSession vedrebbe valori diversi da quelli richiesti e ogni run finirebbe in
  // readback_mismatch. È esattamente il controllo che vogliamo esercitare.
  let applied = { in_0: 1, in_40: 10000 };
  return {
    finalized,
    deps: {
      api: {
        nextRun: async () => queue.shift() ?? null,
        markRunning: async () => ({}),
        markFailed: async () => ({}),
        stageEquity: async () => ({}),
        finalize: async (runId, payload) => { finalized.push({ runId, payload }); return { data: { id: runId * 10 } }; },
        progress: async () => null,
      },
      setInputs: async ({ inputs }) => { applied = { ...applied, ...inputs }; return { updated_inputs: inputs, missing: [] }; },
      getStrategyResults: async () => ({ success: true, metrics: metricsSeq[Math.min(call++, metricsSeq.length - 1)] }),
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
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01' }, deps);
  assert.equal(out.stopped_reason.kind, 'readback_mismatch');
  assert.equal(finalized.length, 0);
});

test('si ferma e restituisce il controllo su 0 trade', async () => {
  const { deps, finalized } = makeDeps({
    runs: [
      { id: 1, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } },
      { id: 2, symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 3 } },
    ],
    metricsSeq: [M(), M({ total_trades: 0 })],
  });
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01' }, deps);

  assert.equal(out.stopped_reason.kind, 'zero_trades');
  assert.equal(out.stopped_reason.run_id, 1);
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
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', max_runs: 2, period_start: '2023-01-01', period_end: '2025-01-01' }, deps);
  assert.equal(out.executed, 2);
  assert.equal(finalized.length, 2);
});

test('la run usa i propri period_start/period_end quando li ha', async () => {
  const { deps, finalized } = makeDeps({
    runs: [{ id: 1, symbol: 'X', timeframe: '15', input_set: {}, period_start: '2020-01-01', period_end: '2021-01-01' }],
    metricsSeq: [M(), M({ net_profit: 2 })],
  });
  await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01' }, deps);
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
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01' }, deps);
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

  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01' }, deps);

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
  const out = await grindSession({ session_id: 7, entity_id: 'ent1', period_start: '2023-01-01', period_end: '2025-01-01' }, deps);
  assert.equal(out.stopped_reason, null);
  assert.equal(out.executed, 2);
  assert.equal(out.failed, 2);
});
