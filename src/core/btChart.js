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
