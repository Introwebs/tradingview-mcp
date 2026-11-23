import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  // Grazia di avvio corta: la prova che non applica gli input aspetterebbe 5 s veri un ricalcolo che non parte.
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1', recalc_start_grace_ms: 20 }, b.deps);
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
  // Grazia di avvio corta: la base non cambia input e aspetterebbe 5 s veri un ricalcolo che non serve.
  const out = await eseguiFase({ campaign_id: 3, type: 'base', trials: [{}], entity_id: 'ent1', recalc_start_grace_ms: 20 }, b.deps);
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

test('una fase di un altra campagna non porta la sua tabella accanto al budget di questa', async () => {
  const b = banco({ metricsSeq: [M()], fase: faseDa([provaDa('t1', 'measured', 2)], { campaign_id: 55, table: { altrui: true } }) });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'phase_not_in_campaign');
  assert.deepEqual([out.table, out.budget], [null, null]);
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

// --- Consegna: rifiuti, guasti e fermi -----------------------------------------------------------

const Z = M({ total_trades: 0, net_profit: 0 });

test('un rifiuto senza motivo della piattaforma (422 di forma) non butta le righe', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })],
    apiOver: { sendTrials: async () => ({ ok: false, status: 422, message: 'The rows.0.period_start field is required.', data: null }) } });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'http_422');
  assert.match(out.stopped_reason.detail, /HTTP 422/);
  assert.match(out.stopped_reason.detail, /The rows\.0\.period_start field is required\./);
  assert.match(out.stopped_reason.detail, /richiama bt_phase con phase_id 9/);
  assert.deepEqual([out.pending_file, out.remaining_in_phase, out.table], [true, 3, null]);
  assert.equal(b.registro.leggi(9).rows.length, 3, 'il file resta');
  assert.match(b.visto.progress.at(-2), /la piattaforma ha rifiutato/);
});

test('un rifiuto nel merito (holdout_breach) cancella il file, e nessuna prova risulta fatta', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })],
    apiOver: { sendTrials: async () => ({ ok: false, status: 422, reason_code: 'holdout_breach', message: 'La prova «t2» è stata misurata sul periodo…', data: { key: 't2' } }) } });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.stopped_reason.kind, out.pending_file, out.remaining_in_phase], ['holdout_breach', false, 3]);
  assert.equal(b.registro.leggi(9), null);
});

test('alla ripresa un rifiuto del file locale lascia tutte le prove senza risultato', async () => {
  const b = banco({ metricsSeq: [M()], fase: faseDa([provaDa('t1', 'pending', 2), provaDa('t2', 'pending', 3)]),
    apiOver: { sendTrials: async () => ({ ok: false, status: 409, reason_code: 'campaign_blocked', message: 'La campagna è bloccata.' }) } });
  b.registro.scrivi(9, { campaign_id: 3, rows: [rigaMisurata('t1', 2)] });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.stopped_reason.kind, out.remaining_in_phase, b.chart.setInputsChiamate], ['campaign_blocked', 2, 0]);
});

test('un periodo che non si rilegge non diventa una riga: prova fallita e fermo', async () => {
  const b = banco({ metricsSeq: [M(), Z] });
  const leggi = b.deps.readTestPeriod;
  b.deps.readTestPeriod = async () => (b.chart.setInputsChiamate > 0 ? { label: '', from: null, to: null } : leggi());
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: [tre[0]], entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'period_unreadable');
  assert.deepEqual([out.zero_trades, out.failed], [0, 1]);
  const riga = b.visto.inviate[0].rows[0];
  assert.deepEqual([riga.status, 'period_start' in riga], ['failed', false]);
});

test('se la consegna finale fallisce il fermo del ciclo resta dentro quello nuovo', async () => {
  const b = banco({ metricsSeq: [M(), Z, Z, Z],
    apiOver: { sendTrials: async () => { throw new Error('POST … → fetch failed'); } } });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'platform_unreachable');
  assert.deepEqual([out.stopped_reason.previous.kind, out.stopped_reason.previous.trial], ['zero_trades_systemic', 't3']);
  assert.match(out.stopped_reason.previous.detail, /senza alcun trade/);
});

test('ripresa: consegna del file riuscita e consegna finale fallita, nessuna tabella vecchia', async () => {
  let n = 0;
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })],
    fase: faseDa([provaDa('t1', 'pending', 2), provaDa('t2', 'pending', 3)]),
    apiOver: { sendTrials: async () => { n += 1; if (n === 2) throw new Error('fetch failed'); return { ok: true, data: { table: { vecchia: true }, budget: { remaining: 1 } } }; } } });
  b.registro.scrivi(9, { campaign_id: 3, rows: [rigaMisurata('t1', 2)] });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.executed, out.stopped_reason.kind, out.table, out.budget], [1, 'platform_unreachable', null, null]);
});

test('dopo 13 minuti la consegna non aspetta la piattaforma: le righe restano in locale', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })] });
  b.deps.now = () => (b.chart.setInputsChiamate > 0 ? 800000 : 0);
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.executed, b.visto.inviate.length, out.pending_file, out.stopped_reason.kind], [1, 0, true, 'platform_unreachable']);
  assert.equal(b.registro.leggi(9).rows.length, 1);
});

test('un fermo che non si spiega da solo dice cosa fare', async () => {
  const b = banco({ metricsSeq: [M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', entity_id: 'ent1',
    trials: [{ inputs: [{ name: 'Sconosciuto', value: 1 }] }] }, b.deps);
  assert.equal(out.stopped_reason.kind, 'unknown_input');
  assert.match(out.stopped_reason.detail, /richiama bt_phase con phase_id 9/);
  assert.match(out.stopped_reason.detail, /registra la decisione della fase/);
});

test('lo studio rotto all avvio ferma la fase anche se il progress non risponde', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })],
    apiOver: { progress: async (_c, msg) => { if (String(msg).startsWith('⛔')) throw new Error('progress giu'); return null; } } });
  b.deps.readStudyStatus = async () => ({ ok: false, type: 1, error: 'division by zero' });
  await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps).catch(() => null);
  assert.equal(b.chart.setInputsChiamate, 0, 'nessuna prova eseguita');
});

test('il progress dei fermi parla di prove, non di run', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })] });
  let n = 0;
  const vero = b.deps.setInputs;
  b.deps.setInputs = async (a) => { n += 1; return n === 2 ? { updated_inputs: {}, missing: ['in_0'] } : vero(a); };
  await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1', recalc_start_grace_ms: 10 }, b.deps);
  const fermo = b.visto.progress.find((p) => p.startsWith('⛔'));
  assert.match(fermo, /input della prova/);
  assert.doesNotMatch(fermo, /\brun\b|symbol|timeframe/);
});

test('una fase gia aperta: il fermo dice quale fase riprendere', async () => {
  const b = banco({ metricsSeq: [M()], apiOver: { openPhase: async () => ({ ok: false, status: 409, reason_code: 'phase_open', message: "C'è già una fase con prove da fare.", data: { phase_id: 8 } }) } });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.match(out.stopped_reason.detail, /richiama bt_phase con phase_id 8/);
});

test('un rifiuto di forma alla dichiarazione arriva in italiano', async () => {
  const b = banco({ metricsSeq: [M()], apiOver: { openPhase: async () => ({ ok: false, status: 422, message: 'The trials.0.inputs.0.value field must be present.' }) } });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'http_422');
  assert.match(out.stopped_reason.detail, /^La piattaforma ha rifiutato la dichiarazione della fase \(HTTP 422\)/);
  assert.match(b.visto.progress.at(-1), /la piattaforma ha rifiutato/);
});

// --- Identita' del mercato -----------------------------------------------------------------------

test('il mercato senza borsa si dichiara con la scrittura della campagna', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1', symbol: 'NDQ' }, b.deps);
  assert.equal(b.visto.open[0].symbol, 'TVC:NDQ');
  assert.equal(out.executed, 3);
});

test('un mercato con un altra borsa dichiarata non e quello della campagna', async () => {
  const b = banco({ metricsSeq: [M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1', symbol: 'FX:NDQ' }, b.deps);
  assert.deepEqual([out.stopped_reason.kind, b.visto.open.length], ['unknown_symbol', 0]);
});

/** Il banco con l'ordine delle chiamate a setSymbol e ensureTesterPanel registrato in `ordine`. */
function bancoConOrdine(opzioni) {
  const b = banco(opzioni);
  const ordine = [];
  const { setSymbol, ensureTesterPanel } = b.deps;
  b.deps.setSymbol = async (a) => { ordine.push(`setSymbol ${a.symbol}`); return setSymbol(a); };
  b.deps.ensureTesterPanel = async () => { ordine.push('ensureTesterPanel'); return ensureTesterPanel(); };
  return { ...b, ordine };
}

test('grafico su un altro ticker: il cambio di mercato lo fa il nucleo, con le sue guardie', async () => {
  const b = bancoConOrdine({ simboloGrafico: 'FX:EURUSD', metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(b.ordine[0], 'ensureTesterPanel', 'btFase non cambia simbolo prima di passare la prova al nucleo');
  assert.ok(b.ordine.includes('setSymbol TVC:NDQ'), 'il nucleo porta il grafico sul mercato della campagna');
  assert.equal(b.chart.symbol, 'TVC:NDQ');
  assert.deepEqual([out.executed, out.stopped_reason], [3, null]);
});

test('stesso ticker su un altra borsa dichiarata: fermo prima di dichiarare, niente cambiato ne misurato', async () => {
  const b = bancoConOrdine({ simboloGrafico: 'OANDA:NDQ', metricsSeq: [M()] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'symbol_not_applied');
  assert.match(out.stopped_reason.detail, /OANDA:NDQ/);
  assert.match(out.stopped_reason.detail, /TVC:NDQ/);
  assert.deepEqual([out.executed, b.visto.open.length, b.ordine.length, b.chart.setInputsChiamate], [0, 0, 0, 0]);
  assert.equal(b.chart.symbol, 'OANDA:NDQ');
});

test('stesso ticker su un altra borsa alla ripresa: fermo prima di consegnare il file o toccare il grafico', async () => {
  const b = bancoConOrdine({ simboloGrafico: 'OANDA:NDQ', metricsSeq: [M()], fase: faseDa([provaDa('t1', 'pending', 2), provaDa('t2', 'pending', 3)]) });
  b.registro.scrivi(9, { campaign_id: 3, rows: [rigaMisurata('t1', 2)] });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'symbol_not_applied');
  assert.match(out.stopped_reason.detail, /richiama bt_phase con phase_id 9/);
  assert.deepEqual([out.executed, b.visto.inviate.length, b.ordine.length, b.chart.setInputsChiamate], [0, 0, 0, 0]);
  assert.equal(b.registro.leggi(9).rows.length, 1, 'il file resta per la ripresa');
});

test('un mercato scritto senza borsa da un lato e lo stesso mercato: nessun fermo, nessun cambio', async () => {
  const b = bancoConOrdine({ simboloGrafico: 'NDQ', metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })] });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.deepEqual([out.executed, out.stopped_reason], [3, null]);
  assert.equal(b.ordine.some((o) => o.startsWith('setSymbol')), false);
});

test('una campagna senza timeframe non si esegue', async () => {
  const b = banco({ stato: { ...STATO, timeframe: '' }, metricsSeq: [M()] });
  await assert.rejects(eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps), /timeframe/);
  assert.equal(b.visto.open.length, 0);
});

test('le chiamate di avvio che non arrivano salgono marcate, le altre eccezioni no', async () => {
  const giu = async () => { throw new Error('GET … → fetch failed'); };
  for (const apiOver of [{ campaignState: giu }, { getPhase: giu }]) {
    const b = banco({ metricsSeq: [M()], apiOver, fase: faseDa([provaDa('t1', 'pending', 2)]) });
    await assert.rejects(eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps), (e) => e.piattaforma_all_avvio === true);
  }
  const o = banco({ metricsSeq: [M()], apiOver: { openPhase: giu } });
  await assert.rejects(eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, o.deps), (e) => e.piattaforma_all_avvio === true);

  const p = banco({ metricsSeq: [M()] });
  p.deps.ensureTesterPanel = async () => ({ ok: false, error: 'pannello chiuso' });
  await assert.rejects(eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, p.deps), (e) => !e.piattaforma_all_avvio);
});

// --- Copertura: periodo dichiarato, ripresa con prove fallite, uscite del nucleo, visibilita' ----

test('il periodo esplicito di una prova arriva com e alla dichiarazione, quello assente e il periodo di ricerca', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 })] });
  await eseguiFase({ campaign_id: 3, type: 'management', entity_id: 'ent1',
    trials: [{ ...tre[0], period_start: '2019-01-01', period_end: '2020-06-30' }, tre[1]] }, b.deps);
  assert.deepEqual(b.visto.open[0].trials.map((t) => [t.period_start, t.period_end]), [['2019-01-01', '2020-06-30'], ['2018-01-01', '2024-01-01']]);
  assert.deepEqual(b.visto.inviate[0].rows.map((r) => [r.period_start, r.period_end]), [['2019-01-01', '2020-06-30'], ['2018-01-01', '2024-01-01']], 'righe col periodo riletto');
});

test('ripresa con una prova fallita nel file: si consegna, poi si riesegue insieme a quelle da fare', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 })],
    fase: faseDa([provaDa('t1', 'pending', 2), provaDa('t2', 'pending', 3), provaDa('t3', 'pending', 4)]) });
  b.registro.scrivi(9, { campaign_id: 3, rows: [rigaMisurata('t1', 2), { key: 't2', status: 'failed', error: 'inputs_not_applied: id non applicati: in_0' }],
    stopped_reason: { kind: 'inputs_not_applied', detail: 'id non applicati: in_0' } });
  const out = await eseguiFase({ campaign_id: 3, phase_id: 9, entity_id: 'ent1' }, b.deps);
  assert.deepEqual(b.visto.inviate.map((c) => c.rows.map((r) => `${r.key}:${r.status}`)), [['t1:measured', 't2:failed'], ['t2:measured', 't3:measured']]);
  assert.equal(b.visto.inviate[0].stopped_reason.kind, 'inputs_not_applied');
  assert.deepEqual([out.executed, out.remaining_in_phase, out.stopped_reason], [2, 0, null]);
});

test('uscite del nucleo: TradingView rifiuta il backtest esteso prima della prova', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })] });
  b.deps.readDeepState = async () => ({ found: true, requestId: 5, deep: true, status: 3, error: 'not_allowed' });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'deep_backtest_error');
  assert.match(out.stopped_reason.detail, /not_allowed/);
  assert.deepEqual(b.visto.inviate[0].rows.map((r) => r.status), ['failed']);
});

test('uscite del nucleo: il report dopo gli input non arriva', async () => {
  const b = banco({ metricsSeq: [M(), M({ net_profit: 200 })] });
  let dopo = false;
  let t = 0;
  const { setInputs } = b.deps;
  b.deps.setInputs = async (a) => { dopo = true; return setInputs(a); };
  b.deps.readDeepState = async () => ({ found: true, requestId: 5, deep: true, status: 2 });
  b.deps.reportObsoleto = async () => dopo;
  b.deps.aggiornaReportSeObsoleto = async () => (dopo ? { obsoleto: true, cliccato: true } : { obsoleto: false, cliccato: false });
  b.deps.now = () => (t += 50);
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'report_not_synced');
  assert.match(b.visto.inviate[0].rows[0].error, /^report_not_synced: /);
});

test('uscite del nucleo: la strategia si rompe a meta fase', async () => {
  const b = banco({ metricsSeq: [M(), Z] });
  let letture = 0;
  b.deps.readStudyStatus = async () => ((letture += 1) === 1 ? { ok: true, type: 0, error: null } : { ok: false, type: 1, error: 'division by zero' });
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
  assert.equal(out.stopped_reason.kind, 'study_runtime_error');
  assert.match(out.stopped_reason.detail, /division by zero/);
  assert.deepEqual([out.zero_trades, out.failed], [0, 1]);
});

test('uscite del nucleo: un anomalia ferma con il suo kind', async () => {
  const b = banco({ metricsSeq: [M()] });
  b.deps.readInputValues = async () => ({ in_0: 1, in_40: 10000 });   // il set non si vede mai
  const out = await eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1', recalc_start_grace_ms: 10 }, b.deps);
  assert.equal(out.stopped_reason.kind, 'readback_mismatch');
  assert.match(out.stopped_reason.detail, /registra la decisione della fase/);
});

test('la strategia nascosta torna nascosta, anche se la fase finisce con un eccezione', async () => {
  for (const rompi of [false, true]) {
    const b = banco({ metricsSeq: [M(), M({ net_profit: 200 }), M({ net_profit: 300 }), M({ net_profit: 400 })] });
    const nascoste = [];
    b.deps.ensureVisibleFor = async () => ({ found: true, wasHidden: true });
    b.deps.setStrategyVisibility = async (id, visibile) => { nascoste.push([id, visibile]); return true; };
    if (rompi) b.deps.readReportFor = async () => { throw new Error('report illeggibile'); };
    const fatto = eseguiFase({ campaign_id: 3, type: 'management', trials: tre, entity_id: 'ent1' }, b.deps);
    if (rompi) await assert.rejects(fatto, /report illeggibile/); else await fatto;
    assert.deepEqual(nascoste, [['ent1', false]], rompi ? 'con eccezione' : 'senza eccezione');
  }
});

test('il nucleo riceve le stesse dipendenze da bt_grind e da bt_phase', () => {
  const chiavi = (file) => {
    const src = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8');
    return /const amb = \{[\s\S]*?deps: \{([\s\S]*?)\}/.exec(src)[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  };
  assert.deepEqual(chiavi('btFase.js'), chiavi('backtest.js'));
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
