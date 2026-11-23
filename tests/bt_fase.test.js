import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eseguiFase, dentroIlConfine } from '../src/core/btFase.js';
import { banco, STATO, M } from './helpers/bancoFase.js';

const tre = [2, 3, 4].map((v) => ({ inputs: [{ name: 'Risk/Reward', value: v }] }));

test('esegue le prove, manda le righe e restituisce solo la tabella', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);

  assert.deepEqual([out.executed, out.failed, out.remaining_in_phase, out.stopped_reason], [3, 0, 0, null]);
  assert.equal(out.table.phase.position, 2);
  assert.equal('rows' in out, false);
  const righe = b.visto.inviate[0].rows;
  assert.deepEqual(righe.map((r) => [r.key, r.status, r.period_end]), [['t1', 'measured', '2024-01-01'], ['t2', 'measured', '2024-01-01'], ['t3', 'measured', '2024-01-01']]);
  assert.deepEqual(righe[0].config, [{ name: 'Risk/Reward', position: 1, value: 2 }]);
  assert.deepEqual(Object.keys(righe[0].metrics).sort(), ['max_drawdown', 'max_drawdown_pct', 'net_profit', 'net_profit_pct', 'profit_factor', 'sharpe', 'sortino', 'total_trades', 'win_rate']);
  assert.equal(b.registro.leggi(9), null, 'consegnate: il file locale sparisce');
});

test('una prova che tocca il periodo riservato ferma tutto prima di dichiarare la fase', async () => {
  const b = banco({ metricsSeq: [M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', entity_id: 'ent1',
    trials: [tre[0], { ...tre[1], period_start: '2018-01-01', period_end: '2024-01-02' }] }, b.deps);
  assert.equal(out.stopped_reason.kind, 'outside_search_interval');
  assert.deepEqual([out.executed, b.visto.open.length, b.visto.inviate.length, b.chart.setInputsChiamate], [0, 0, 0, 0]);
});

test('piu prove di quelle rimaste: nessuna parte', async () => {
  const b = banco({ stato: { ...STATO, budget: { remaining: 100, remaining_exploration: 2 } }, metricsSeq: [M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.stopped_reason.kind, out.executed, b.visto.open.length], ['budget_exceeded', 0, 0]);

  const h = banco({ stato: { ...STATO, budget: { remaining: 100, remaining_exploration: 2 } }, metricsSeq: [M(), M({ net_profit: 2 }), M({ net_profit: 3 }), M({ net_profit: 4 })] });
  assert.equal((await eseguiFase({ campaign_id: 3, type: 'hold', trials: tre, entity_id: 'ent1' }, h.deps)).executed, 3);
});

test('mappa che non coincide col grafico: fermo, niente dichiarato', async () => {
  const b = banco({ stato: { ...STATO, map: { inputs: [...STATO.map.inputs, { name: 'Trailing', position: 1, type: 'float', group: 'management' }] } }, metricsSeq: [M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.stopped_reason.kind, out.stopped_reason.mancanti[0].name, b.visto.open.length], ['map_mismatch', 'Trailing', 0]);
});

test('il rifiuto del server alla dichiarazione torna col suo motivo', async () => {
  const b = banco({ metricsSeq: [M()], apiOver: { openPhase: async () => ({ ok: false, status: 409, reason_code: 'phase_open', message: 'C è una fase ancora aperta.', data: { phase_id: 8 } }) } });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.stopped_reason.kind, out.stopped_reason.phase_id, out.executed], ['phase_open', 8, 0]);
});

test('zero trade e un dato; tre di fila fermano la fase e le prove fatte restano', async () => {
  const Z = M({ total_trades: 0, net_profit: 0 });
  const b = banco({ metricsSeq: [M(), Z, Z, Z, M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', entity_id: 'ent1',
    trials: [2, 3, 4, 5].map((v) => ({ inputs: [{ name: 'Risk/Reward', value: v }] })) }, b.deps);
  assert.deepEqual([out.zero_trades, out.stopped_reason.kind, out.remaining_in_phase], [3, 'zero_trades_systemic', 1]);
  assert.deepEqual(b.visto.inviate[0].rows.map((r) => r.status), ['zero_trades', 'zero_trades', 'zero_trades']);
  assert.equal(b.visto.inviate[0].stopped_reason.kind, 'zero_trades_systemic');
});

test('un fermo a meta lascia registrate le prove gia fatte', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })] });
  let n = 0;
  const vero = b.deps.setInputs;
  b.deps.setInputs = async (a) => { n += 1; return n === 2 ? { updated_inputs: {}, missing: ['in_0'] } : vero(a); };
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.executed, out.failed, out.stopped_reason.kind], [1, 1, 'inputs_not_applied']);
  assert.deepEqual(b.visto.inviate[0].rows.map((r) => r.status), ['measured', 'failed']);
});

test('piattaforma irraggiungibile: le righe restano in locale e la ripresa non riesegue niente', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })],
    apiOver: { sendTrials: async () => { throw new Error('POST … → fetch failed'); } } });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.pending_file, out.stopped_reason.kind, out.table], [true, 'platform_unreachable', null]);
  assert.equal(b.registro.leggi(9).rows.length, 3);

  const r = banco({ metricsSeq: [M()], registro: b.registro,
    fase: { id: 9, position: 2, type: 'management', symbol: 'TVC:NDQ', trials: ['t1', 't2', 't3'].map((key) => ({ key, status: 'pending', period_start: '2018-01-01', period_end: '2024-01-01', inputs: [] })) } });
  const ripresa = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, r.deps);
  assert.deepEqual([ripresa.executed, r.chart.setInputsChiamate, r.visto.inviate[0].rows.length, ripresa.remaining_in_phase], [0, 0, 3, 0]);
  assert.equal(r.registro.leggi(9), null);
});

test('tempo scaduto: la chiamata si chiude e la ripresa esegue solo le prove mancanti', async () => {
  let t = 0;
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 })] });
  b.deps.now = () => (t += 400);   // ogni lettura dell'orologio avanza di 400 ms
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1', time_budget_ms: 1 }, b.deps);
  assert.equal(out.executed, 1, 'la prima prova parte sempre');
  assert.deepEqual([out.remaining_in_phase, out.stopped_reason], [2, null]);

  const r = banco({ metricsSeq: [M(), M({ net_profit: 500 }), M({ net_profit: 600 })],
    fase: { id: 9, position: 2, type: 'management', symbol: 'TVC:NDQ', trials: [
      { key: 't1', status: 'measured', period_start: '2018-01-01', period_end: '2024-01-01', inputs: [{ name: 'Risk/Reward', position: 1, value: 2 }] },
      { key: 't2', status: 'pending', period_start: '2018-01-01', period_end: '2024-01-01', inputs: [{ name: 'Risk/Reward', position: 1, value: 3 }] },
      { key: 't3', status: 'failed', period_start: '2018-01-01', period_end: '2024-01-01', inputs: [{ name: 'Risk/Reward', position: 1, value: 4 }] }] } });
  const ripresa = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, r.deps);
  assert.deepEqual(r.visto.inviate[0].rows.map((x) => x.key), ['t2', 't3']);
  assert.equal(ripresa.executed, 2);
});

test('la base manda le Proprieta e non fa nessun salvataggio da backtest', async () => {
  const b = banco({ stato: { ...STATO, working_config: null }, metricsSeq: [M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'base', trials: [{}], entity_id: 'ent1' }, b.deps);
  assert.equal(out.executed, 1);
  assert.equal(b.visto.inviate[0].properties['Initial Capital'], 10000);
  assert.deepEqual(b.visto.altreChiamate, [], 'nessun markRunning, stageEquity, finalize');
});

test('il progress parla per fasi e per prove, non per ogni passo', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })] });
  await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1', command_id: 5 }, b.deps);
  assert.equal(b.visto.progress.length, 2);
  assert.match(b.visto.progress[0], /^Fase gestione: 3 prove$/);
  assert.match(b.visto.progress[1], /^Fase gestione: 3 prove in /);
});

// --- Ripresa: il file locale e la fase devono essere di QUESTA campagna -------------------------

const RICERCA = { period_start: '2018-01-01', period_end: '2024-01-01' };
const faseDa = (trials, extra = {}) => ({ id: 9, campaign_id: 3, position: 2, type: 'management', symbol: 'TVC:NDQ', table: null, decision: null, trials, ...extra });
const provaDa = (key, status, value) => ({ key, status, ...RICERCA, inputs: value === undefined ? [] : [{ name: 'Risk/Reward', position: 1, value }] });
const rigaMisurata = (key, value) => ({ key, status: 'measured', ...RICERCA, config: [{ name: 'Risk/Reward', position: 1, value }], metrics: {}, metrics_source: 'panel' });

test('un file locale di un altra campagna non si consegna: si mette da parte e le prove si eseguono', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 })],
    fase: faseDa([provaDa('t1', 'pending', 2), provaDa('t2', 'pending', 3)]) });
  b.registro.scrivi(9, { campaign_id: 77, rows: [rigaMisurata('t1', 9), rigaMisurata('t2', 9)] });

  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);

  assert.equal(out.discarded_local_file, true);
  assert.equal(b.visto.inviate.length, 1, 'una sola consegna: quella delle prove eseguite ora');
  assert.deepEqual(b.visto.inviate[0].rows.map((r) => [r.key, r.config[0].value]), [['t1', 2], ['t2', 3]]);
  assert.deepEqual([out.executed, out.remaining_in_phase], [2, 0]);
  assert.equal(b.registro.scartati[0].campaign_id, 77, 'messo da parte, non cancellato');
});

test('un file locale con prove che la fase non ha non si consegna', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })], fase: faseDa([provaDa('a', 'pending', 2)]) });
  b.registro.scrivi(9, { campaign_id: 3, rows: [rigaMisurata('t1', 2)] });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.equal(out.discarded_local_file, true);
  assert.deepEqual(b.visto.inviate.map((c) => c.rows.map((r) => r.key)), [['a']]);
});

test('il file locale giusto si consegna ancora, e il risultato non dice di averlo scartato', async () => {
  const b = banco({ metricsSeq: [M()], fase: faseDa([provaDa('t1', 'pending', 2)]) });
  b.registro.scrivi(9, { campaign_id: '3', rows: [rigaMisurata('t1', 2)] });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.discarded_local_file, out.executed, b.visto.inviate.length, b.chart.setInputsChiamate], [false, 0, 1, 0]);
});

test('una fase di un altra campagna non si riprende: fermo prima di toccare il grafico', async () => {
  const b = banco({ metricsSeq: [M()], fase: faseDa([provaDa('t1', 'pending', 2)], { campaign_id: 55 }) });
  b.registro.scrivi(9, { campaign_id: 55, rows: [rigaMisurata('t1', 2)] });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'phase_not_in_campaign');
  assert.match(out.stopped_reason.detail, /campagna 55/);
  assert.deepEqual([out.executed, b.visto.inviate.length, b.chart.setInputsChiamate], [0, 0, 0]);
  assert.equal(b.registro.leggi(9).campaign_id, 55, 'il file della fase resta a chi appartiene');
});

test('una fase gia decisa non si riprende', async () => {
  const b = banco({ metricsSeq: [M()], fase: faseDa([provaDa('t1', 'failed', 2)], { decision: { adopt: [], reason: 'x' } }) });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'already_decided');
  assert.deepEqual([out.executed, b.visto.inviate.length, b.chart.setInputsChiamate], [0, 0, 0]);
});

test('alla ripresa prima le prove da fare, per ultime quelle fallite', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })],
    fase: faseDa([provaDa('t1', 'failed', 2), provaDa('t2', 'pending', 3), provaDa('t3', 'pending', 4)]) });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1', max_trials_per_call: 2 }, b.deps);
  assert.deepEqual(b.visto.inviate[0].rows.map((r) => r.key), ['t2', 't3']);
  assert.equal(out.remaining_in_phase, 1);
});

test('una ripresa senza niente da eseguire restituisce la tabella salvata e le prove rimaste', async () => {
  const tabella = { phase: { position: 2 }, inputs: [] };
  const b = banco({ metricsSeq: [M()], fase: faseDa([provaDa('t1', 'measured', 2)], { table: tabella }) });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.executed, out.remaining_in_phase, out.stopped_reason], [0, 0, null]);
  assert.deepEqual(out.table, tabella);
  assert.deepEqual(out.budget, STATO.budget);
});

test('il confine: entrambe le date, nel formato giusto, dentro il periodo di ricerca', () => {
  const c = { search_from: '2018-01-01', search_until: '2024-01-01' };
  assert.equal(dentroIlConfine(c, '2018-01-01', '2024-01-01'), true);
  assert.equal(dentroIlConfine(c, '2019-03-01', '2019-02-01'), false, 'inizio dopo la fine');
  assert.equal(dentroIlConfine(c, '2017-12-31', '2020-01-01'), false);
  assert.equal(dentroIlConfine(c, '2018-01-01', '2024-01-02'), false);
  assert.equal(dentroIlConfine(c, '2018-01-01', null), false);
  assert.equal(dentroIlConfine(c, '2018-01-01', '2024-01-01T00:00:00Z'), false, 'niente orari: solo YYYY-MM-DD');
  assert.equal(dentroIlConfine(null, '2018-01-01', '2020-01-01'), false);
});
