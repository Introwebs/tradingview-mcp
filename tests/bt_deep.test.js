import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sincronizzaReport } from '../src/core/btDeep.js';
import { creaTesterFinto } from './helpers/testerFinto.js';

const P4 = { from: '2020-01-01', to: '2023-12-08' };

/** Le dipendenze di sincronizzaReport prese dal tester finto. */
const depsDi = (tv, extra = {}) => ({
  readDeepState: async () => tv.readDeepState(),
  reportObsoleto: async () => tv.reportObsoleto(),
  cliccaAggiorna: async () => tv.cliccaAggiorna(),
  sleep: tv.sleep,
  now: tv.now,
  ...extra,
});

test('tester fermo e senza banner: il report e\' attuale, nessun click', async () => {
  const tv = creaTesterFinto();
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.disponibile, true);
  assert.equal(r.ok, true);
  assert.equal(r.click, 0);
  assert.equal(r.richieste, 0);
});

test('banner presente: preme il pulsante e aspetta che QUELLA richiesta atterri', async () => {
  const tv = creaTesterFinto({ durataMs: 5000 });
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, true);
  assert.equal(r.click, 1);
  assert.equal(r.richieste, 1);
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 3 });
  assert.ok(tv.now() >= 5000, `e\' tornato a ${tv.now()} ms, prima che la richiesta atterrasse`);
});

test('il banner che sparisce al click NON basta: fra il click e la partenza il tester sembra fermo', async () => {
  // E' la finestra che ingannava il grind: banner sparito, stato ancora "pronto", numeri vecchi.
  const tv = creaTesterFinto({ durataMs: 4000, partenzaMs: 900 });
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, true);
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 3 });
});

test('richiesta gia\' in volo e input cambiato nel frattempo: aspetta, poi preme il banner tardivo', async () => {
  // La sequenza della run A-1 (sessione 36): cambio di periodo, e mentre TradingView calcola arriva
  // il cambio di input. Il banner compare solo quando la prima richiesta atterra.
  const tv = creaTesterFinto({ durataMs: 6500 });
  tv.setPeriodo(P4);
  await tv.sleep(3700);
  tv.setInputs({ in_0: 1 });
  assert.equal(tv.reportObsoleto(), false, 'in volo il banner non si vede');

  const r = await sincronizzaReport(depsDi(tv));

  assert.equal(r.ok, true);
  assert.equal(r.click, 1);
  assert.deepEqual(tv.stato.mostrato, { periodo: P4, inputs: { in_0: 1 } });
});

test('solo cambio di periodo: aspetta la richiesta automatica, senza click', async () => {
  const tv = creaTesterFinto({ durataMs: 6500 });
  tv.setPeriodo(P4);
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, true);
  assert.equal(r.click, 0);
  assert.deepEqual(tv.stato.mostrato.periodo, P4);
});

test('TradingView rifiuta la richiesta: ok false col motivo vero', async () => {
  const tv = creaTesterFinto({ durataMs: 2000 });
  tv.rifiutaLaProssima('not_allowed');
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'errore_tradingview');
  assert.equal(r.errore, 'not_allowed');
});

test('modello del tester non leggibile: non disponibile, decide il chiamante', async () => {
  const tv = creaTesterFinto();
  const r = await sincronizzaReport(depsDi(tv, { readDeepState: async () => ({ found: false }) }));
  assert.deepEqual(r, { disponibile: false });
});

test('tester non in modalita\' esteso: niente da sincronizzare', async () => {
  const tv = creaTesterFinto({ deep: false });
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.disponibile, true);
  assert.equal(r.deep, false);
  assert.equal(r.ok, true);
});

test('richiesta che non finisce mai: timeout, non un report "attuale"', async () => {
  const tv = creaTesterFinto({ durataMs: 10 * 60 * 1000 });
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv, { timeoutMs: 20000 }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'timeout');
});

test('grazia iniziale: un banner che compare in ritardo non viene scambiato per report attuale', async () => {
  const tv = creaTesterFinto({ durataMs: 3000 });
  // Il banner arriva 900 ms dopo la chiamata: lo simula un reportObsoleto che lo accende a tempo.
  let acceso = false;
  const deps = depsDi(tv, {
    reportObsoleto: async () => {
      if (!acceso && tv.now() >= 900) { tv.setInputs({ in_0: 3 }); acceso = true; }
      return tv.reportObsoleto();
    },
    graziaInizialeMs: 1500,
  });
  const r = await sincronizzaReport(deps);
  assert.equal(r.ok, true);
  assert.equal(r.click, 1);
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 3 });
});

test('errore rimasto da una richiesta precedente e banner presente: riprova col click', async () => {
  const tv = creaTesterFinto({ durataMs: 2000 });
  tv.rifiutaLaProssima('not_allowed');
  tv.setInputs({ in_0: 3 });
  await sincronizzaReport(depsDi(tv));          // fallisce e lascia lo stato in errore
  tv.setInputs({ in_0: 4 });                    // a tester fermo: banner subito
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, true);
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 4 });
});

test('readDeepState: senza modello dichiara found false, mai uno stato inventato', async () => {
  const { readDeepState } = await import('../src/core/btDeep.js');
  assert.equal((await readDeepState({ evaluate: async () => null })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => ({ found: false, motivo: 'pannello del tester assente' }) })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => { throw new Error('CDP giu'); } })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => ({ found: true, deep: true, status: 2 }) })).found, false, 'senza requestId non e\' uno stato leggibile');
});

test('readDeepState: restituisce lo stato cosi\' com\'e\' nel modello', async () => {
  const { readDeepState } = await import('../src/core/btDeep.js');
  const letto = { found: true, deep: true, status: 3, error: 'not_allowed', requestId: 25, connected: false, from: 1, to: 2 };
  assert.deepEqual(await readDeepState({ evaluate: async () => letto }), letto);
});
