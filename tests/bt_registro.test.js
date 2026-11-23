import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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

test('ogni piattaforma ha la sua cartella: la fase 7 del locale non e la fase 7 della produzione', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reg-'));
  const locale = creaRegistro({ dir, ambito: 'http://127.0.0.1:8000' });
  const produzione = creaRegistro({ dir, ambito: 'https://pinealgos.com/' });
  locale.scrivi(7, { campaign_id: 3, rows: [{ key: 't1' }] });
  assert.equal(produzione.leggi(7), null);
  assert.equal(creaRegistro({ dir }).leggi(7), null, 'senza ambito resta la cartella di prima');
  assert.equal(existsSync(join(dir, '127.0.0.1_8000', 'fase-7.json')), true);
  produzione.scrivi(7, { campaign_id: 5, rows: [] });
  assert.equal(locale.leggi(7).campaign_id, 3);
});

test('un file che non si puo consegnare si mette da parte, non si cancella', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reg-'));
  const reg = creaRegistro({ dir });
  reg.scrivi(7, { campaign_id: 77, rows: [{ key: 't1' }] });
  reg.scarta(7);
  assert.equal(reg.leggi(7), null);
  const scartati = readdirSync(dir).filter((f) => /^fase-7\.scartato-.+\.json$/.test(f));
  assert.equal(scartati.length, 1, readdirSync(dir).join(', '));
  reg.scarta(8);   // assente: nessun errore
});
