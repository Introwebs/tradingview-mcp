import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBacktest } from '../src/core/btApply.js';

const INFO = [
  { id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Ingressi' },
  { id: 'in_1', name: 'TF:', type: 'resolution', group: 'Ingressi' },
  { id: 'in_40', name: 'Initial Capital', type: 'float', group: null },
  { id: 'in_44', name: 'Commission Value', type: 'float', group: null },
];

const BT = {
  id: 1056, strategy_name: 'Index Grow Test Claude', symbol: 'TVC:NDQ', timeframe: '15',
  period_start: '2025-09-03T00:00:00.000000Z', period_end: '2026-09-03T00:00:00.000000Z',
  inputs: { 'Risk/Reward': 2, 'TF:': '60' }, applied_inputs: null,
  extra_metrics: { properties: { 'Initial Capital': 100000, 'Commission Value': 0 } },
  total_trades: 10, net_profit: 1234.5,
};

function makeDeps({ bt = BT, studies = [{ id: 'ent-1', name: 'Index Grow Test Claude' }], metrics = { total_trades: 10, net_profit: 1234.5, profit_factor: 1.2 } } = {}) {
  const chart = { symbol: 'EURUSD', resolution: '5', periodo: { label: 'Storico completo', from: null, to: null } };
  let applied = { in_0: 1, in_1: '', in_40: 10000, in_44: 0.5 };
  const seen = { setInputs: [], progress: [], periodi: [] };
  let loading = false;
  return {
    seen, chart, applied: () => applied,
    deps: {
      api: { getBacktest: async (id) => (id === bt.id ? bt : null), progress: async (_c, m) => { seen.progress.push(m); } },
      getChartState: async () => ({ symbol: chart.symbol, resolution: chart.resolution, studies }),
      readInputsInfo: async () => INFO,
      readInputValues: async () => ({ ...applied }),
      setInputs: async ({ inputs }) => { seen.setInputs.push(inputs); applied = { ...applied, ...inputs }; loading = true; return { updated_inputs: inputs, missing: [] }; },
      setSymbol: async ({ symbol }) => { chart.symbol = symbol; },
      setTimeframe: async ({ timeframe }) => { chart.resolution = String(timeframe); },
      ensureTesterPanel: async () => ({ ok: true }),
      readTestPeriod: async () => ({ ...chart.periodo }),
      setCustomPeriod: async (from, to) => { seen.periodi.push([from, to]); chart.periodo = { label: `${from} — ${to}`, from, to }; return { applied: true, ...chart.periodo }; },
      attendiReportAggiornato: async () => ({ aggiornato: true, click: 1 }),
      readStrategyLoading: async () => { const l = loading; loading = false; return l; },
      readReportFor: async () => ({ success: true, metrics }),
      readPanelMetrics: async () => ({ success: true, metrics }),
      sleep: async () => {},
    },
  };
}

test('replica symbol, timeframe, periodo, input di logica e Proprieta per id, e riporta il confronto col backtest', async () => {
  const { deps, seen, chart, applied } = makeDeps();
  const out = await applyBacktest({ backtest_id: 1056, command_id: 7 }, deps);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.entity_id, 'ent-1');
  assert.equal(chart.symbol, 'TVC:NDQ');
  assert.equal(chart.resolution, '15');
  assert.deepEqual(seen.periodi, [['2025-09-03', '2026-09-03']]);
  assert.deepEqual(seen.setInputs[0], { in_0: 2, in_1: '60', in_40: 100000, in_44: 0 });
  assert.equal(applied().in_44, 0);
  assert.deepEqual(out.applied, { symbol: 'TVC:NDQ', timeframe: '15', period_applied: '2025-09-03 — 2026-09-03', inputs: 2, properties: 2 });
  assert.deepEqual(out.mismatches, []);
  assert.equal(out.vs_backtest.total_trades_delta, 0);
  assert.equal(out.vs_backtest.net_profit_delta_pct, 0);
  assert.equal(out.metrics.total_trades, 10);
});

test('strategia assente sul chart → ok:false con strategy_not_on_chart, e NON si tocca niente', async () => {
  const { deps, seen, chart } = makeDeps({ studies: [{ id: 'x', name: 'Volume' }] });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, 'strategy_not_on_chart');
  assert.match(out.error.detail, /Volume/);
  assert.equal(seen.setInputs.length, 0);
  assert.equal(chart.symbol, 'EURUSD');
});

test('strategia in errore di runtime → strategy_in_error', async () => {
  const { deps } = makeDeps({ studies: [{ id: 'ent-1', name: 'Index Grow Test Claude', error: 'RE10041' }] });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, 'strategy_in_error');
});

test('input del backtest che la strategia non ha → version_mismatch, e NON si imposta niente', async () => {
  const { deps, seen } = makeDeps({ bt: { ...BT, inputs: { 'Risk/Reward': 2, 'Filtro nuovo': true } } });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, 'version_mismatch');
  assert.match(out.error.detail, /Filtro nuovo/);
  assert.equal(seen.setInputs.length, 0);
});

test('applied_inputs (per id) ha la precedenza sul dizionario per nome', async () => {
  const bt = { ...BT, inputs: { 'Risk/Reward': 999 }, applied_inputs: { in_0: { value: 3, type: 'float', block: 'logic' }, in_40: { value: 50000, type: 'float', block: 'property' } } };
  const { deps, seen } = makeDeps({ bt });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, true);
  assert.equal(seen.setInputs[0].in_0, 3);
  assert.equal(seen.setInputs[0].in_40, 50000);
  assert.deepEqual(out.applied.inputs, 1);
  assert.deepEqual(out.applied.properties, 1);
});

test('una Proprieta che la strategia viva non ha si salta con avviso, non e version_mismatch', async () => {
  const bt = { ...BT, extra_metrics: { properties: { 'Initial Capital': 100000, 'Use Bar Magnifier': false } } };
  const { deps } = makeDeps({ bt });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, true);
  assert.deepEqual(out.properties_skipped, ['Use Bar Magnifier']);
});

test('periodo non applicato → period_not_applied', async () => {
  const { deps } = makeDeps();
  deps.setCustomPeriod = async () => ({ applied: false, error: 'voce non trovata', from: null, to: null, label: null });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, 'period_not_applied');
});

test('readback finale diverso dal richiesto → mismatches con nome, atteso e letto', async () => {
  const { deps } = makeDeps();
  // Il chart "accetta" il set ma rilegge 0.5 su Commission Value: e' il no-op silenzioso.
  deps.readInputValues = async () => ({ in_0: 2, in_1: '60', in_40: 100000, in_44: 0.5 });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, true);
  assert.deepEqual(out.mismatches, [{ id: 'in_44', key: 'Commission Value', expected: 0, actual: 0.5 }]);
});

test('readback: stringa vuota vs 0 e boolean vs numero NON sono uguali; "60" vs 60 si', async () => {
  const bt = { ...BT, inputs: { 'Risk/Reward': 0, 'TF:': 60 }, extra_metrics: { properties: { 'Initial Capital': 1 } } };
  const { deps } = makeDeps({ bt });
  // Number('') === 0 e Number(true) === 1: senza guardia sui tipi passerebbero come uguali.
  deps.readInputValues = async () => ({ in_0: '', in_1: '60', in_40: true, in_44: 0.5 });
  const out = await applyBacktest({ backtest_id: 1056 }, deps);
  assert.equal(out.ok, true);
  assert.deepEqual(out.mismatches, [
    { id: 'in_0', key: 'Risk/Reward', expected: 0, actual: '' },
    { id: 'in_40', key: 'Initial Capital', expected: 1, actual: true },
  ]);
});

test('backtest inesistente → backtest_not_found', async () => {
  const { deps } = makeDeps();
  const out = await applyBacktest({ backtest_id: 1 }, deps);
  assert.equal(out.ok, false);
  assert.equal(out.error.kind, 'backtest_not_found');
});
