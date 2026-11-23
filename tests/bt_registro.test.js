import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { creaRegistro } from '../src/core/btRegistro.js';

test('il registro tiene le righe finche non sono consegnate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reg-'));
  const reg = creaRegistro({ dir });
  assert.equal(reg.leggi(7), null);
  reg.scrivi(7, { campaign_id: 3, rows: [{ key: 't1' }] });
  assert.deepEqual(reg.leggi(7).rows, [{ key: 't1' }]);
  writeFileSync(join(dir, 'fase-8.json'), '{rotto');
  assert.equal(reg.leggi(8), null);
  reg.cancella(7);
  assert.equal(reg.leggi(7), null);
});
