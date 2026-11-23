import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chiaveMappa, risolviMappa, verificaMappa, daApplicare, configLetta } from '../src/core/btMappa.js';

const INFO = [
  { id: 'text', name: '', type: 'text', group: null },
  { id: 'in_0', name: 'Stop ATR', type: 'float', group: 'Gestione' },
  { id: 'in_1', name: 'Lunghezza', type: 'integer', group: 'A' },
  { id: 'in_2', name: 'Lunghezza', type: 'integer', group: 'B' },
  { id: 'in_3', name: 'TF', type: 'resolution', group: 'A' },
  { id: 'in_4', name: 'Colore', type: 'color', group: 'A' },
  { id: 'in_5', name: 'Initial Capital', type: 'float', group: null },
];
const MAPPA = [
  { name: 'Stop ATR', position: 1, type: 'float', group: 'management' },
  { name: 'Lunghezza', position: 1, type: 'int', group: 'entry' },
  { name: 'Lunghezza', position: 2, type: 'int', group: 'filter' },
  { name: 'TF', position: 1, type: 'timeframe', group: 'filter' },
  { name: 'Colore', position: 1, type: 'color', group: 'skip' },
];

test('due input con lo stesso titolo si distinguono per posizione', () => {
  const r = risolviMappa(INFO, MAPPA);
  assert.equal(r.perChiave.get(chiaveMappa('Lunghezza', 2)).id, 'in_2');
  assert.deepEqual([r.mancanti, r.tipoDiverso, r.nonInMappa], [[], [], []]);
  assert.equal(verificaMappa(INFO, MAPPA), null);
});

test('un input della mappa che il grafico non ha ferma tutto, e dice se sembra un altra versione', () => {
  const v = verificaMappa(INFO, [...MAPPA, { name: 'Trailing', position: 1, type: 'float', group: 'management' }]);
  assert.equal(v.kind, 'map_mismatch');
  assert.deepEqual(v.mancanti, [{ name: 'Trailing', position: 1 }]);
  assert.equal(v.probabile_altra_versione, false);

  const altra = verificaMappa(INFO, [{ name: 'A', position: 1, type: 'int', group: 'entry' }, { name: 'B', position: 1, type: 'int', group: 'entry' }]);
  assert.equal(altra.probabile_altra_versione, true);
  assert.deepEqual(altra.non_in_mappa.slice(0, 2), ['Stop ATR', 'Lunghezza']);
});

test('tipo diverso solo quando il tipo del grafico e noto', () => {
  const info = INFO.map((i) => (i.id === 'in_0' ? { ...i, type: 'bool' } : i.id === 'in_3' ? { ...i, type: 'tipo_mai_visto' } : i));
  const v = verificaMappa(info, MAPPA);
  assert.deepEqual(v.tipo_diverso, [{ name: 'Stop ATR', position: 1, mappa: 'float', grafico: 'bool' }]);
});

test('si applica solo cio che cambia, mai un colore e mai un null', () => {
  const { perChiave } = risolviMappa(INFO, MAPPA);
  const config = [
    { name: 'Stop ATR', position: 1, value: 2.5 }, { name: 'Lunghezza', position: 2, value: 20 },
    { name: 'TF', position: 1, value: '' }, { name: 'Colore', position: 1, value: 4278190335 },
    { name: 'Lunghezza', position: 1, value: null }, { name: 'Sconosciuto', value: 1 },
  ];
  const r = daApplicare(perChiave, config, { in_0: 2, in_1: 10, in_2: 20, in_3: '60' });
  assert.deepEqual(r.target, { in_0: 2.5, in_2: 20, in_3: '' });
  assert.deepEqual(r.delta, { in_0: 2.5, in_3: '' });
  assert.deepEqual(r.ignoti, [{ name: 'Sconosciuto', position: 1 }]);
});

test('la configurazione riletta segue la mappa e lascia fuori i colori', () => {
  const { perChiave } = risolviMappa(INFO, MAPPA);
  assert.deepEqual(configLetta(perChiave, { in_0: 2, in_1: 10, in_2: 20, in_3: '', in_4: 123 }), [
    { name: 'Stop ATR', position: 1, value: 2 }, { name: 'Lunghezza', position: 1, value: 10 },
    { name: 'Lunghezza', position: 2, value: 20 }, { name: 'TF', position: 1, value: '' },
  ]);
});
