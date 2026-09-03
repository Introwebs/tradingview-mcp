/**
 * Letture della strategia viva usate dal grind. `evaluate` è iniettabile per i test.
 *
 * REGOLA DURA: la proiezione a {id,name,type} avviene DENTRO la pagina. getInputsInfo()
 * include il campo di sistema `text` = sorgente compilato, un blob da centinaia di KB:
 * farlo transitare fuori dalla pagina è ciò che faceva schizzare il contesto del modello a
 * 100k+ alla prima lettura. Il grind lo elimina alla fonte.
 */
import { evaluate as realEvaluate, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

/**
 * Helper condivisi iniettati nella pagina: trovano la data source di UNA strategia per id.
 *
 * Perché tutto passa di qui: l'API interna di TradingView non offre un "dammi il report di
 * questa strategia". `getStrategyResults()` risolve cercando la PRIMA data source con un report
 * calcolato — e con più strategie sul chart quella non è necessariamente la nostra. Verificato
 * dal vivo il 2026-08-11: su un chart con `Imbalance Strategy` (ordine 10) e `Index Grow Test
 * Claude` (ordine 6, nascosta), una sola lettura bastava a far registrare i numeri della
 * seconda al posto della prima. Qui la strategia si indirizza SEMPRE per id.
 */
const SRC_BY_ID_JS = `
  function _paUnwrap(v) { return (v && typeof v.value === 'function') ? v.value() : v; }
  function _paSourceById(wantId) {
    var cw = ${CHART_API}._chartWidget;
    var srcs = cw.model().model().dataSources();
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      if (typeof s.reportData !== 'function') continue;
      var sid = (typeof s.id === 'function') ? s.id() : s.id;
      if (sid === wantId) return s;
    }
    return null;
  }
`;

export async function readInputsInfo(entityId, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      var study = ${CHART_API}.getStudyById(${safeString(entityId)});
      if (!study) return JSON.stringify([]);
      var info = study.getInputsInfo() || [];
      var map = [];
      for (var i = 0; i < info.length; i++) {
        var x = info[i];
        if (!x || !x.id) continue;
        // group = il group= dichiarato in Pine. Serve a distinguere gli input di logica dal
        // blocco Proprieta, che TradingView appende senza group (vedi btInputs.classifyInputs).
        // E una stringa corta: nessun rischio di trascinare fuori blob dalla pagina.
        map.push({ id: x.id, name: String(x.name || '').slice(0, 60), type: x.type, group: x.group || null });
      }
      return JSON.stringify(map);
    })()
  `);
  try { return typeof out === 'string' ? JSON.parse(out) : (out || []); }
  catch { return []; }
}

export async function readInputValues(entityId, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      var study = ${CHART_API}.getStudyById(${safeString(entityId)});
      if (!study) return {};
      var vals = study.getInputValues() || [];
      var byId = {};
      for (var i = 0; i < vals.length; i++) {
        var v = vals[i];
        if (!v || !v.id) continue;
        // Il valore del campo di sistema \`text\` è il sorgente compilato: mai farlo uscire.
        if (typeof v.value === 'string' && v.value.length > 500) continue;
        byId[v.id] = v.value;
      }
      return byId;
    })()
  `);
  return out || {};
}

/**
 * L'entity_id della strategia il cui report e' effettivamente calcolato, cioe' quella
 * selezionata nel pannello Strategy Tester.
 *
 * Serve perche' getStrategyResults() NON accetta un entity_id: cerca "la prima strategia con
 * un report" e restituisce quella. Con piu' strategie sul chart (il caso normale) il grind
 * rischia di applicare gli input a una e leggere le metriche di un'altra, senza accorgersene:
 * i numeri sarebbero plausibili e nessun controllo scatterebbe. Verificato dal vivo il
 * 2026-08-10 su un chart con due strategie: solo quella selezionata nel pannello aveva
 * reportData().performance, l'altra tornava null.
 *
 * @returns {Promise<string|null>} l'id, o null se nessuna strategia ha un report calcolato
 */
export async function readComputedReportEntityId({ evaluate = realEvaluate } = {}) {
  return evaluate(`
    (function() {
      try {
        var cw = ${CHART_API}._chartWidget;
        var srcs = cw.model().model().dataSources();
        for (var i = 0; i < srcs.length; i++) {
          var s = srcs[i];
          if (typeof s.reportData !== 'function') continue;
          var rd = s.reportData();
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (!rd || !rd.performance) continue;
          return (typeof s.id === 'function') ? s.id() : (s.id || null);
        }
        return null;
      } catch (e) { return null; }
    })()
  `);
}

/**
 * Il booleano `isLoading()` della strategia con quell'id: `true` esattamente mentre TradingView
 * sta ricalcolando. È il segnale AUTORITATIVO sul quale `waitForRecalc` si sincronizza, al posto
 * di indovinare dal movimento dei numeri.
 *
 * Misurato dal vivo il 2026-08-11 (campionamento a 50 ms nella stessa evaluate del set, quindi
 * senza latenza di round-trip): dopo un `setValue` su un input, `isLoading()` passa a true in
 * 616-670 ms e resta true per 1,1-1,2 s. Le metriche nuove compaiono al ritorno a false.
 *
 * @returns {Promise<boolean|null>} null se la strategia non è sul chart o non espone isLoading
 */
export async function readStrategyLoading(entityId, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      ${SRC_BY_ID_JS}
      try {
        var s = _paSourceById(${safeString(entityId)});
        if (!s || typeof s.isLoading !== 'function') return null;
        return !!s.isLoading();
      } catch (e) { return null; }
    })()
  `);
  return typeof out === 'boolean' ? out : null;
}

/**
 * Lo stato di salute dello studio, letto da TradingView invece che dedotto.
 *
 * `study.status()` ritorna `{type, errorDescription:{error, title}}`. `type: 3` è un errore di
 * RUNTIME: il sorgente compila benissimo — l'editor non segnala nulla — ma il ricalcolo non parte
 * e il report non esiste. Da fuori è indistinguibile da una strategia che semplicemente non fa
 * trade, ed è per questo che va CHIESTO invece che dedotto dai numeri.
 *
 * Il caso che ha reso necessaria questa funzione (sessione 66, 2026-08-24): applicare una stringa
 * vuota a un input di tipo `resolution` manda lo studio in `Can't parse pine`. Il grind ha macinato
 * tre run a zero trade e ha concluso «non è il periodo, è la configurazione» — una diagnosi
 * sbagliata, quindi peggiore del silenzio, perché manda a cercare dalla parte opposta.
 *
 * ⚠️ In dubbio si dichiara SANO (`ok: true`, `type: null`). Questa è una guardia, non un oracolo:
 * se TradingView cambia le sue API interne deve degradare a nulla, non fermare una matrice sana.
 *
 * @returns {Promise<{ok: boolean, type: number|null, error: string|null}>}
 */
export async function readStudyStatus(entityId, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      ${SRC_BY_ID_JS}
      try {
        var s = _paSourceById(${safeString(entityId)});
        if (!s || typeof s.status !== 'function') return null;
        var st = s.status();
        if (!st || typeof st.type !== 'number') return null;
        var d = st.errorDescription || null;
        return { type: st.type, error: d ? (d.error || d.title || null) : null };
      } catch (e) { return null; }
    })()
  `);
  if (!out || typeof out.type !== 'number') return { ok: true, type: null, error: null };
  return { ok: out.type !== 3, type: out.type, error: out.error || null };
}

/**
 * Le metriche della strategia con quell'id, nella stessa forma di `getStrategyResults()`
 * (`{success, metrics, currency, error}`) così che `toFinalizePayload` e `detectAnomaly`
 * non debbano sapere da dove arrivano.
 *
 * Due differenze deliberate rispetto a `getStrategyResults()`, ed entrambe sono il motivo per
 * cui questa funzione esiste:
 *   1. indirizza la strategia per id invece di prendere la prima con un report;
 *   2. NON rende visibile niente. L'unhide di massa di `ensureStrategyTesterReady()` accendeva
 *      ogni strategia nascosta del chart: quella appena accesa calcolava il proprio report e,
 *      se stava prima nell'ordine delle data source, se lo prendeva. La visibilità la gestisce
 *      `ensureVisibleFor`, sulla sola strategia bersaglio.
 */
export async function readReportFor(entityId, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      ${SRC_BY_ID_JS}
      try {
        var s = _paSourceById(${safeString(entityId)});
        if (!s) return { success: false, metrics: {}, error: 'strategia ' + ${safeString(entityId)} + ' non trovata fra le data source del chart' };
        var rd = _paUnwrap(s.reportData());
        if (!rd || !rd.performance) {
          return { success: false, metrics: {}, error: 'report non ancora calcolato per ' + ${safeString(entityId)} + ' (strategia nascosta, o ricalcolo in corso)' };
        }
        var perf = rd.performance;
        var all = perf.all || {};
        var m = {
          net_profit: all.netProfit,
          net_profit_percent: all.netProfitPercent,
          gross_profit: all.grossProfit,
          gross_loss: all.grossLoss,
          profit_factor: all.profitFactor,
          max_drawdown: perf.maxStrategyDrawDown,
          max_drawdown_percent: perf.maxStrategyDrawDownPercent,
          total_trades: (all.numberOfWiningTrades || 0) + (all.numberOfLosingTrades || 0),
          winning_trades: all.numberOfWiningTrades,
          losing_trades: all.numberOfLosingTrades,
          percent_profitable: all.percentProfitable,
          avg_trade: all.avgTrade,
          largest_win: all.largestWinTrade,
          largest_loss: all.largestLosTrade,
          commission_paid: all.commissionPaid,
          sharpe_ratio: perf.sharpeRatio,
          sortino_ratio: perf.sortinoRatio,
          buy_hold_return: perf.buyHoldReturn,
          open_pl: perf.openPL
        };
        var clean = {};
        for (var k in m) { if (m[k] !== null && m[k] !== undefined) clean[k] = m[k]; }
        return { success: true, metrics: clean, currency: rd.currency || null, entity_id: ${safeString(entityId)} };
      } catch (e) { return { success: false, metrics: {}, error: e.message }; }
    })()
  `);
  if (!out || typeof out !== 'object') {
    return { success: false, metrics: {}, error: 'lettura del report non riuscita (nessuna risposta dalla pagina)' };
  }
  return { ...out, metrics: out.metrics || {} };
}

/**
 * Quanto la strategia ha pagato di commissioni e su quante unita' (somma delle qty di ogni fill).
 *
 * Serve alla verifica del rate implicito delle varianti di costo: `commission_paid / filled_qty_sum`
 * deve coincidere col valore scritto in "Commission Value". E' un RAPPORTO, quindi e' indipendente
 * dal periodo di test SOLO se il report e' stato ricalcolato DOPO l'impostazione del Commission
 * Value — sta al chiamante aspettare il ricalcolo prima di leggere qui (il grind lo fa gia').
 * Si proiettano solo tre numeri: `reportData()` porta `marginUsage` (~270k caratteri).
 *
 * Stesso contratto di `readReportFor`: report non ancora calcolato è `success: false`, MAI
 * `commission_paid: 0` — uno zero apparente e uno zero vero sarebbero indistinguibili a valle.
 */
export async function readCommissionFor(entityId, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      ${SRC_BY_ID_JS}
      try {
        var s = _paSourceById(${safeString(entityId)});
        if (!s) return { success: false, error: 'strategia ' + ${safeString(entityId)} + ' non trovata fra le data source del chart' };
        var rd = _paUnwrap(s.reportData());
        if (!rd || !rd.performance) {
          return { success: false, error: 'report non ancora calcolato per ' + ${safeString(entityId)} + ' (strategia nascosta, o ricalcolo in corso)' };
        }
        var all = rd.performance.all || {};
        if (typeof all.commissionPaid !== 'number') {
          return { success: false, error: 'commissionPaid assente nel report' };
        }
        var fills = _paUnwrap(rd.filledOrders);
        if (!Array.isArray(fills)) fills = [];
        var q = 0;
        for (var i = 0; i < fills.length; i++) q += Math.abs(Number(fills[i].q) || 0);
        return { success: true, commission_paid: all.commissionPaid, filled_qty_sum: q, fills: fills.length, entity_id: ${safeString(entityId)} };
      } catch (e) { return { success: false, error: e.message }; }
    })()
  `);
  if (!out || typeof out !== 'object') return { success: false, error: 'lettura commissioni non riuscita (nessuna risposta dalla pagina)' };
  return out;
}

/**
 * Rende visibile SOLO la strategia bersaglio, e dice se era nascosta (per poterla rimettere
 * com'era a fine grind). TradingView non calcola il report di una strategia invisibile, quindi
 * un minimo di unhide serve — ma va limitato a una sola strategia.
 *
 * @returns {Promise<{found: boolean, wasHidden: boolean, visible: boolean}>}
 */
export async function ensureVisibleFor(entityId, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      ${SRC_BY_ID_JS}
      try {
        var s = _paSourceById(${safeString(entityId)});
        if (!s) return { found: false, wasHidden: false, visible: false };
        var was = null;
        try { was = s.properties().visible.value(); } catch (e) {}
        if (was === false) {
          try { s.properties().visible.setValue(true); } catch (e) {}
        }
        var now = null;
        try { now = s.properties().visible.value(); } catch (e) {}
        return { found: true, wasHidden: was === false, visible: now !== false };
      } catch (e) { return { found: false, wasHidden: false, visible: false }; }
    })()
  `);
  return out && typeof out === 'object' ? out : { found: false, wasHidden: false, visible: false };
}

/** Riporta la visibilità di UNA strategia al valore dato (usata per ripristinare a fine grind). */
export async function setStrategyVisibility(entityId, visible, { evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      ${SRC_BY_ID_JS}
      try {
        var s = _paSourceById(${safeString(entityId)});
        if (!s) return false;
        s.properties().visible.setValue(${visible ? 'true' : 'false'});
        return true;
      } catch (e) { return false; }
    })()
  `);
  return out === true;
}

/** true se ogni chiave richiesta risulta applicata sul chart (confronto tollerante sui numeri). */
export function readbackMatches(requested = {}, actual = {}) {
  for (const [k, want] of Object.entries(requested)) {
    const got = actual[k];
    if (got === want) continue;
    const a = Number(want);
    const b = Number(got);
    if (Number.isFinite(a) && Number.isFinite(b) && a === b) continue;
    return false;
  }
  return true;
}
