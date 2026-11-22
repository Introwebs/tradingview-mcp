import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FASI, FASI_SALVATAGGIO, creaCronometro, riassumi } from '../src/core/cronometro.js';

function nuovo() {
  const orologio = { t: 0 };
  const c = creaCronometro(() => orologio.t);
  return { c, o: orologio };
}

// Record sintetico con le sole fasi indicate, il resto a zero.
function rec(run_id, fasi) {
  const tutte = Object.fromEntries(FASI.map((f) => [f, 0]));
  Object.assign(tutte, fasi);
  return { run_id, totale_ms: Object.values(tutte).reduce((a, b) => a + b, 0), fasi: tutte };
}

test('segna somma il tempo dal segno precedente', () => {
  const { c, o } = nuovo();
  c.apri();
  o.t = 100; c.segna('coda');
  o.t = 350; c.segna('contesto');
  o.t = 400;
  const r = c.chiudi();
  assert.equal(r.fasi.coda, 100);
  assert.equal(r.fasi.contesto, 250);
  assert.equal(r.fasi.altro, 50);
  assert.equal(r.totale_ms, 400);
  for (const f of FASI) if (!['coda', 'contesto', 'altro'].includes(f)) assert.equal(r.fasi[f], 0);
});

test('una fase che ricorre si somma', () => {
  const { c, o } = nuovo();
  c.apri();
  o.t = 30; c.segna('rilettura');
  o.t = 100; c.segna('rilettura');
  assert.equal(c.chiudi().fasi.rilettura, 100);
});

test('apri chiude il record precedente', () => {
  const { c, o } = nuovo();
  c.apri();
  c.assegna(1);
  o.t = 10;
  c.apri();
  assert.equal(c.records().length, 1);
  assert.equal(c.records()[0].run_id, 1);
});

test('scarta non lascia record', () => {
  const { c, o } = nuovo();
  c.apri();
  o.t = 5;
  c.scarta();
  assert.equal(c.chiudi(), null);
  assert.equal(c.records().length, 0);
});

test('fase sconosciuta lancia', () => {
  const { c } = nuovo();
  c.apri();
  assert.throws(() => c.segna('nuvola'));
});

test('segna senza record aperto non fa niente', () => {
  const { c } = nuovo();
  assert.doesNotThrow(() => c.segna('coda'));
  assert.equal(c.records().length, 0);
});

test('totale_ms e la somma esatta delle fasi arrotondate', () => {
  const { c, o } = nuovo();
  c.apri();
  o.t = 10.4; c.segna('coda');
  o.t = 20.8; c.segna('contesto');
  const r = c.chiudi();
  assert.equal(r.totale_ms, Object.values(r.fasi).reduce((a, b) => a + b, 0));
  assert.ok(Object.values(r.fasi).every(Number.isInteger));
});

test('riassumi usa solo le prove riuscite', () => {
  const records = [rec(1, { ricalcolo: 1000 }), rec(2, { ricalcolo: 3000 }), rec(3, { ricalcolo: 9000 })];
  const rows = [
    { run_id: 1, status: 'done' },
    { run_id: 2, status: 'done' },
    { run_id: 3, status: 'failed' },
  ];
  const r = riassumi(records, rows);
  assert.equal(r.mediane_done.totale, 2000);
  assert.equal(r.max_done.totale, 3000);
  assert.equal(r.run[2].esito, 'failed');
});

test('riassumi separa nucleo e salvataggio', () => {
  const records = [rec(1, { coda: 100, screenshot: 1300, salvataggio: 400, ricalcolo: 5000 })];
  const r = riassumi(records, [{ run_id: 1, status: 'done' }]);
  assert.equal(r.mediane_done.salvataggio, 1800);
  assert.equal(r.mediane_done.nucleo, 5000);
  assert.deepEqual(FASI_SALVATAGGIO, ['coda', 'screenshot', 'salvataggio']);
});

test('riassumi senza prove riuscite', () => {
  assert.deepEqual(riassumi([], []), { run: [], mediane_done: null, max_done: null });
});

test("esito dall'ultima riga della run", () => {
  const r = riassumi([rec(1, { ricalcolo: 10 })], [{ run_id: 1, status: 'failed' }, { run_id: 1, status: 'done' }]);
  assert.equal(r.run[0].esito, 'done');
});

test('FASI: 13 nomi, altro ultimo', () => {
  assert.equal(FASI.length, 13);
  assert.equal(FASI.at(-1), 'altro');
});
