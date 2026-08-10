import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInputsInfo, readInputValues, readbackMatches } from '../src/core/btChart.js';

test('readInputsInfo proietta solo id/name/type e non trasporta mai il blob del source', async () => {
  let js = '';
  const evaluate = async (code) => {
    js = code;
    return JSON.stringify([{ id: 'in_0', name: 'Risk/Reward', type: 'float' }]);
  };
  const out = await readInputsInfo('ent1', { evaluate });
  assert.deepEqual(out, [{ id: 'in_0', name: 'Risk/Reward', type: 'float' }]);
  // La proiezione deve avvenire DENTRO la pagina: il JS non deve stringificare l'array grezzo.
  assert.match(js, /getInputsInfo\(\)/);
  assert.doesNotMatch(js, /JSON\.stringify\(\s*study\.getInputsInfo\(\)\s*\)/);
});

test('readInputValues ritorna una mappa id → valore', async () => {
  const evaluate = async () => ({ in_0: 2.5, in_1: 'x' });
  assert.deepEqual(await readInputValues('ent1', { evaluate }), { in_0: 2.5, in_1: 'x' });
});

test('readbackMatches confronta solo le chiavi richieste', () => {
  assert.equal(readbackMatches({ in_0: 3 }, { in_0: 3, in_1: 'x' }), true);
  assert.equal(readbackMatches({ in_0: 3 }, { in_0: 2, in_1: 'x' }), false);
});

test('readbackMatches tollera numeri equivalenti scritti come stringa', () => {
  assert.equal(readbackMatches({ in_0: 3 }, { in_0: '3' }), true);
});
