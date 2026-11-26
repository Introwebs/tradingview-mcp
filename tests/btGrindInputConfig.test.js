/**
 * Una run scritta PER NOME E POSIZIONE (`input_config`, la run del finalista di una campagna): la
 * piattaforma non conosce gli id `in_K`, quindi `bt_grind` la risolve sul grafico con la stessa mappa
 * dello strumento di fase (btMappa.js). Le run di oggi — `input_set` per id — non passano di qui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grindSession } from '../src/core/backtest.js';
import { creaTesterFinto } from './helpers/testerFinto.js';

const P1 = { from: '2022-12-08', to: '2023-12-08' };
const P4 = { from: '2020-01-01', to: '2023-12-08' };
// RR target 2, Rischio 1: gli input che il grafico ha prima della run.
const BASE = { in_0: 2, in_1: 1, in_9: true, in_40: 10000 };

const INFO = [
  { id: 'in_0', name: 'RR target', type: 'float', group: 'Uscite' },
  { id: 'in_1', name: 'Rischio', type: 'float', group: 'Rischio' },
  { id: 'in_9', name: 'Mostra linee', type: 'bool', group: 'Grafica' },
  { id: 'in_40', name: 'Initial Capital', type: 'float', group: null },
];

// Metriche che dipendono da ENTRAMBI gli input di logica: una run che cambia solo il Rischio deve
// produrre numeri suoi, non quelli della configurazione di prima.
const metriche = (p, i, tf) => ({
  net_profit: 1000 + Number(i.in_0) * 100 + Number(i.in_1) * 7 + Number(p.from.slice(0, 4)) + Number(tf),
  net_profit_percent: 0.01, max_drawdown: 10, max_drawdown_percent: 0.005,
  profit_factor: 1.5,
  total_trades: 100 + Math.round(Number(i.in_0) * 10) + Number(i.in_1) * 3 + Number(p.from.slice(2, 4)) + Number(tf) * 3,
  percent_profitable: 0.5,
});

function deps({ runs, tv, setInputsExtra = null }) {
  const queue = [...runs];
  const finalized = [];
  const failed = [];
  const progress = [];
  const setCalls = [];
  const toccate = { setCustomPeriod: 0, setTimeframe: 0, setSymbol: 0 };
  const d = {
    api: {
      nextRun: async () => queue.shift() ?? null,
      markRunning: async () => ({}),
      markFailed: async (id, motivo) => { failed.push({ id, motivo }); return {}; },
      reclaimRun: async () => ({}),
      listRuns: async () => [],
      stageEquity: async () => ({}),
      finalize: async (runId, payload) => { finalized.push({ runId, payload }); return { data: { id: runId * 10 } }; },
      progress: async (_c, msg) => { progress.push(String(msg)); return null; },
      sessionDigest: async (id) => ({ data: { session: { id }, compact: true, groups: [], moves: { total: 0, omitted: 0, items: [] } } }),
    },
    setInputs: async ({ inputs }) => {
      setCalls.push({ ...inputs });
      tv.setInputs(inputs);
      if (setInputsExtra) tv.setInputs(setInputsExtra);
      return { updated_inputs: inputs, missing: [] };
    },
    readInputValues: async () => ({ ...tv.stato.inputs }),
    readInputsInfo: async () => INFO.map((x) => ({ ...x })),
    readPanelMetrics: async () => ({ success: true, source: 'panel', metrics: tv.metricheMostrate() }),
    readReportFor: async () => ({ success: true, metrics: tv.metricheMostrate() }),
    readStrategyLoading: async () => tv.strategiaInCaricamento(),
    readStudyStatus: async () => ({ ok: true, type: 0, error: null }),
    readPeriodReport: async () => ({ found: false, error: 'stub' }),
    ensureTesterPanel: async () => ({ ok: true, altezza: 400 }),
    ensureVisibleFor: async () => ({ found: true, wasHidden: false, visible: true }),
    setStrategyVisibility: async () => true,
    getChartState: async () => ({ symbol: 'TVC:DJI', resolution: tv.stato.timeframe }),
    setSymbol: async () => { toccate.setSymbol++; return { success: true }; },
    setTimeframe: async ({ timeframe }) => { toccate.setTimeframe++; tv.setTimeframe(timeframe); return { success: true }; },
    readTestPeriod: async () => ({ label: `${tv.stato.periodo.from} — ${tv.stato.periodo.to}`, ...tv.stato.periodo }),
    setCustomPeriod: async (from, to) => { toccate.setCustomPeriod++; tv.setPeriodo({ from, to }); return { applied: true, label: `${from} — ${to}`, from, to }; },
    captureScreenshot: async () => ({ file_path: '/tmp/shot.png' }),
    setPanelMaximized: async (m) => ({ ok: true, prima: m ? 'normal' : 'maximized' }),
    aggiornaReportSeObsoleto: async () => tv.cliccaAggiorna(),
    attendiReportAggiornato: async () => {
      let click = 0;
      await tv.sleep(500);
      for (;;) {
        const e = tv.cliccaAggiorna();
        if (e.cliccato) click += 1;
        else if (!tv.reportObsoleto()) return { aggiornato: true, click };
        await tv.sleep(1000);
      }
    },
    readDeepState: async () => tv.readDeepState(),
    reportObsoleto: async () => tv.reportObsoleto(),
    sleep: tv.sleep,
    now: tv.now,
  };
  return { deps: d, finalized, failed, progress, setCalls, toccate };
}

// La forma che la piattaforma da' alla run del finalista: `input_set` vuoto (PHP lo serializza `[]`).
const runPerNome = (id, input_config, extra = {}) => ({
  id, symbol: 'TVC:DJI', timeframe: '5', period_start: P4.from, period_end: P4.to,
  input_set: [], input_config, label: 'Finalista', attempts: 0, ...extra,
});

const tester = () => creaTesterFinto({ periodo: P1, inputs: BASE, durataMs: 5000, metriche });

test('run per nome: setInputs riceve solo i due id giusti e il backtest porta i numeri della configurazione', async () => {
  const tv = tester();
  const config = [
    { name: 'RR target', position: 1, value: 3 },
    { name: 'Rischio', position: 1, value: 2 },
  ];
  const { deps: d, finalized, failed, setCalls } = deps({ tv, runs: [runPerNome(1, config)] });

  const out = await grindSession({ session_id: 90, entity_id: 'ent1' }, d);

  assert.equal(out.stopped_reason, null, JSON.stringify(out.stopped_reason));
  assert.deepEqual(failed, []);
  assert.deepEqual(setCalls, [{ in_0: 3, in_1: 2 }]);
  assert.equal(finalized.length, 1);
  const p = finalized[0].payload;
  assert.equal(p.inputs['RR target'], 3);
  assert.equal(p.inputs['Rischio'], 2);
  const vero = tv.metricheDi(P4, { ...BASE, in_0: 3, in_1: 2 }, '5');
  assert.equal(p.total_trades, vero.total_trades);
  assert.equal(p.net_profit, vero.net_profit);
});

test('run per nome: un valore gia\' sul grafico non si riscrive (si spedisce solo il delta)', async () => {
  const tv = tester();
  const config = [
    { name: 'RR target', position: 1, value: 2 },
    { name: 'Rischio', position: 1, value: 2 },
  ];
  const { deps: d, finalized, setCalls } = deps({ tv, runs: [runPerNome(1, config)] });

  const out = await grindSession({ session_id: 90, entity_id: 'ent1' }, d);

  assert.equal(out.stopped_reason, null, JSON.stringify(out.stopped_reason));
  assert.deepEqual(setCalls, [{ in_1: 2 }]);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].payload.inputs['RR target'], 2);
  assert.equal(finalized[0].payload.inputs['Rischio'], 2);
});

test('run per nome con un nome che il grafico non ha: failed unknown_input coi nomi, grafico mai toccato', async () => {
  const tv = tester();
  const config = [
    { name: 'RR target', position: 1, value: 3 },
    { name: 'Filtro sessione', position: 1, value: true },
  ];
  const { deps: d, finalized, failed, setCalls, toccate } = deps({ tv, runs: [runPerNome(7, config)] });

  const out = await grindSession({ session_id: 90, entity_id: 'ent1' }, d);

  assert.deepEqual(setCalls, [], 'setInputs non deve essere chiamato');
  assert.deepEqual(toccate, { setCustomPeriod: 0, setTimeframe: 0, setSymbol: 0 }, 'il contesto non deve essere toccato');
  assert.equal(finalized.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 7);
  assert.match(failed[0].motivo, /^unknown_input: /);
  assert.match(failed[0].motivo, /Filtro sessione/);
  assert.doesNotMatch(failed[0].motivo, /RR target/);
  assert.equal(out.stopped_reason?.kind, 'unknown_input');
  assert.deepEqual(out.stopped_reason.unknown_inputs, ['Filtro sessione']);
  assert.equal(out.failed, 1);
  assert.equal(out.rows[0].status, 'failed');
  assert.match(out.rows[0].error, /^unknown_input: /);
});

test('run con input_set pieno e input_config presente: vince input_set, come oggi', async () => {
  const tv = tester();
  const run = runPerNome(1, [{ name: 'RR target', position: 1, value: 3 }], { input_set: { in_0: 4 } });
  const { deps: d, finalized, failed, setCalls } = deps({ tv, runs: [run] });

  const out = await grindSession({ session_id: 90, entity_id: 'ent1' }, d);

  assert.equal(out.stopped_reason, null, JSON.stringify(out.stopped_reason));
  assert.deepEqual(failed, []);
  assert.deepEqual(setCalls, [{ in_0: 4 }]);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].payload.inputs['RR target'], 4);
});

test('run per nome: il readback si controlla su TUTTA la configurazione, non solo sul delta', async () => {
  const tv = tester();
  // Il Rischio e' gia' 1, quindi non e' nel delta; ma il set lo sposta a 5 (lo simula
  // `setInputsExtra`): il controllo sul solo delta non lo vedrebbe.
  const config = [
    { name: 'RR target', position: 1, value: 3 },
    { name: 'Rischio', position: 1, value: 1 },
  ];
  const { deps: d, finalized, failed, setCalls } = deps({ tv, runs: [runPerNome(4, config)], setInputsExtra: { in_1: 5 } });

  const out = await grindSession({ session_id: 90, entity_id: 'ent1' }, d);

  assert.deepEqual(setCalls, [{ in_0: 3 }]);
  assert.equal(finalized.length, 0, 'una configurazione non applicata per intero non si registra');
  assert.equal(failed.length, 1);
  assert.match(failed[0].motivo, /^readback_mismatch: /);
  assert.equal(out.stopped_reason?.kind, 'readback_mismatch');
});
