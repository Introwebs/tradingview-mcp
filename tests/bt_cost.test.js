import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCommissionIds, checkImpliedRate, checkControlRun, resolveStrategyEntity, resolveInputKeys,
} from '../src/core/btCost.js';

const INFO = [
  { id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Ingressi' },
  { id: 'in_1', name: 'TF:', type: 'resolution', group: 'Ingressi' },
  { id: 'in_40', name: 'Initial Capital', type: 'float', group: null },
  { id: 'in_43', name: 'Commission Type', type: 'text', group: null },
  { id: 'in_44', name: 'Commission Value', type: 'float', group: null },
  { id: 'text', name: 'text', type: 'text', group: null },
];

test('resolveCommissionIds trova i due id per NOME, mai per posizione', () => {
  assert.deepEqual(resolveCommissionIds(INFO), { typeId: 'in_43', valueId: 'in_44' });
  assert.equal(resolveCommissionIds(INFO.filter((i) => i.id !== 'in_44')), null);
});

test('checkImpliedRate accetta il rate entro 1e-4 relativo e rifiuta il resto con i due numeri', () => {
  assert.equal(checkImpliedRate({ commission_paid: 40, filled_qty_sum: 20, expected: 2 }).ok, true);
  assert.equal(checkImpliedRate({ commission_paid: 40, filled_qty_sum: 20, expected: 2 }).kind, null);
  assert.equal(checkImpliedRate({ commission_paid: 40.002, filled_qty_sum: 20, expected: 2 }).ok, true);
  const ko = checkImpliedRate({ commission_paid: 0, filled_qty_sum: 20, expected: 2 });
  assert.equal(ko.ok, false);
  assert.equal(ko.kind, 'mismatch');
  assert.match(ko.detail, /rate implicito 0 invece di 2/);
  assert.equal(ko.implied_rate, 0);
});

test('checkImpliedRate senza fill non puo verificare niente e lo dice', () => {
  const r = checkImpliedRate({ commission_paid: 0, filled_qty_sum: 0, expected: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unverifiable');
  assert.match(r.detail, /nessun fill/);
});

test('checkImpliedRate con commission_paid non numerico e non verificabile, non un mismatch', () => {
  const r = checkImpliedRate({ commission_paid: null, filled_qty_sum: 20, expected: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unverifiable');
  assert.match(r.detail, /non verificabile/);
  assert.equal(r.implied_rate, null);
});

test('checkImpliedRate: al limite della tolleranza 1e-4 relativo', () => {
  const ko = checkImpliedRate({ commission_paid: 40.01, filled_qty_sum: 20, expected: 2 });
  assert.equal(ko.ok, false);
  assert.equal(ko.kind, 'mismatch');
  const ko2 = checkImpliedRate({ commission_paid: 0.5, filled_qty_sum: 20, expected: 0 });
  assert.equal(ko2.ok, false);
});

test('checkControlRun: la variante 0 deve riprodurre il padre (trade uguali, net entro 0,1%)', () => {
  const parent = { total_trades: 10, net_profit: 1234.5 };
  assert.equal(checkControlRun({ variant: { total_trades: 10, net_profit: 1234.5, commission_paid: 0 }, parent }).ok, true);
  assert.equal(checkControlRun({ variant: { total_trades: 10, net_profit: 1235.0, commission_paid: 0 }, parent }).ok, true);
  const trade = checkControlRun({ variant: { total_trades: 12, net_profit: 1234.5, commission_paid: 0 }, parent });
  assert.equal(trade.ok, false);
  assert.equal(trade.kind, 'mismatch');
  assert.match(trade.detail, /12 trade contro 10/);
  const net = checkControlRun({ variant: { total_trades: 10, net_profit: 1300, commission_paid: 0 }, parent });
  assert.equal(net.ok, false);
  assert.equal(net.kind, 'mismatch');
  assert.match(net.detail, /net 1300 contro 1234.5/);
  assert.match(net.detail, /oltre lo 0,1%/);
  const comm = checkControlRun({ variant: { total_trades: 10, net_profit: 1234.5, commission_paid: 3 }, parent });
  assert.equal(comm.ok, false);
  assert.equal(comm.kind, 'mismatch');
  assert.match(comm.detail, /commissioni pagate 3/);
});

test('checkControlRun con padre a net 0 confronta in assoluto', () => {
  const ok = checkControlRun({ variant: { total_trades: 0, net_profit: 0, commission_paid: 0 }, parent: { total_trades: 0, net_profit: 0 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, null);
});

test('checkControlRun: padre non leggibile o commissione non letta sono unverifiable, non "0 trade"', () => {
  const noParent = checkControlRun({ variant: { total_trades: 10, net_profit: 1234.5, commission_paid: 0 }, parent: {} });
  assert.equal(noParent.ok, false);
  assert.equal(noParent.kind, 'unverifiable');
  assert.match(noParent.detail, /non verificabile/);
  assert.doesNotMatch(noParent.detail, /contro 0/);

  const noPaid = checkControlRun({ variant: { total_trades: 10, net_profit: 1234.5, commission_paid: undefined }, parent: { total_trades: 10, net_profit: 1234.5 } });
  assert.equal(noPaid.ok, false);
  assert.equal(noPaid.kind, 'unverifiable');
  assert.match(noPaid.detail, /non verificabile/);
});

test('resolveStrategyEntity: titolo esatto, poi case-insensitive, poi errori tipizzati', () => {
  const state = { studies: [{ id: 'A', name: 'Volume' }, { id: 'B', name: 'Index Grow Test Claude' }] };
  assert.deepEqual(resolveStrategyEntity(state, 'Index Grow Test Claude'), { entity_id: 'B' });
  assert.deepEqual(resolveStrategyEntity(state, 'index grow test claude'), { entity_id: 'B' });
  const no = resolveStrategyEntity(state, 'Altra');
  assert.equal(no.error.kind, 'strategy_not_on_chart');
  assert.match(no.error.detail, /Volume, Index Grow Test Claude/);
  const amb = resolveStrategyEntity({ studies: [{ id: 'B', name: 'X' }, { id: 'C', name: 'X' }] }, 'X');
  assert.equal(amb.error.kind, 'strategy_ambiguous');
  assert.equal(resolveStrategyEntity(state, '').error.kind, 'strategy_not_on_chart');
});

test('resolveStrategyEntity: strategia trovata ma in errore di runtime', () => {
  const state = { studies: [{ id: 'A', name: 'Volume' }, { id: 'B', name: 'X', error: 'RE10041' }] };
  const r = resolveStrategyEntity(state, 'X');
  assert.equal(r.error.kind, 'strategy_in_error');
  assert.match(r.error.detail, /X/);
  assert.match(r.error.detail, /RE10041/);
});

test('resolveInputKeys: per id se la chiave e un id della mappa, altrimenti per nome; irrisolti a parte', () => {
  const r = resolveInputKeys(INFO, { 'Risk/Reward': 2, in_1: '60', 'Non esiste': 1, text: 'blob' });
  assert.deepEqual(r.resolved, { in_0: 2, in_1: '60' });
  assert.deepEqual(r.unresolved, ['Non esiste']);
  assert.deepEqual(r.ignored, ['text']);
});

test('resolveInputKeys: chiavi omonime "Nome (in_K)" si risolvono per id, non per nome', () => {
  const info = [
    { id: 'in_6', name: 'Lunghezza', type: 'integer', group: 'Ingressi' },
    { id: 'in_7', name: 'Lunghezza', type: 'integer', group: 'Ingressi' },
  ];
  const r = resolveInputKeys(info, { Lunghezza: 1, 'Lunghezza (in_7)': 2 });
  assert.deepEqual(r.resolved, { in_6: 1, in_7: 2 });
  assert.deepEqual(r.unresolved, []);
});

test('resolveInputKeys da applied_inputs (id -> {value, block}) salta i value null', () => {
  const r = resolveInputKeys(INFO, { in_0: { value: 3, block: 'logic' }, in_40: { value: null, block: 'property' } });
  assert.deepEqual(r.resolved, { in_0: 3 });
  assert.deepEqual(r.unresolved, []);
});

// ⚠️ I decimali dell'API Pine Algos viaggiano come STRINGHE (cast decimal di Laravel):
// `net_profit` e' "4061.6300". Un padre cosi' e' leggibilissimo e va confrontato, non scartato.
test('checkControlRun accetta il padre come arriva dall API, coi decimali in stringa', () => {
  const parent = { total_trades: 10, net_profit: '4061.6300' };
  const ok = checkControlRun({ variant: { total_trades: 10, net_profit: 4061.63, commission_paid: 0 }, parent });
  assert.equal(ok.ok, true, ok.detail);
  const ko = checkControlRun({ variant: { total_trades: 10, net_profit: 4500, commission_paid: 0 }, parent });
  assert.equal(ko.ok, false);
  assert.equal(ko.kind, 'mismatch');
  assert.match(ko.detail, /contro 4061.63 del padre/);
});

test('checkControlRun distingue ancora un padre davvero assente da uno a zero', () => {
  const assente = checkControlRun({ variant: { total_trades: 0, net_profit: 0, commission_paid: 0 }, parent: { total_trades: 10 } });
  assert.equal(assente.kind, 'unverifiable');
  assert.match(assente.detail, /net_profit/);
  const vuoto = checkControlRun({ variant: { total_trades: 0, net_profit: 0, commission_paid: 0 }, parent: { total_trades: 10, net_profit: '' } });
  assert.equal(vuoto.kind, 'unverifiable');
  const zero = checkControlRun({ variant: { total_trades: 0, net_profit: 0, commission_paid: 0 }, parent: { total_trades: '0', net_profit: '0.0000' } });
  assert.equal(zero.ok, true, 'un padre a zero e un dato, non un dato mancante');
});
