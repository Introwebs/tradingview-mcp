import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { misuraProva } from '../src/core/btProva.js';
import { creaCronometro } from '../src/core/cronometro.js';

// Il banco imita `makeDeps` di bt_grind.test.js: chart finto che tiene simbolo, timeframe, periodo e
// input; il modello del backtest esteso non leggibile; `sleep` vuoto. Mancano apposta `api`,
// `captureScreenshot` e `setPanelMaximized`: il nucleo non deve averne bisogno.
function banco({ metricsSeq, metricheFerme = false }) {
  // `call` avanza quando cambia qualcosa (input, symbol, timeframe, periodo), non a ogni lettura.
  let call = 0;
  const metricaCorrente = () => {
    if (call < metricsSeq.length) return metricsSeq[call];
    const ultimo = metricsSeq[metricsSeq.length - 1];
    return metricheFerme ? ultimo : { ...ultimo, net_profit: 100000 + call };
  };
  let applied = { in_0: 1, in_40: 10000 };
  let loadingPending = false;
  const chart = { symbol: 'EURUSD', resolution: '15', periodo: { label: 'Storico completo', from: null, to: null } };
  const now = () => performance.now();
  const deps = {
    setInputs: async ({ inputs }) => { applied = { ...applied, ...inputs }; loadingPending = true; call += 1; return { updated_inputs: inputs, missing: [] }; },
    readInputValues: async () => ({ ...applied }),
    readReportFor: async () => ({ success: true, metrics: metricaCorrente() }),
    readStrategyLoading: async () => {
      if (loadingPending) { loadingPending = false; return true; }
      return false;
    },
    readStudyStatus: async () => ({ ok: true, type: 0, error: null }),
    readCommissionFor: async () => ({ success: false, error: 'stub: commissioni non lette' }),
    setSymbol: async ({ symbol }) => { chart.symbol = symbol; call += 1; return { success: true }; },
    setTimeframe: async ({ timeframe }) => { chart.resolution = String(timeframe); call += 1; return { success: true }; },
    getChartState: async () => ({ symbol: chart.symbol, resolution: chart.resolution }),
    setCustomPeriod: async (from, to) => {
      chart.periodo = { label: `${from} — ${to}`, from, to };
      call += 1;
      return { applied: true, ...chart.periodo };
    },
    readTestPeriod: async () => ({ ...chart.periodo }),
    readPanelMetrics: async () => ({ success: true, source: 'panel', metrics: metricaCorrente() }),
    readPeriodReport: async () => ({ found: false, error: 'stub: report non disponibile' }),
    ensureTesterPanel: async () => ({ ok: true, altezza: 400 }),
    aggiornaReportSeObsoleto: async () => ({ obsoleto: false, cliccato: false }),
    attendiReportAggiornato: async () => ({ aggiornato: true, click: 0 }),
    readDeepState: async () => ({ found: false }),
    reportObsoleto: async () => false,
    sleep: async () => {},
    now,
  };
  const amb = {
    entity_id: 'ent-1',
    info: [
      { id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Ingressi' },
      { id: 'in_40', name: 'Initial Capital', type: 'float', group: null },
    ],
    idsCommissione: null,
    stato: { prevFp: null, snapshotCommissione: null },
    deps,
    opzioni: { recalc_timeout_ms: 50, recalc_stable_checks: 1, recalc_step_ms: 1, recalc_start_grace_ms: 5 },
    cron: creaCronometro(now),
    nota: async () => {},
    leggiPadre: async () => null,
  };
  return { amb, chart };
}

const M = (over = {}) => ({
  net_profit: 100, net_profit_percent: 1, max_drawdown: 10, max_drawdown_percent: 0.5,
  profit_factor: 1.5, total_trades: 20, percent_profitable: 50,
  ...over,
});

test('una prova misurata torna coi numeri e gli input riletti, senza toccare nessuna API', async () => {
  const { amb } = banco({ metricsSeq: [M(), M({ net_profit: 200 })] });
  const out = await misuraProva({ id: 't1', symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } }, amb);
  assert.equal(out.uscita, 'misurata');
  assert.equal(out.metricheFinali.net_profit, 200);
  assert.equal(out.actual.in_0, 2);
});

test('zero trade e contesto non applicato sono esiti, non eccezioni', async () => {
  const z = banco({ metricsSeq: [M(), M({ total_trades: 0, net_profit: 0 })] });
  assert.equal((await misuraProva({ id: 't1', symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } }, z.amb)).uscita, 'zero_trade');

  const c = banco({ metricsSeq: [M()] });
  c.amb.deps.setSymbol = async () => ({ success: true });   // il chart non cambia simbolo
  const out = await misuraProva({ id: 't2', symbol: 'GBPUSD', timeframe: '15', input_set: {} }, c.amb);
  assert.deepEqual([out.uscita, out.problema.kind], ['contesto', 'symbol_not_applied']);
});

test('il nucleo non conosce ne la piattaforma ne i salvataggi', () => {
  const src = readFileSync(new URL('../src/core/btProva.js', import.meta.url), 'utf8');
  for (const vietato of [/\bapi\./, /captureScreenshot/, /setPanelMaximized/, /stageEquity/, /finalize\(/, /pinealgos\.js/]) {
    assert.equal(vietato.test(src), false, `btProva.js non deve contenere ${vietato}`);
  }
});
