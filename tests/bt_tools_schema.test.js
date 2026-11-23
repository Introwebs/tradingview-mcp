import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { registerBacktestTools } from '../src/tools/backtest.js';
import { readFileConfig } from '../src/core/pinealgos.js';

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

/** Descrizione e gestore di un tool, per i test che guardano cosa dice e cosa risponde. */
function tool(nome) {
  let trovato = null;
  registerBacktestTools({ tool: (name, desc, shape, handler) => { if (name === nome) trovato = { desc, shape, handler }; } });
  return trovato;
}
const errore = (risposta) => JSON.parse(risposta.content[0].text).error;

/**
 * Un gestore che arriva a `resolveConfig()` legge ~/.pinealgos/config.json anche quando le env
 * vincono (il default `fileConfig = readFileConfig()` si valuta subito), e su questa macchina quel
 * file porta il token di PRODUZIONE. Per la durata di `fn` la casa e' una cartella temporanea con
 * un config marcatore (os.homedir() segue USERPROFILE su Windows e HOME altrove), e le env puntano
 * a una porta chiusa. Tutto torna com'era nel `finally`.
 */
const MARCATORE = { base: 'http://127.0.0.1:1', token: 'marcatore-del-test' };
async function conCasaFinta(fn) {
  const casa = mkdtempSync(join(tmpdir(), 'casa-finta-'));
  mkdirSync(join(casa, '.pinealgos'));
  writeFileSync(join(casa, '.pinealgos', 'config.json'), JSON.stringify(MARCATORE));
  const nomi = ['USERPROFILE', 'HOME', 'PINEALGOS_BASE', 'PINEALGOS_TOKEN'];
  const prima = Object.fromEntries(nomi.map((k) => [k, process.env[k]]));
  process.env.USERPROFILE = casa;
  process.env.HOME = casa;
  process.env.PINEALGOS_BASE = 'http://127.0.0.1:1';
  process.env.PINEALGOS_TOKEN = 'prova';
  try {
    // La casa finta e' davvero quella che legge il client: se no, il test si ferma QUI.
    assert.equal(homedir(), casa, 'os.homedir() non segue la casa finta');
    assert.deepEqual(readFileConfig(), MARCATORE, 'il config letto non e quello della casa finta');
    return await fn();
  } finally {
    for (const k of nomi) {
      if (prima[k] === undefined) delete process.env[k]; else process.env[k] = prima[k];
    }
    rmSync(casa, { recursive: true, force: true });
  }
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

test('bt_phase accetta una fase nuova e una ripresa, e pretende la campagna', () => {
  const s = schemi().bt_phase;
  assert.equal(s.safeParse({ campaign_id: 3, type: 'management', strategy_name: 'NDQ Box Strategy',
    trials: [{ inputs: [{ name: 'Stop ATR', value: 1.5 }, { name: 'Filtro trend', position: 1, value: false }] }] }).success, true);
  assert.equal(s.safeParse({ campaign_id: 3, phase_id: 9 }).success, true);
  assert.equal(s.safeParse({ type: 'base', trials: [{}] }).success, false);
  assert.equal(s.safeParse({ campaign_id: 3, type: 'tenuta', trials: [{}] }).success, false);
  assert.equal(s.safeParse({ campaign_id: 3, type: 'entry', trials: [{ inputs: [{ name: 'X', value: null }] }] }).success, false);
});

test('bt_phase: la stringa vuota e un valore, e l attesa del ricalcolo ha un tetto', () => {
  const s = schemi().bt_phase;
  assert.equal(s.safeParse({ campaign_id: 3, type: 'entry', trials: [{ inputs: [{ name: 'TF', value: '' }] }] }).success, true);
  assert.equal(s.safeParse({ campaign_id: 3, phase_id: 9, recalc_timeout_ms: 120000 }).success, true);
  assert.equal(s.safeParse({ campaign_id: 3, phase_id: 9, recalc_timeout_ms: 120001 }).success, false);
});

test('bt_phase: la descrizione dice quando richiamare e quando smettere', () => {
  const { desc, shape } = tool('bt_phase');
  assert.match(desc, /richiamalo con phase_id/);
  assert.match(desc, /se lo stesso fermo si ripete sulla stessa prova non insistere, registra la decisione della fase/);
  assert.match(desc, /la fase base ha una prova sola, vuota/);
  assert.doesNotMatch(desc, /\btrial\b|holdout/i);
  assert.match(shape.max_trials_per_call.description, /default e massimo/);
  assert.match(shape.time_budget_ms.description, /default e massimo/);
  assert.match(shape.symbol.description, /mercato della campagna/);
});

test('bt_phase rifiuta phase_id insieme alle prove di una fase nuova', async () => {
  const { handler } = tool('bt_phase');
  // Anche qui la casa finta: se il controllo regredisse, il gestore arriverebbe a resolveConfig().
  const r = await conCasaFinta(() => handler({ campaign_id: 3, phase_id: 9, type: 'management', trials: [{}] }));
  assert.equal(r.isError, true);
  assert.match(errore(r), /phase_id/);
  assert.match(errore(r), /non tutti e due/);
});

test('bt_phase: se la piattaforma non risponde all avvio lo dice in italiano', async () => {
  const { handler } = tool('bt_phase');
  const r = await conCasaFinta(() => handler({ campaign_id: 3, phase_id: 9 }));
  assert.equal(r.isError, true);
  assert.match(errore(r), /^La piattaforma non risponde: .+ Nessuna prova è stata eseguita\.$/s);
  assert.match(errore(r), /127\.0\.0\.1:1|fetch failed/);
});
