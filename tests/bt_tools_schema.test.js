import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerBacktestTools } from '../src/tools/backtest.js';

/**
 * Lo schema di un tool e' un contratto con chi lo chiama, e il chiamante di `bt_grind` non e' piu'
 * solo il modello: dal 2026-09-04 e' anche il runner, che per le varianti di costo passa
 * `run_ids` e NIENT'ALTRO oltre a sessione e strategia. Finche' `period_start`/`period_end` sono
 * stati obbligatori, l'SDK rifiutava quella chiamata prima di eseguirla (MCP error -32602,
 * misurato sul backtest #1050). Qui si fissa la forma accettata.
 */
function schemi() {
  const out = {};
  registerBacktestTools({ tool: (name, _desc, shape) => { out[name] = z.object(shape); } });
  return out;
}

test('bt_grind accetta la chiamata del runner: session_id + run_ids + strategy_name, senza periodo', () => {
  const ok = schemi().bt_grind.safeParse({
    session_id: 68, run_ids: [1703, 1704], strategy_name: 'Index Grow Test Claude', command_id: 9,
  });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
});

test('bt_grind accetta ancora la chiamata classica del modello, col periodo e l entity_id', () => {
  const ok = schemi().bt_grind.safeParse({
    session_id: 68, entity_id: 'ent-1', period_start: '2025-09-03', period_end: '2026-09-03',
  });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
});

test('bt_grind pretende comunque la sessione', () => {
  assert.equal(schemi().bt_grind.safeParse({ run_ids: [1] }).success, false);
});

test('bt_apply pretende il backtest_id e accetta il solo command_id in piu', () => {
  const s = schemi().bt_apply;
  assert.equal(s.safeParse({ backtest_id: 1056, command_id: 7 }).success, true);
  assert.equal(s.safeParse({}).success, false);
});
