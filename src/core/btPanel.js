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
 * Garantisce che il pannello Strategy Tester sia aperto E non collassato.
 *
 * Serve perche' il grind ora DIPENDE dal pannello per le run con periodo ristretto: se e'
 * minimizzato, il blocco "Statistiche chiave" non e' proprio nel DOM. Misurato dal vivo il
 * 2026-08-11: pannello alto 7px, `document.body` senza nemmeno la stringa "Statistiche chiave",
 * e il grind che si fermava alla prima run. Il pulsante del periodo invece resta visibile anche
 * da collassato, quindi non e' un indizio affidabile dello stato del pannello.
 *
 * @returns {Promise<{ok: boolean, altezza: number, error?: string}>}
 */
export async function ensureTesterPanel({ evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (bwb && typeof bwb.showWidget === 'function') bwb.showWidget('backtesting');
        var h = 0;
        var el = document.querySelector('[data-name="backtesting"], [class*="bottom-widgetbar"]');
        if (el) h = el.getBoundingClientRect().height;
        // Collassato: lo si riapre. toggleMaximize e' l'unica leva esposta dalla bottom bar.
        if (h < 120 && bwb && typeof bwb.toggleMaximize === 'function') bwb.toggleMaximize();
        if (el) h = el.getBoundingClientRect().height;
        return { altezza: Math.round(h) };
      } catch (e) { return { altezza: 0, error: e.message }; }
    })()
  `);
  const altezza = out?.altezza ?? 0;
  return { ok: altezza >= 120, altezza, ...(out?.error && { error: out.error }) };
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
