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
/**
 * Il report e' dichiarato obsoleto da TradingView? E' il segnale AUTORITATIVO, e vale piu' di
 * qualunque confronto fra numeri.
 *
 * Perche' conta: due `input_set` diversi possono produrre lo stesso identico report, e non e' un
 * caso limite. Misurato il 2026-08-11 su `Imbalance Strategy`: `RR target (Classic)` a 1.5, 2 e 3
 * da' sempre 651 trade e +57,27%, perche' quel parametro agisce solo in mgmt mode "Classic", che
 * non era attivo. Dedurre lo stato dal movimento dei numeri fermava quindi una matrice sana con
 * `stale_metrics` — un falso allarme su un risultato legittimo.
 *
 * La domanda giusta non e' "i numeri sono cambiati?" ma "TradingView considera il report attuale?".
 * Banner assente = report attuale per gli input correnti, anche se i numeri coincidono con quelli
 * di prima.
 */
export async function reportObsoleto({ evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      var bs = document.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) {
        if (/^(Aggiorna report|Update report)$/i.test((bs[i].textContent || '').trim())) return true;
      }
      return /Il report è obsoleto|Report is outdated/i.test(document.body.textContent || '');
    })()
  `);
  return out === true;
}

/**
 * Preme "Aggiorna report" finche' il report non risulta attuale.
 *
 * @returns {Promise<{aggiornato: boolean, click: number}>} `aggiornato:false` significa che il
 *          banner non se n'e' andato entro il tempo: le metriche NON sono affidabili.
 */
export async function attendiReportAggiornato({
  evaluate = realEvaluate, mouseClick = realMouseClick,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 60000, passoMs = 1000,
} = {}) {
  const scadenza = Date.now() + timeoutMs;
  let click = 0;
  // Il banner compare ~226 ms dopo il cambio: una prima occhiata immediata lo mancherebbe.
  await sleep(500);
  for (;;) {
    const esito = await aggiornaReportSeObsoleto({ evaluate, mouseClick, sleep, tentativi: 1, attesaMs: 0 });
    if (esito.cliccato) click += 1;
    else if (!(await reportObsoleto({ evaluate }))) return { aggiornato: true, click };
    if (Date.now() >= scadenza) return { aggiornato: false, click };
    await sleep(passoMs);
  }
}

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
 * Porta il pannello a 'maximized' o a 'normal', e restituisce il modo che c'era PRIMA cosi' che il
 * chiamante possa rimettere le cose com'erano.
 *
 * A cosa serve: a pannello 'normal' il tester occupa ~370px su 994 (misurato), quindi la curva
 * equity dello screenshot e' una striscia di un centinaio di pixel. Massimizzato il pannello e' 994:
 * lo stesso scatto diventa leggibile.
 *
 * ⚠️ Perche' NON si massimizza per tutto il grind ⚠️
 * Massimizzato il chart va a zero e ogni coordinata della toolbar del tester si sposta. Il pulsante
 * del periodo resta raggiungibile (verificato dal vivo il 2026-08-12: box 145,47 293x34), ma l'asse
 * periodo e' quello che si e' rotto tre volte — voci di menu cliccate con eventi mouse veri su
 * coordinate misurate a runtime. Non vale il rischio: l'unico passo che ha bisogno dello spazio e'
 * lo scatto, quindi si massimizza li' e si torna subito indietro.
 *
 * Fallisce in silenzio di proposito: uno screenshot piccolo e' un fastidio, una run persa no.
 *
 * @param {boolean} massimizzato true -> 'maximized', false -> 'normal'
 * @returns {Promise<{ok: boolean, prima: string|null, mode: string|null, error?: string}>}
 */
export async function setPanelMaximized(massimizzato, {
  evaluate = realEvaluate, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 650,
} = {}) {
  const voluto = massimizzato ? 'maximized' : 'normal';
  const esito = await evaluate(`
    (function() {
      function v(x) { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'window.TradingView.bottomWidgetBar non disponibile' };
        var prima = v(bwb.mode && bwb.mode());
        if (prima === ${JSON.stringify(voluto)}) return { ok: true, prima: prima, cambiato: false };
        // setMode() e' esplicito e non e' un toggle: dice DOVE andare, non "inverti".
        // toggleMaximize()/turnOffMaximize() restano come rete se una build futura togliesse setMode.
        if (typeof bwb.setMode === 'function') bwb.setMode(${JSON.stringify(voluto)});
        else if (${massimizzato ? 'true' : 'false'}) { if (typeof bwb.toggleMaximize === 'function') bwb.toggleMaximize(); }
        else if (typeof bwb.turnOffMaximize === 'function') bwb.turnOffMaximize();
        return { ok: true, prima: prima, cambiato: true };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (!esito || esito.error) return { ok: false, prima: null, mode: null, error: esito?.error || 'modo del pannello non impostabile' };
  if (!esito.cambiato) return { ok: true, prima: esito.prima ?? null, mode: esito.prima ?? null };

  // Il cambio di modo rilancia il layout E fa ridisegnare il canvas della curva equity alla nuova
  // dimensione. Scattare prima del ridisegno darebbe un'immagine grande di un grafico piccolo.
  await sleep(settleMs);

  const dopo = await evaluate(`
    (function() {
      function v(x) { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        if (!bwb) return { error: 'bottomWidgetBar sparita' };
        return { mode: v(bwb.mode && bwb.mode()), altezza: v(bwb.height && bwb.height()) };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (!dopo || dopo.error) return { ok: false, prima: esito.prima ?? null, mode: null, error: dopo?.error || 'modo del pannello illeggibile' };
  return { ok: dopo.mode === voluto, prima: esito.prima ?? null, mode: dopo.mode ?? null, altezza: dopo.altezza };
}

/**
 * Il report DEL PERIODO, letto dallo stato React dello Strategy Tester: l'unica fonte di Sharpe e
 * Sortino quando il periodo di test e' ristretto.
 *
 * Perche' serve: "Statistiche chiave" non espone Sharpe e Sortino, e `reportData()` li ha ma per
 * l'intero storico. Risultato misurato: tutti i backtest con `metrics_source: panel` arrivavano con
 * lo Sharpe a null, e ogni collaudo usciva `non_conclusiva` («non ha uno Sharpe registrato»).
 *
 * Dove sta (verificato dal vivo il 2026-09-17 e il 2026-11-03): risalendo la fiber React da
 * `#strategy-report-summary`, uno degli hook state e' il report che il pannello sta disegnando —
 * `settings.dateRange`, `performance.{sharpeRatio,sortinoRatio,all}`, `trades[]`. Il componente e'
 * minificato e cambia con gli aggiornamenti di TradingView: si cerca PER FORMA, mai per percorso.
 * Gli hit sono piu' d'uno (stesso oggetto a livelli diversi); se discordano si dichiara `ambiguous`.
 *
 * Si proietta nella pagina: il report porta `marginUsage` (~270k caratteri), non deve uscire.
 *
 * @returns {Promise<{found: boolean, ambiguous?: boolean, backtest_from?: number, backtest_to?: number,
 *   total_trades?: number, net_profit?: number, sharpe?: number|null, sortino?: number|null, error?: string}>}
 */
export async function readPeriodReport({ evaluate = realEvaluate } = {}) {
  try {
    const out = await evaluate(`
      (function() {
        function fin(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
        var radici = document.querySelectorAll('[id="strategy-report-summary"], #report-tabs, #periodical-tab');
        if (!radici.length) return { found: false, error: 'report del tester non montato (#strategy-report-summary assente)' };
        var hits = [];
        for (var r = 0; r < radici.length; r++) {
          var key = Object.keys(radici[r]).find(function(k) { return k.indexOf('__reactFiber') === 0; });
          var f = key ? radici[r][key] : null;
          for (var lvl = 0; f && lvl < 80; lvl++, f = f.return) {
            var h = f.memoizedState;
            for (var hi = 0; h && hi < 50; hi++, h = h.next) {
              var s = h.memoizedState;
              if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
              if (!s.performance || !s.settings || !s.settings.dateRange || !s.performance.all) continue;
              var bt = s.settings.dateRange.backtest || {};
              var a = s.performance.all;
              hits.push({
                backtest_from: fin(bt.from), backtest_to: fin(bt.to),
                total_trades: fin(a.totalTrades), net_profit: fin(a.netProfit),
                sharpe: fin(s.performance.sharpeRatio), sortino: fin(s.performance.sortinoRatio),
              });
            }
          }
        }
        if (!hits.length) return { found: false, error: 'nessun report del periodo nello stato React del tester' };
        var firma = function(x) { return [x.backtest_from, x.backtest_to, x.total_trades, x.net_profit, x.sharpe].join('|'); };
        var primo = hits[0], ambiguous = false;
        for (var i = 1; i < hits.length; i++) if (firma(hits[i]) !== firma(primo)) ambiguous = true;
        return Object.assign({ found: true, ambiguous: ambiguous }, primo);
      })()
    `);
    return out && typeof out === 'object' ? out : { found: false, error: 'risposta vuota dalla pagina' };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

const GIORNO_MS = 86400000;
const giornoUTC = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const finito = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Sharpe e Sortino dal report del periodo, SOLO se e' lo stesso report che il pannello mostra.
 *
 * Tre controlli, tutti obbligatori — prestare lo Sharpe di un altro periodo e' peggio che non
 * averlo, perche' produce un verdetto di collaudo plausibile e falso:
 *  1. stessi trade del pannello (lo storico intero ne ha di piu': 288 contro 24, misurato);
 *  2. stesso P&L, a meno dell'arrotondamento al centesimo del pannello;
 *  3. date del report dentro il periodo applicato: la prima barra puo' cadere qualche giorno dopo
 *     l'inizio (weekend, festivi), l'ultima qualche giorno prima della fine.
 *
 * Nessuna conversione: lo Sharpe di TradingView e' sui rendimenti mensili e passa com'e'.
 *
 * @returns {{ok: true, sharpe: number, sortino: number|null} | {ok: false, reason: string}}
 */
export function rischioDalReportDelPeriodo(report, { panel = {}, periodo = {} } = {}) {
  if (!report || report.found !== true) {
    return { ok: false, reason: `report del periodo non leggibile: ${report?.error || 'assente'}` };
  }
  if (report.ambiguous) return { ok: false, reason: 'report del periodo ambiguo: lo stato React ne contiene di diversi' };

  const tPanel = finito(panel.total_trades);
  if (tPanel === null || finito(report.total_trades) !== tPanel) {
    return { ok: false, reason: `trade diversi dal pannello (report ${report.total_trades}, pannello ${panel.total_trades}): e' il report di un altro periodo` };
  }
  const pnlPanel = finito(panel.net_profit);
  const pnlReport = finito(report.net_profit);
  if (pnlPanel === null || pnlReport === null || Math.abs(pnlPanel - pnlReport) > 0.011) {
    return { ok: false, reason: `P&L diverso dal pannello (report ${report.net_profit}, pannello ${panel.net_profit})` };
  }

  const da = giornoUTC(periodo.from);
  const a = giornoUTC(periodo.to);
  const rFrom = finito(report.backtest_from);
  const rTo = finito(report.backtest_to);
  if (da === null || a === null || rFrom === null || rTo === null) {
    return { ok: false, reason: 'periodo applicato o date del report non leggibili: coerenza non verificabile' };
  }
  if (rFrom < da - GIORNO_MS || rFrom > da + 5 * GIORNO_MS || rTo > a + 2 * GIORNO_MS || rTo < a - 5 * GIORNO_MS) {
    return {
      ok: false,
      reason: `date del report fuori dal periodo applicato (${new Date(rFrom).toISOString().slice(0, 10)} → ${new Date(rTo).toISOString().slice(0, 10)} contro ${periodo.from} → ${periodo.to})`,
    };
  }

  const sharpe = finito(report.sharpe);
  if (sharpe === null) return { ok: false, reason: 'il report del periodo non ha uno Sharpe numerico (periodo troppo corto?)' };
  return { ok: true, sharpe, sortino: finito(report.sortino) };
}

/**
 * Le metriche correnti del pannello, nella stessa forma di `readReportFor`
 * (`{success, metrics, source, error}`) cosi' che `toFinalizePayload` e `detectAnomaly` non
 * debbano sapere da dove arrivano.
 *
 * NOTA: il blocco "Statistiche chiave" non espone Sharpe e Sortino: li completa il grind con
 * `readPeriodReport` + `rischioDalReportDelPeriodo`, solo se quel report coincide con questo
 * pannello. Altrimenti restano `undefined` e il payload li manda null: e'
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
      // Scheda sbagliata: il tester ha due schede, "Metriche" (id "Strategy report") e "Trade"
      // (id "List of Trades"). TradingView riapre l'ultima usata, e su "Trade" il blocco non
      // esiste: il grind si fermava due volte di fila con runtime_error (sessione 34, 2026-11-15).
      // Si seleziona la scheda del report e si torna "assente": e' il retry del chiamante a
      // rileggere dopo il ridisegno. L'id e' un nome leggibile, non un hash di classe; il
      // data-name e' la riserva. Un .click() del DOM basta (verificato dal vivo).
      var tab = document.getElementById('Strategy report')
        || document.querySelector('[role="tab"][data-name="light-tab-0"]');
      if (tab && tab.getAttribute('aria-selected') !== 'true') {
        tab.click();
        return { stato: 'assente', schedaCambiata: true };
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
    const error = letto && letto.schedaCambiata
      ? 'blocco "Statistiche chiave" non visibile: era attiva la scheda "Trade", passato a "Metriche"'
      : 'blocco "Statistiche chiave" non ancora disponibile (pannello chiuso o in ridisegno)';
    return { success: false, retryable: true, metrics: {}, source: 'panel', error };
  }
  const metrics = parsePannello(testo);
  if (!Object.keys(metrics).length) {
    return { success: false, metrics: {}, source: 'panel', error: `pannello illeggibile: "${testo.slice(0, 120)}"` };
  }
  return { success: true, metrics, source: 'panel' };
}
