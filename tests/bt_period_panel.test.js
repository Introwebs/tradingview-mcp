import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDataItaliana, parseEtichettaPeriodo, setCustomPeriod, readTestPeriod, etichettaSembraPeriodo } from '../src/core/btPeriod.js';
import { numeroItaliano, parsePannello, readPanelMetrics, ensureTesterPanel } from '../src/core/btPanel.js';

// I testi qui sotto sono COPIATI dal pannello vero il 2026-08-11, non scritti a mente.
// La lezione del progetto: una fixture inventata che codifica la stessa assunzione del codice
// rende il test verde proprio quando il codice sbaglia.
const PANNELLO_3_TRADE = 'Statistiche chiave P&L totale−101,14USD−0,10%Massimo drawdown2.104,68USD2,06%Operazioni in guadagno33,33%1/3Profit factor0,952 PerformanceP&L cumulativoBuy and hold';
const PANNELLO_24_TRADE = 'Statistiche chiave P&L totale−5.711,60USD−5,71%Massimo drawdown6.353,52USD6,35%Operazioni in guadagno33,33%8/24Profit factor0,626 Performance';
const PANNELLO_0_TRADE = 'Statistiche chiave P&L totale−839,10USD−0,84%Massimo drawdown924,90USD0,92%Operazioni in guadagno—Profit factor— Performance';
// Catturato il 2026-08-11 su M15/30 giorni. E' il caso che ha rotto il parser: i valori POSITIVI
// hanno il prefisso "+", e senza gestirlo la riga del P&L non matcha e il profitto va a zero.
const PANNELLO_POSITIVO = 'Statistiche chiave P&L totale+2.050,75USD+2,05%Massimo drawdown2.999,01USD2,86%Operazioni in guadagno42,86%3/7Profit factor1,946 Performance';

test('numeroItaliano: punto=migliaia, virgola=decimale, meno U+2212', () => {
  assert.equal(numeroItaliano('2.104,68'), 2104.68);
  assert.equal(numeroItaliano('−0,10'), -0.10);
  assert.equal(numeroItaliano('−5.711,60'), -5711.60);
  assert.equal(numeroItaliano('—'), null);
  assert.equal(numeroItaliano(null), null);
});

test('parsePannello estrae le metriche dal testo reale del pannello', () => {
  const m = parsePannello(PANNELLO_3_TRADE);
  assert.equal(m.net_profit, -101.14);
  assert.equal(m.max_drawdown, 2104.68);
  assert.equal(m.total_trades, 3);
  assert.equal(m.winning_trades, 1);
  assert.equal(m.losing_trades, 2);
  assert.equal(m.profit_factor, 0.952);
});

test('le percentuali del PANNELLO sono percentuali e vanno divise per 100 (al contrario di reportData)', () => {
  // Il controllo che vale piu' di tutti: il backtest #525 in piattaforma, generato da questo
  // stesso stato del pannello, ha net_profit_pct = -0.0010. Se un giorno qualcuno "corregge"
  // la divisione, questo test deve diventare rosso.
  const m = parsePannello(PANNELLO_3_TRADE);
  assert.equal(m.net_profit_percent, -0.001);
  assert.equal(m.max_drawdown_percent, 0.0206);

  const m2 = parsePannello(PANNELLO_24_TRADE);
  assert.equal(m2.net_profit_percent, -0.0571);
  assert.equal(m2.max_drawdown_percent, 0.0635);
  assert.equal(m2.total_trades, 24);
  assert.ok(Math.abs(m2.percent_profitable - 0.3333) < 1e-9);
});

test('i valori POSITIVI hanno il prefisso + e devono essere letti (non finire a zero)', () => {
  const m = parsePannello(PANNELLO_POSITIVO);
  const vicino = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  assert.equal(m.net_profit, 2050.75);
  vicino(m.net_profit_percent, 0.0205);   // la divisione per 100 lascia artefatti float
  assert.equal(m.max_drawdown, 2999.01);
  vicino(m.max_drawdown_percent, 0.0286);
  assert.equal(m.total_trades, 7);
  assert.equal(m.winning_trades, 3);
  assert.equal(m.profit_factor, 1.946);
  // il sintomo del difetto reale: profitto vero 2,05%, registrato 0
  assert.notEqual(m.net_profit_percent, 0);
});

test('numeroItaliano regge il prefisso +', () => {
  assert.equal(numeroItaliano('+2.050,75'), 2050.75);
  assert.equal(numeroItaliano('+2,05'), 2.05);
});

test('pannello senza trade: total_trades 0, non metriche mancanti', () => {
  const m = parsePannello(PANNELLO_0_TRADE);
  assert.equal(m.total_trades, 0);
  assert.equal(m.winning_trades, 0);
  assert.equal(m.net_profit, -839.10);
  assert.equal(m.net_profit_percent, -0.0084);
});

test('readPanelMetrics degrada con un errore RIPROVABILE se il pannello non c e', async () => {
  const out = await readPanelMetrics({ evaluate: async () => ({ stato: 'assente' }) });
  assert.equal(out.success, false);
  assert.equal(out.retryable, true);
  assert.match(out.error, /Statistiche chiave/);
});

test('stato VUOTO del pannello = zero trade, non "pannello non pronto"', async () => {
  // Testo reale del 2026-08-11 su M5 a 3 giorni: TradingView non disegna le statistiche quando
  // nel periodo non c'e' nemmeno un trade. Scambiarlo per un pannello non pronto faceva fallire
  // la run con runtime_error invece di registrare il dato vero.
  const out = await readPanelMetrics({ evaluate: async () => ({ stato: 'vuoto' }) });
  assert.equal(out.success, true);
  assert.equal(out.empty, true);
  assert.equal(out.metrics.total_trades, 0);
  assert.notEqual(out.retryable, true);
});

test('readPanelMetrics ritorna la stessa forma di readReportFor', async () => {
  const out = await readPanelMetrics({ evaluate: async () => ({ stato: 'stats', testo: PANNELLO_24_TRADE }) });
  assert.equal(out.success, true);
  assert.equal(out.source, 'panel');
  assert.equal(out.metrics.total_trades, 24);
});

test('parseDataItaliana copre i mesi italiani abbreviati', () => {
  assert.equal(parseDataItaliana('4 ago 2026'), '2026-08-04');
  assert.equal(parseDataItaliana('3 gen 2000'), '2000-01-03');
  assert.equal(parseDataItaliana('11 dic 2025'), '2025-12-11');
  assert.equal(parseDataItaliana('pippo'), null);
});

test('parseEtichettaPeriodo legge il range REALE dall etichetta del pulsante', () => {
  assert.deepEqual(
    { from: '2026-08-04', to: '2026-08-11' },
    (({ from, to }) => ({ from, to }))(parseEtichettaPeriodo('4 ago 2026 — 11 ago 2026Esteso')),
  );
  assert.deepEqual(
    { from: '2000-01-03', to: '2026-08-11' },
    (({ from, to }) => ({ from, to }))(parseEtichettaPeriodo('3 gen 2000 — 11 ago 2026Esteso')),
  );
});

test('readTestPeriod ritorna label vuota senza esplodere se il pulsante non c e', async () => {
  const out = await readTestPeriod({ evaluate: async () => null });
  assert.deepEqual(out, { label: null, from: null, to: null });
});

test('setCustomPeriod rifiuta date non ISO senza toccare la UI', async () => {
  let toccato = false;
  const out = await setCustomPeriod('04/08/2026', '2026-08-11', {
    evaluate: async () => { toccato = true; return null; },
    mouseClick: async () => { toccato = true; },
    sleep: async () => {},
  });
  assert.equal(out.applied, false);
  assert.match(out.error, /non ISO/);
  assert.equal(toccato, false);
});

test('setCustomPeriod usa click VERI, non il click del DOM', async () => {
  // E' il difetto che ha fatto perdere piu' tempo: col .click() del DOM l'etichetta cambia ma il
  // ricalcolo non parte, quindi sembra riuscito e non lo e'.
  const clicks = [];
  const out = await setCustomPeriod('2026-08-04', '2026-08-11', {
    evaluate: async (js) => {
      if (/_paPeriodBtn/.test(js) && /getBoundingClientRect/.test(js) && /title-/.test(js)) {
        return [{ testo: 'Intervallo date personalizzato', x: 300, y: 700 }];
      }
      if (/placeholder="YYYY-MM-DD"/.test(js)) {
        return { ok: true, valori: ['2026-08-04', '2026-08-11'], submit: { x: 1100, y: 800, disabled: false } };
      }
      return '4 ago 2026 — 11 ago 2026Esteso';
    },
    mouseClick: async ({ x, y }) => { clicks.push([x, y]); },
    sleep: async () => {},
  });
  assert.deepEqual(clicks, [[300, 700], [1100, 800]]);
  assert.equal(out.applied, true);
  assert.equal(out.from, '2026-08-04');
  assert.equal(out.to, '2026-08-11');
});

test('setCustomPeriod segnala applied:false se TV applica un range diverso da quello chiesto', async () => {
  const out = await setCustomPeriod('2020-01-01', '2026-08-11', {
    evaluate: async (js) => {
      if (/title-/.test(js) && /getBoundingClientRect/.test(js)) return [{ testo: 'Intervallo date personalizzato', x: 300, y: 700 }];
      if (/placeholder="YYYY-MM-DD"/.test(js)) return { ok: true, valori: ['2020-01-01', '2026-08-11'], submit: { x: 1, y: 2 } };
      return '4 ago 2023 — 11 ago 2026Esteso'; // TV non aveva storia dal 2020
    },
    mouseClick: async () => {},
    sleep: async () => {},
  });
  assert.equal(out.applied, false);
  assert.equal(out.from, '2023-08-04');
});

// ---------------------------------------------------------------------------
// Regressione del 2026-08-11 (secondo incidente): ensureTesterPanel deduceva lo
// stato del pannello dai PIXEL, misurando per giunta l'elemento sbagliato
// (`bottom-widgetbar-handle`, alto 7px sempre). Il risultato era `h < 120` sempre
// vero e `toggleMaximize()` a ogni chiamata: la funzione che doveva garantire il
// pannello ne invertiva lo stato a ogni run. Poi il grind si fermava con "voce
// «Intervallo date personalizzato» non trovata" — e la voce c'era.
// ---------------------------------------------------------------------------

function stubPannello(stato) {
  const jsVisto = [];
  const evaluate = async (js) => {
    jsVisto.push(js);
    if (/showWidget|turnOffMaximize/.test(js) && !/isVisible:/.test(js)) return { ok: true };
    return stato;
  };
  return { evaluate, jsVisto };
}

test('ensureTesterPanel legge lo stato dal MODELLO, mai dai pixel', async () => {
  const { evaluate, jsVisto } = stubPannello({ visibile: true, mode: 'normal', altezza: 333, attivo: 'backtesting' });
  const out = await ensureTesterPanel({ evaluate, sleep: async () => {} });
  assert.equal(out.ok, true);
  assert.equal(out.altezza, 333);
  const tuttoIlJs = jsVisto.join('\n');
  // I due difetti veri, sbarrati per costruzione.
  assert.ok(!/getBoundingClientRect/.test(tuttoIlJs), 'non deve misurare pixel');
  assert.ok(!/toggleMaximize/.test(tuttoIlJs), 'toggleMaximize e\' un toggle cieco: vietato');
  assert.ok(!/bottom-widgetbar"\]|data-name="backtesting"/.test(tuttoIlJs), 'niente selettori DOM marci');
});

test('ensureTesterPanel rilegge lo stato in una evaluate SEPARATA, non nello stesso tick', async () => {
  const { evaluate, jsVisto } = stubPannello({ visibile: true, mode: 'normal', altezza: 333, attivo: 'backtesting' });
  await ensureTesterPanel({ evaluate, sleep: async () => {} });
  assert.equal(jsVisto.length, 2, 'agire e verificare devono essere due evaluate distinte');
});

test('ensureTesterPanel: pannello minimizzato = NON pronto, con il motivo vero', async () => {
  const { evaluate } = stubPannello({ visibile: true, mode: 'minimized', altezza: 0, attivo: 'backtesting' });
  const out = await ensureTesterPanel({ evaluate, sleep: async () => {} });
  assert.equal(out.ok, false);
  assert.match(out.error, /minimizzat/i);
});

test('ensureTesterPanel: tab sbagliata (pine-editor) = NON pronto', async () => {
  const { evaluate } = stubPannello({ visibile: true, mode: 'normal', altezza: 333, attivo: 'pine-editor' });
  const out = await ensureTesterPanel({ evaluate, sleep: async () => {} });
  assert.equal(out.ok, false);
  assert.match(out.error, /pine-editor/);
});

test('setCustomPeriod: bottone assente = pannello chiuso, NON "voce non trovata"', async () => {
  // E' il messaggio che ha mandato fuori strada la diagnosi il 2026-08-11.
  let clic = 0;
  const out = await setCustomPeriod('2026-08-04', '2026-08-11', {
    evaluate: async (js) => (/_paPeriodBtn/.test(js) ? { bottoneTrovato: false, voci: [] } : null),
    mouseClick: async () => { clic++; },
    sleep: async () => {},
  });
  assert.equal(out.applied, false);
  assert.equal(out.retryable, true);
  assert.match(out.error, /pannello Strategy Tester/i);
  assert.ok(!/voce "Intervallo date personalizzato" non trovata/.test(out.error), 'non deve incolpare il menu');
  assert.equal(clic, 0);
});

test('setCustomPeriod: voce mancante davvero -> l\'errore ELENCA le voci lette', async () => {
  const out = await setCustomPeriod('2026-08-04', '2026-08-11', {
    evaluate: async (js) => (/_paPeriodBtn/.test(js)
      ? { bottoneTrovato: true, voci: [{ testo: 'Ultimi 7 giorni', x: 1, y: 2 }, { testo: 'Storico completo', x: 1, y: 3 }] }
      : null),
    mouseClick: async () => {},
    sleep: async () => {},
  });
  assert.equal(out.applied, false);
  assert.match(out.error, /Ultimi 7 giorni \| Storico completo/);
});

// --- Il pulsante del periodo NON si riconosce dal badge "Esteso" (2026-08-11) ----------------
// Il badge e' condizionale: compare solo col Backtester esteso attivo. Misurato dal vivo su
// OANDA:EURUSD dopo un riavvio di TradingView: pulsante presente e funzionante, etichetta
// "3 mag 2026 — 11 ago 2026", nessun badge. Il grind si e' fermato sulla prima di venti run.

test('il pulsante del periodo si riconosce SENZA il badge "Esteso"', () => {
  assert.equal(etichettaSembraPeriodo('3 mag 2026 — 11 ago 2026'), true);   // il caso reale che rompeva
  assert.equal(etichettaSembraPeriodo('11 ago 2025 — 11 ago 2026Esteso'), true);
  assert.equal(etichettaSembraPeriodo('Storico completo'), true);
  assert.equal(etichettaSembraPeriodo('Ultimi 30 giorni'), true);
  assert.equal(etichettaSembraPeriodo('Intervallo grafico disponibile'), true);
});

test('non scambia per periodo gli altri pulsanti del pannello', () => {
  // Sono i pulsanti veri letti accanto a quello del periodo il 2026-08-11.
  assert.equal(etichettaSembraPeriodo('100 K USD'), false);
  assert.equal(etichettaSembraPeriodo('Livello di dettaglio predefinito'), false);
  assert.equal(etichettaSembraPeriodo('Esecuzione dello script1'), false);
  assert.equal(etichettaSembraPeriodo(''), false);
  assert.equal(etichettaSembraPeriodo(null), false);
});
