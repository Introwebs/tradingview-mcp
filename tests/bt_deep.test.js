import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sincronizzaReport, readDeepState } from '../src/core/btDeep.js';
import { creaTesterFinto } from './helpers/testerFinto.js';

const P1 = { from: '2022-12-08', to: '2023-12-08' };
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
const req = (tv) => tv.readDeepState().requestId;

// ── Niente era atteso (`richiestaDopo` assente) ──

test('tester fermo e senza banner, niente atteso: quieto, nessun click', async () => {
  const tv = creaTesterFinto();
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, true);
  assert.equal(r.attuale, 'quieto');
  assert.equal(r.click, 0);
});

test('banner trovato all\'ingresso: preme e crede solo alla richiesta partita da QUEL click', async () => {
  const tv = creaTesterFinto({ durataMs: 5000 });
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, true);
  assert.equal(r.attuale, 'provato');
  assert.equal(r.click, 1);
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 3 });
});

test('richiesta in volo all\'ingresso e banner che compare 900 ms DOPO l\'atterraggio: non si fa ingannare', async () => {
  // Il banner tardivo dopo un atterraggio e' il caso in cui 600 ms di silenzio non provano niente.
  const tv = creaTesterFinto({ durataMs: 6500, ritardoBannerMs: 900 });
  tv.setPeriodo(P4);
  await tv.sleep(3700);
  tv.setInputs({ in_0: 1 });
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, true);
  assert.equal(r.click, 1);
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 1 });
});

test('tester non in modalita\' esteso: niente da sincronizzare', async () => {
  const tv = creaTesterFinto({ deep: false });
  const r = await sincronizzaReport(depsDi(tv));
  assert.deepEqual({ disponibile: r.disponibile, deep: r.deep, ok: r.ok }, { disponibile: true, deep: false, ok: true });
});

// ── Un ricalcolo era atteso (`richiestaDopo` = requestId letto prima del cambio) ──

test('cambio di input: provato solo quando la richiesta degli input nuovi e\' atterrata', async () => {
  const tv = creaTesterFinto({ durataMs: 5000 });
  const prima = req(tv);
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv, { richiestaDopo: prima }));
  assert.equal(r.attuale, 'provato');
  assert.equal(r.click, 1);
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 3 });
  assert.ok(tv.now() >= 5000);
});

test('la finestra fra il click e la partenza (qui 900 ms) non viene scambiata per report attuale', async () => {
  const tv = creaTesterFinto({ durataMs: 4000, partenzaMs: 900 });
  const prima = req(tv);
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv, { richiestaDopo: prima }));
  assert.equal(r.attuale, 'provato');
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 3 });
});

test('banner che compare in ritardo dopo il cambio di input (qui 2 s): aspetta la prova, non il silenzio', async () => {
  const tv = creaTesterFinto({ durataMs: 3000 });
  const prima = req(tv);
  // Il banner arriva 2 s dopo: lo accende un reportObsoleto che cambia l'input a tempo.
  let fatto = false;
  const deps = depsDi(tv, {
    richiestaDopo: prima,
    reportObsoleto: async () => {
      if (!fatto && tv.now() >= 2000) { tv.setInputs({ in_0: 3 }); fatto = true; }
      return tv.reportObsoleto();
    },
  });
  const r = await sincronizzaReport(deps);
  assert.equal(r.attuale, 'provato');
  assert.deepEqual(tv.stato.mostrato.inputs, { in_0: 3 });
});

test('cambio di periodo: aspetta la richiesta automatica anche se parte con 1 s di ritardo', async () => {
  const tv = creaTesterFinto({ periodo: P1, durataMs: 6500, partenzaPeriodoMs: 1000 });
  const prima = req(tv);
  tv.setPeriodo(P4);
  const r = await sincronizzaReport(depsDi(tv, { richiestaDopo: prima }));
  assert.equal(r.attuale, 'provato');
  assert.equal(r.click, 0);
  assert.deepEqual(tv.stato.mostrato.periodo, P4);
});

test('la sequenza di A-1 dal lato del chiamante: periodo, poi input mentre la richiesta e\' in volo', async () => {
  const tv = creaTesterFinto({ periodo: P1, durataMs: 6500 });
  const primaDelPeriodo = req(tv);
  tv.setPeriodo(P4);
  const a = await sincronizzaReport(depsDi(tv, { richiestaDopo: primaDelPeriodo }));
  assert.equal(a.attuale, 'provato');
  assert.deepEqual(tv.stato.mostrato, { periodo: P4, timeframe: '5', inputs: { in_0: 2 } });

  const primaDellInput = req(tv);
  tv.setInputs({ in_0: 1 });
  const b = await sincronizzaReport(depsDi(tv, { richiestaDopo: primaDellInput }));
  assert.equal(b.attuale, 'provato');
  assert.deepEqual(tv.stato.mostrato, { periodo: P4, timeframe: '5', inputs: { in_0: 1 } });
});

test('input che TradingView non considera (nessun banner, nessuna richiesta): senza_richiesta, non una prova', async () => {
  const tv = creaTesterFinto({ inputs: { in_0: 2, in_9: true }, bannerMaiPerInput: ['in_9'] });
  const prima = req(tv);
  tv.setInputs({ in_9: false });
  const r = await sincronizzaReport(depsDi(tv, { richiestaDopo: prima }));
  assert.equal(r.ok, true);
  assert.equal(r.attuale, 'senza_richiesta');
  assert.ok(tv.now() >= 8000, 'ha aspettato la finestra intera prima di arrendersi');
});

// ── Errori e stati non interpretabili ──

test('TradingView rifiuta la richiesta attesa: errore col motivo vero', async () => {
  const tv = creaTesterFinto({ durataMs: 2000 });
  const prima = req(tv);
  tv.rifiuta('not_allowed');
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv, { richiestaDopo: prima }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'errore_tradingview');
  assert.equal(r.errore, 'not_allowed');
});

test('errore rimasto da prima e niente di nuovo: e\' un errore, non un report attuale', async () => {
  const tv = creaTesterFinto({ durataMs: 2000 });
  tv.rifiuta('not_allowed');
  tv.setInputs({ in_0: 3 });
  await sincronizzaReport(depsDi(tv));
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.ok, false);
  assert.equal(r.errore, 'not_allowed');
});

test('errore rimasto da prima ma la richiesta NUOVA riesce: non si ferma sull\'errore vecchio', async () => {
  const tv = creaTesterFinto({ periodo: P1, durataMs: 3000, partenzaPeriodoMs: 700 });
  tv.rifiuta('not_allowed');
  tv.setInputs({ in_0: 3 });
  await sincronizzaReport(depsDi(tv));          // lascia lo stato in errore
  tv.riavvia();
  const prima = req(tv);
  tv.setPeriodo(P4);                            // la richiesta nuova parte 700 ms dopo
  const r = await sincronizzaReport(depsDi(tv, { richiestaDopo: prima }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.attuale, 'provato');
  assert.deepEqual(tv.stato.mostrato.periodo, P4);
});

test('richiesta che non finisce mai: timeout, non un report "attuale"', async () => {
  const tv = creaTesterFinto({ durataMs: 10 * 60 * 1000 });
  const prima = req(tv);
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv, { richiestaDopo: prima, timeoutMs: 20000 }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'timeout');
});

test('click che non fa partire nessuna richiesta: richiesta_non_partita', async () => {
  const tv = creaTesterFinto();
  let bannerFinto = true;
  const r = await sincronizzaReport(depsDi(tv, {
    reportObsoleto: async () => bannerFinto,
    cliccaAggiorna: async () => { bannerFinto = false; return { cliccato: true }; },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'richiesta_non_partita');
});

test('banner che torna dopo ogni click: banner_persistente dopo tre tentativi', async () => {
  const tv = creaTesterFinto({ durataMs: 1000 });
  const r = await sincronizzaReport(depsDi(tv, {
    reportObsoleto: async () => tv.readDeepState().status !== 1,
    cliccaAggiorna: async () => { tv.stato.banner = true; return tv.cliccaAggiorna(); },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'banner_persistente');
  assert.equal(r.click, 3);
});

test('banner presente ma non premibile: restituisce il controllo, non ferma la run', async () => {
  const tv = creaTesterFinto();
  const r = await sincronizzaReport(depsDi(tv, {
    reportObsoleto: async () => true,
    cliccaAggiorna: async () => ({ obsoleto: false, cliccato: false }),
  }));
  assert.equal(r.disponibile, false);
  assert.ok(tv.now() >= 5000 && tv.now() < 10000, `ha aspettato ${tv.now()} ms`);
});

test('modello non leggibile, anche a meta\': non disponibile', async () => {
  const tv = creaTesterFinto();
  assert.equal((await sincronizzaReport(depsDi(tv, { readDeepState: async () => ({ found: false }) }))).disponibile, false);

  tv.setInputs({ in_0: 3 });
  let letture = 0;
  const r = await sincronizzaReport(depsDi(tv, {
    readDeepState: async () => { letture += 1; return letture > 3 ? { found: false, motivo: 'sparito' } : tv.readDeepState(); },
  }));
  assert.deepEqual(r, { disponibile: false, motivo: 'sparito' });
});

test('stato che TradingView non ha mai avuto (es. 4): non si interpreta', async () => {
  const tv = creaTesterFinto();
  const r = await sincronizzaReport(depsDi(tv, { readDeepState: async () => ({ ...tv.readDeepState(), status: 4 }) }));
  assert.equal(r.disponibile, false);
});

test('esteso ma nessuna richiesta mai fatta (stato null) e niente atteso: non garantisce niente', async () => {
  const tv = creaTesterFinto({ statoIniziale: null });
  const r = await sincronizzaReport(depsDi(tv));
  assert.equal(r.disponibile, false);
});

test('campo dello stato rinominato da TradingView (stato sempre null): mai "provato" su numeri vecchi', async () => {
  // Il requestId avanza ma lo stato non si legge piu': senza lo stato 2 la prova non c'e'.
  const tv = creaTesterFinto({ durataMs: 5000 });
  const prima = req(tv);
  tv.setInputs({ in_0: 3 });
  const r = await sincronizzaReport(depsDi(tv, {
    richiestaDopo: prima,
    readDeepState: async () => ({ ...tv.readDeepState(), status: null }),
  }));
  assert.notEqual(r.attuale, 'provato');
  assert.notEqual(r.attuale, 'quieto');
});

// ── readDeepState: il confine col modello di TradingView ──

test('readDeepState: senza modello dichiara found false, mai uno stato inventato', async () => {
  assert.equal((await readDeepState({ evaluate: async () => null })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => ({ found: false, motivo: 'pannello del tester assente' }) })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => { throw new Error('CDP giu'); } })).found, false);
});

test('readDeepState: uno stato letto a meta\' vale come non letto', async () => {
  const buono = { found: true, deep: true, status: 2, error: null, requestId: 7, connected: false };
  assert.equal((await readDeepState({ evaluate: async () => ({ ...buono, requestId: undefined }) })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => ({ ...buono, requestId: null }) })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => ({ ...buono, deep: undefined }) })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => ({ ...buono, status: 4 }) })).found, false);
  assert.equal((await readDeepState({ evaluate: async () => ({ ...buono, status: undefined }) })).found, false);
});

test('readDeepState: restituisce lo stato cosi\' com\'e\' nel modello', async () => {
  const letto = { found: true, deep: true, status: 3, error: 'not_allowed', requestId: 25, connected: false };
  assert.deepEqual(await readDeepState({ evaluate: async () => letto }), letto);
  const maiRichiesto = { found: true, deep: false, status: null, error: null, requestId: 0, connected: false };
  assert.deepEqual(await readDeepState({ evaluate: async () => maiRichiesto }), maiRichiesto);
});
