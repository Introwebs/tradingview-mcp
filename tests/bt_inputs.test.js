import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInputs, buildInputsPayload, PROPERTY_NAMES } from '../src/core/btInputs.js';

// Forma realistica di getInputsInfo(): 4 campi di sistema, poi la logica, poi le Proprietà.
const INFO = [
  { id: 'text', name: 'source', type: 'text' },
  { id: 'pineId', name: 'pineId', type: 'text' },
  { id: 'pineVersion', name: 'pineVersion', type: 'text' },
  { id: 'pineFeatures', name: 'pineFeatures', type: 'text' },
  { id: 'in_0', name: 'Risk/Reward', type: 'float' },
  { id: 'in_1', name: 'Sessione di trading', type: 'text' },
  { id: 'in_2', name: 'Length', type: 'integer' },
  { id: 'in_3', name: 'Length', type: 'integer' },
  { id: 'in_40', name: 'Initial Capital', type: 'float' },
  { id: 'in_41', name: 'Margin Long', type: 'float' },
];

test('classifyInputs separa sistema, logica e Proprietà', () => {
  const c = classifyInputs(INFO);
  assert.deepEqual(c.system.map((i) => i.id), ['text', 'pineId', 'pineVersion', 'pineFeatures']);
  assert.deepEqual(c.logic.map((i) => i.id), ['in_0', 'in_1', 'in_2', 'in_3']);
  assert.deepEqual(c.properties.map((i) => i.id), ['in_40', 'in_41']);
});

test('buildInputsPayload usa i NOMI come chiave, mai gli id', () => {
  const values = { in_0: 2.5, in_1: '1530-1550', in_2: 14, in_3: 21, in_40: 10000, in_41: 100 };
  const { inputs } = buildInputsPayload(INFO, values);
  assert.equal(inputs['Risk/Reward'], 2.5);
  assert.equal(inputs['Sessione di trading'], '1530-1550');
  assert.equal(inputs['in_0'], undefined);
});

test('buildInputsPayload disambigua i nomi duplicati con l id', () => {
  const values = { in_0: 2.5, in_1: 'x', in_2: 14, in_3: 21, in_40: 10000, in_41: 100 };
  const { inputs } = buildInputsPayload(INFO, values);
  assert.equal(inputs['Length'], 14);
  assert.equal(inputs['Length (in_3)'], 21);
  assert.equal(Object.keys(inputs).length, 4); // conteggio = numero di input di logica
});

test('buildInputsPayload mette le Proprietà in extra_metrics, non in inputs', () => {
  const values = { in_0: 2.5, in_1: 'x', in_2: 14, in_3: 21, in_40: 10000, in_41: 100 };
  const { inputs, properties, initialCapital } = buildInputsPayload(INFO, values);
  assert.equal(inputs['Initial Capital'], undefined);
  assert.equal(properties['Initial Capital'], 10000);
  assert.equal(properties['Margin Long'], 100);
  assert.equal(initialCapital, 10000);
});

test('PROPERTY_NAMES contiene i nomi noti del blocco Proprietà', () => {
  for (const n of ['Initial Capital', 'Margin Long', 'Margin Short', 'Commission Value']) {
    assert.ok(PROPERTY_NAMES.has(n), `manca ${n}`);
  }
});

test('PROPERTY_NAMES ha esattamente i 25 nomi verificati dal vivo', () => {
  assert.equal(PROPERTY_NAMES.size, 25);
});

test('un input di logica CON group non diventa una Proprietà anche se il nome coincide', () => {
  // Caso reale possibile: uno script che chiama un proprio input "Close entries rule"
  // dentro un gruppo. Il group lo salva dall'essere scambiato per una Proprietà.
  const info = [
    { id: 'in_0', name: 'Close entries rule', type: 'text', group: 'Filtri' },
    { id: 'in_1', name: 'Close entries rule', type: 'text', group: null },
  ];
  const c = classifyInputs(info);
  assert.deepEqual(c.logic.map((i) => i.id), ['in_0']);
  assert.deepEqual(c.properties.map((i) => i.id), ['in_1']);
});

test('un input SENZA group e con nome sconosciuto resta logica', () => {
  // Input dichiarato in Pine senza group=: il group da solo lo scambierebbe per Proprietà.
  const c = classifyInputs([{ id: 'in_0', name: 'Soglia ATR', type: 'float', group: null }]);
  assert.deepEqual(c.logic.map((i) => i.id), ['in_0']);
  assert.deepEqual(c.properties, []);
});

test('la coda reale delle Proprietà finisce tutta fuori da inputs', () => {
  // Nomi presi dal probe su TradingView vivo: sono quelli che la vecchia lista sbagliava.
  const info = [
    { id: 'in_0', name: 'Rischio per trade (%)', type: 'float', group: 'Risk' },
    { id: 'in_39', name: 'pyramiding', type: 'integer', group: null },
    { id: 'in_42', name: 'Default entry/order Qty Value', type: 'float', group: null },
    { id: 'in_52', name: 'Backtesting slippage for market orders', type: 'integer', group: null },
    { id: 'in_62', name: 'calc_range', type: 'text', group: null },
  ];
  const values = { in_0: 1.5, in_39: 3, in_42: 100, in_52: 2, in_62: 'all' };
  const { inputs, properties } = buildInputsPayload(info, values);

  assert.deepEqual(Object.keys(inputs), ['Rischio per trade (%)']);
  for (const n of ['pyramiding', 'Default entry/order Qty Value', 'Backtesting slippage for market orders', 'calc_range']) {
    assert.ok(n in properties, `${n} doveva essere una Proprietà`);
    assert.ok(!(n in inputs), `${n} non doveva finire in inputs`);
  }
});
