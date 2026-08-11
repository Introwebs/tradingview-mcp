/**
 * Lettura delle metriche dal DOM del pannello Strategy Tester.
 *
 * PERCHE' NON BASTA L'API INTERNA. `reportData()` -- e quindi `data_get_strategy_results` e
 * `readReportFor` -- e' CIECO al "Periodo di test": con un periodo ristretto continua a rispondere
 * sull'intero storico caricato. Misurato dal vivo il 2026-08-11, nello stesso istante:
 *
 *     pannello      24 trade   -5,71%
 *     reportData()  288 trade  +28,31%
 *
 * Quindi, quando c'e' un periodo di test ristretto, le metriche si leggono SOLO da qui.
 *
 * ⚠️ SCALA DELLE PERCENTUALI -- LEGGERE PRIMA DI TOCCARE QUALSIASI COSA ⚠️
 * Le due fonti usano scale OPPOSTE, ed e' esattamente il tipo di dettaglio che ha gia' prodotto
 * un difetto invisibile in questo progetto (metriche registrate 100 volte piu' piccole del vero):
 *
 *     reportData().performance.all.netProfitPercent   ->  0.2831   (ratio 0-1, passa cosi' com'e')
 *     pannello "P&L totale ... +28,31%"               ->  28.31    (percentuale, VA DIVISA per 100)
 *
 * L'API Pine Algos vuole ratio 0-1. Qui si divide; in btMetrics.js NO. Verificato contro un dato
 * reale: pannello "-0,10%" su 3 trade -> il backtest #525 in piattaforma ha net_profit_pct
 * -0.0010.
 */
import { evaluate as realEvaluate } from '../connection.js';
import { mouseClick as realMouseClick } from './ui.js';

/**
 * ⛔ LA CAUSA DI TUTTO — leggere prima di toccare il grind ⛔
 *
 * Col "Periodo di test" impostato su un intervallo personalizzato (modalita' ESTESO), TradingView
 * **NON ricalcola il report quando cambi un input**. Marca il report come obsoleto e mostra una
 * snackbar «Il report e' obsoleto — Aggiorna report», e resta li' finche' qualcuno non preme quel
 * pulsante. Misurato dal vivo il 2026-08-11 su TVC:NDQ M5, periodo 11 ago 2025 - 11 ago 2026:
 *
 *     RR target 2 -> 6, poi 30 secondi di attesa   ->  pannello FERMO su +53.121,85 / 203 trade
 *     click su "Aggiorna report"                    ->  +12.971,66 / 161 trade dopo 10,6 s
 *
 * Ecco perche' `isLoading()` diceva `false`: e' vero, non stava caricando niente — non stava
 * ricalcolando affatto. E perche' i backtest uscivano tutti identici: erano i numeri della
 * configurazione precedente, con gli input della corrente in etichetta.
 *
 * ⚠️ `dataSource.recalculate()` NON serve: ricalcola il pane e fa ricomparire il banner (misurato,
 * banner di nuovo presente dopo 219 ms, pannello invariato). L'unico trigger del report e' il
 * pulsante.
 *
 * Nota storica: questo e' anche il motivo per cui "prima funzionava". Senza periodo di test
 * personalizzato TradingView ricalcola da solo; e' stato l'asse periodo — cioe' proprio quello
 * aggiunto da questo lavoro di ottimizzazione — a portare il chart in modalita' ESTESO.
 *
 * @returns {Promise<{obsoleto: boolean, cliccato: boolean}>}
 */
export async function aggiornaReportSeObsoleto({
  evaluate = realEvaluate, mouseClick = realMouseClick, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  tentativi = 6, attesaMs = 400,
} = {}) {
  // Il banner compare ~200 ms dopo il set, non nello stesso istante: si guarda piu' volte.
  for (let i = 0; i < tentativi; i++) {
    const info = await evaluate(`
      (function() {
        var bs = document.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) {
          var t = (bs[i].textContent || '').trim();
          if (/^(Aggiorna report|Update report)$/i.test(t)) {
            var r = bs[i].getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            return { trovato: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
        return { trovato: false };
      })()
    `);
    if (info && info.trovato) {
      // Click VERO: e' una snackbar, e come le voci del menu del periodo non risponde al .click()
      // del DOM in modo affidabile.
      await mouseClick({ x: info.x, y: info.y });
      return { obsoleto: true, cliccato: true };
    }
    await sleep(attesaMs);
  }
  return { obsoleto: false, cliccato: false };
}

/** "2.104,68" -> 2104.68 ; "−0,10" -> -0.10 (il meno del pannello e' U+2212, non ASCII). */
export function numeroItaliano(s) {
  if (s == null) return null;
  // I valori POSITIVI del pannello hanno il prefisso "+" ("+2,05%"), che insieme ai separatori
  // italiani Number() non digerisce. Scoperto sul campo: un backtest in guadagno del 2,05%
  // registrato come 0,00% — plausibile, muto e falso. Le fixture erano reali ma tutte negative.
  s = String(s).replace(/^\s*\+/, '');
  const t = String(s).trim().replace(/−/g, '-').replace(/\s| /g, '');
  if (!t || t === '-' || t === '—') return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Estrae le metriche dal testo del blocco "Statistiche chiave".
 * Esportata a parte per poterla testare su testo reale senza browser.
 */
export function parsePannello(testo) {
  const t = String(testo || '').replace(/\s+/g, ' ');
  const num = '[\\d.]+,\\d+';
  // Il segno va accettato in tutte e tre le forme: "+" sui positivi, U+2212 sui negativi, e il
  // trattino ASCII per prudenza. Senza il "+" la riga del P&L non matcha AFFATTO e il profitto
  // finisce a zero.
  const seg = `[+−-]?${num}`;

  const pl = new RegExp(`P&L totale\\s*(${seg})\\s*[A-Za-z]*\\s*(${seg})%`).exec(t);
  const dd = new RegExp(`Massimo drawdown\\s*(${seg})\\s*[A-Za-z]*\\s*(${seg})%`).exec(t);
  const win = new RegExp(`Operazioni in guadagno\\s*(${num})%\\s*(\\d+)\\s*/\\s*(\\d+)`).exec(t);
  const pf = new RegExp(`Profit factor\\s*(${num})`).exec(t);

  // "Operazioni in guadagno —" e "Profit factor —": il periodo non ha prodotto trade.
  const senzaTrade = /Operazioni in guadagno\s*[—-]/.test(t);

  const metrics = {};
  if (pl) {
    metrics.net_profit = numeroItaliano(pl[1]);
    const pct = numeroItaliano(pl[2]);
    if (pct !== null) metrics.net_profit_percent = pct / 100; // percentuale -> ratio
  }
  if (dd) {
    metrics.max_drawdown = numeroItaliano(dd[1]);
    const pct = numeroItaliano(dd[2]);
    if (pct !== null) metrics.max_drawdown_percent = pct / 100;
  }
  if (win) {
    const pct = numeroItaliano(win[1]);
    if (pct !== null) metrics.percent_profitable = pct / 100;
    metrics.winning_trades = Number(win[2]);
    metrics.total_trades = Number(win[3]);
    metrics.losing_trades = Number(win[3]) - Number(win[2]);
  } else if (senzaTrade) {
    metrics.total_trades = 0;
    metrics.winning_trades = 0;
    metrics.losing_trades = 0;
  }
  if (pf) metrics.profit_factor = numeroItaliano(pf[1]);

  const clean = {};
  for (const [k, v] of Object.entries(metrics)) if (v !== null && v !== undefined) clean[k] = v;
  return clean;
}

/**
 * Garantisce che il pannello Strategy Tester sia aperto e non minimizzato.
 *
 * Serve perche' il grind DIPENDE dal pannello per le run con periodo ristretto: se e' minimizzato,
 * il blocco "Statistiche chiave" non e' proprio nel DOM.
 *
 * ⚠️ NON MISURARE PIXEL QUI — LEGGERE PERCHE' PRIMA DI RITOCCARE ⚠️
 * La prima stesura (2026-08-11) deduceva lo stato del pannello da
 * `document.querySelector('[data-name="backtesting"], [class*="bottom-widgetbar"]')` e
 * dall'altezza del rettangolo. Due difetti in fila, entrambi silenziosi:
 *
 *  1. `[data-name="backtesting"]` NON ESISTE PIU' su TradingView (verificato dal vivo: null).
 *     E' un selettore ereditato da monte — `ui_open_panel` di tradesdontlie/tradingview-mcp usa
 *     ancora lo stesso, ed e' gia' marcio anche li'.
 *  2. Il fallback `[class*="bottom-widgetbar"]` matcha `bottom-widgetbar-handle`, la maniglia di
 *     trascinamento, alta 7px SEMPRE — pannello aperto o chiuso. Quindi `h < 120` era sempre vero
 *     e `toggleMaximize()` scattava a OGNI chiamata: la funzione che doveva garantire il pannello
 *     ne invertiva lo stato a ogni run. Sulla run col pannello chiuso spariva il pulsante del
 *     periodo di test, e il grind si fermava con "voce «Intervallo date personalizzato» non
 *     trovata" — un messaggio che punta nel posto sbagliato.
 *
 * Le classi CSS di TradingView sono hash rigenerati a ogni build (`title-FtwwRr7u`): dedurre lo
 * stato dal DOM e' garantito rompersi. La bottom bar espone lo stato come valori osservabili del
 * modello, che e' lo stesso tier di `dataSources()`/`reportData()` e non e' mai cambiato:
 *
 *     bwb.isVisible().value()     -> true
 *     bwb.mode().value()          -> 'normal' | 'maximized' | 'minimized'
 *     bwb.height().value()        -> 333
 *     bwb.activeWidget().value()  -> 'backtesting'
 *
 * REGOLA: se esiste un'API del modello, lo stato non si deduce mai dal DOM.
 *
 * @returns {Promise<{ok: boolean, altezza: number, stato: object|null, error?: string}>}
 */
export async function ensureTesterPanel({
  evaluate = realEvaluate, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const azione = await evaluate(`
    (function() {
      function v(x) { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'window.TradingView.bottomWidgetBar non disponibile' };
        if (v(bwb.isVisible && bwb.isVisible()) !== true && typeof bwb.show === 'function') bwb.show();
        if (typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
        // open() e' l'inverso esatto di close(): riporta a 'normal' un pannello minimizzato.
        // (toggleMinimize() no: e' un toggle, e su un pannello gia' aperto lo CHIUDE.)
        if (v(bwb.mode && bwb.mode()) === 'minimized' && typeof bwb.open === 'function') bwb.open();
        // Massimizzato il pannello funziona, ma mangia il chart e sposta ogni coordinata del menu
        // del periodo. turnOffMaximize() agisce solo se serve davvero.
        if (typeof bwb.turnOffMaximize === 'function') bwb.turnOffMaximize();
        return { ok: true };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (azione && azione.error) return { ok: false, altezza: 0, stato: null, error: azione.error };

  // showWidget() e' async e open()/turnOffMaximize() rilanciano il layout: lo stato si rilegge
  // DOPO, in una evaluate separata. Rileggerlo nello stesso tick e' come non rileggerlo.
  await sleep(250);

  const stato = await evaluate(`
    (function() {
      function v(x) { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'window.TradingView.bottomWidgetBar non disponibile' };
        return {
          visibile: v(bwb.isVisible && bwb.isVisible()),
          mode: v(bwb.mode && bwb.mode()),
          altezza: v(bwb.height && bwb.height()),
          attivo: v(bwb.activeWidget && bwb.activeWidget()),
        };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (!stato || stato.error) {
    return { ok: false, altezza: 0, stato: null, error: stato?.error || 'stato del pannello illeggibile' };
  }

  const ok = stato.visibile === true && stato.mode !== 'minimized' && stato.attivo === 'backtesting';
  const altezza = Number(stato.altezza) || 0;
  if (ok) return { ok: true, altezza, stato };

  const perche = stato.visibile !== true ? 'la barra inferiore e\' nascosta'
    : stato.mode === 'minimized' ? 'il pannello e\' minimizzato'
      : `la tab attiva e' "${stato.attivo}" invece di "backtesting"`;
  return { ok: false, altezza, stato, error: `pannello Strategy Tester non pronto: ${perche}` };
}

/**
 * Le metriche correnti del pannello, nella stessa forma di `readReportFor`
 * (`{success, metrics, source, error}`) cosi' che `toFinalizePayload` e `detectAnomaly` non
 * debbano sapere da dove arrivano.
 *
 * NOTA: il blocco "Statistiche chiave" non espone Sharpe e Sortino (stanno nella tab
 * "Performance corretta per il rischio"). Restano `undefined` e il payload li manda null: e'
 * preferibile un buco dichiarato a un numero inventato.
 */
export async function readPanelMetrics({ evaluate = realEvaluate } = {}) {
  const letto = await evaluate(`
    (function() {
      var host = null;
      var divs = document.querySelectorAll('div');
      for (var i = 0; i < divs.length; i++) {
        var t = divs[i].textContent || '';
        if (t.indexOf('Statistiche chiave') >= 0 && t.indexOf('P&L totale') >= 0 && divs[i].children.length < 30) host = divs[i];
      }
      if (host) return { stato: 'stats', testo: host.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) };

      // Stato VUOTO: TradingView non disegna le statistiche quando nel periodo non c'e' nemmeno
      // un trade, e mostra "Questo report richiede dati dei trade". Non e' un pannello non
      // pronto: e' un risultato, e va registrato come zero trade.
      var pan = document.querySelector('[class*="backtesting"]');
      var pt = pan ? (pan.textContent || '') : '';
      if (/richiede dati dei trade|almeno un trade|requires trade data|at least one trade/i.test(pt)) {
        return { stato: 'vuoto' };
      }
      return { stato: 'assente' };
    })()
  `);

  if (letto && letto.stato === 'vuoto') {
    // Zero trade nel periodo: e' un dato, non un errore. Le altre metriche non esistono.
    return { success: true, source: 'panel', empty: true, metrics: { total_trades: 0, winning_trades: 0, losing_trades: 0 } };
  }

  const testo = letto && letto.stato === 'stats' ? letto.testo : null;
  if (!testo) {
    // `retryable`: il blocco manca anche mentre il pannello si sta ri-renderizzando dopo un cambio
    // di timeframe o di periodo. Non e' un errore definitivo, e' un "non ancora": chi legge deve
    // riprovare, NON ripiegare sull'API interna, che con un periodo ristretto risponde sbagliato.
    return { success: false, retryable: true, metrics: {}, source: 'panel', error: 'blocco "Statistiche chiave" non ancora disponibile (pannello chiuso o in ridisegno)' };
  }
  const metrics = parsePannello(testo);
  if (!Object.keys(metrics).length) {
    return { success: false, metrics: {}, source: 'panel', error: `pannello illeggibile: "${testo.slice(0, 120)}"` };
  }
  return { success: true, metrics, source: 'panel' };
}
