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

// ---------------------------------------------------------------------------
// appliedInputs: l'archivio per ID e col TIPO (sessione 66, 2026-08-24)
// ---------------------------------------------------------------------------

test('buildInputsPayload archivia appliedInputs per id, con nome e tipo', () => {
  const values = { in_0: 2.5, in_1: '1530-1550', in_2: 14, in_3: 21, in_40: 10000, in_41: 100 };
  const { appliedInputs } = buildInputsPayload(INFO, values);
  assert.deepEqual(appliedInputs['in_0'], { name: 'Risk/Reward', type: 'float', value: 2.5, block: 'logic' });
  // Il tipo e' l'informazione che la chiave-per-nome perdeva, ed e' quella che conta:
  // nessuno, guardando `inputs`, poteva sapere che un input e' un `resolution`.
  assert.equal(appliedInputs['in_1'].type, 'text');
});

test('appliedInputs tiene DENTRO anche le Proprieta, marcate come tali', () => {
  const values = { in_0: 2.5, in_1: 'x', in_2: 14, in_3: 21, in_40: 10000, in_41: 100 };
  const { appliedInputs, inputs } = buildInputsPayload(INFO, values);
  // `inputs` resta la sola logica: e' cio' che il server conta al finalize.
  assert.equal(Object.keys(inputs).length, 4);
  // L'archivio invece e' COMPLETO: le 22 Proprieta' che la madre pinnava e la figlia no erano
  // meta' della differenza fra le due configurazioni della sessione 66.
  assert.equal(appliedInputs['in_40'].block, 'property');
  assert.equal(appliedInputs['in_40'].value, 10000);
  assert.equal(Object.keys(appliedInputs).length, 6);
});

test('appliedInputs non contiene MAI i campi di sistema (il sorgente compilato sta li dentro)', () => {
  const { appliedInputs } = buildInputsPayload(INFO, { text: 'strategy(...)', in_0: 1 });
  assert.equal(appliedInputs['text'], undefined);
  assert.equal(appliedInputs['pineId'], undefined);
});

test('appliedInputs distingue una stringa vuota da un input mai letto', () => {
  // Un `resolution` vuoto significa "timeframe del chart" ed e' un valore vero; un id assente
  // dalla mappa dei valori e' un'altra cosa. Confonderli e' costato tre run a zero trade.
  const info = [
    { id: 'in_54', name: 'TF:', type: 'resolution' },
    { id: 'in_55', name: 'Mai letto', type: 'float' },
  ];
  const { appliedInputs } = buildInputsPayload(info, { in_54: '' });
  assert.equal(appliedInputs['in_54'].value, '');
  assert.equal(appliedInputs['in_55'].value, null);
  assert.ok('value' in appliedInputs['in_55']);
});

test('appliedInputs sopravvive a un nome vuoto o mancante senza perdere l id', () => {
  const info = [{ id: 'in_9', name: '', type: 'bool' }];
  const { appliedInputs } = buildInputsPayload(info, { in_9: true });
  assert.equal(appliedInputs['in_9'].name, '');
  assert.equal(appliedInputs['in_9'].type, 'bool');
  assert.equal(appliedInputs['in_9'].value, true);
});
