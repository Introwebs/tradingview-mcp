/**
 * Funzioni PURE delle varianti di costo e della replica di un backtest sul chart.
 * Niente I/O qui: tutto cio' che si puo' testare senza TradingView sta in questo file.
 */

const SYSTEM_IDS = new Set(['text', 'pineId', 'pineVersion', 'pineFeatures']);

/** Gli id delle due Proprieta' della commissione, trovati PER NOME (variano per script). */
export function resolveCommissionIds(info) {
  const byName = (n) => (info || []).find((i) => i && !i.group && String(i.name || '').trim() === n);
  const type = byName('Commission Type');
  const value = byName('Commission Value');
  return type && value ? { typeId: type.id, valueId: value.id } : null;
}

/**
 * TV applica `commissione = qty × rate` per ordine, quindi sull'intero report
 * `commission_paid / Σ qty(fill) == rate`. Un rapporto: non risente del periodo di test.
 * `commission_paid` non numerico = report non letto: NON e' un mismatch, e' "non verificabile".
 */
export function checkImpliedRate({ commission_paid, filled_qty_sum, expected, tolerance = 1e-4 }) {
  if (typeof commission_paid !== 'number' || !Number.isFinite(commission_paid)) {
    return { ok: false, implied_rate: null, detail: 'commissione pagata non letta dal report: rate implicito non verificabile' };
  }
  const q = Number(filled_qty_sum) || 0;
  if (q <= 0) return { ok: false, implied_rate: null, detail: 'nessun fill nel report: rate implicito non verificabile' };
  const implied = commission_paid / q;
  const exp = Number(expected) || 0;
  const rel = exp === 0 ? Math.abs(implied) : Math.abs(implied - exp) / Math.abs(exp);
  if (rel <= tolerance) return { ok: true, implied_rate: implied, detail: null };
  return { ok: false, implied_rate: implied, detail: `rate implicito ${trim(implied)} invece di ${trim(exp)}` };
}

/**
 * La variante a commissione 0 e' il run di CONTROLLO: se non riproduce il padre, l'identita' del
 * re-run non e' preservata e nessuna variante della batch e' attendibile.
 */
export function checkControlRun({ variant, parent, tolerance = 0.001 }) {
  const paid = Number(variant?.commission_paid) || 0;
  if (paid !== 0) return { ok: false, detail: `commissioni pagate ${trim(paid)} sul run di controllo (attese 0)` };
  const tv = Math.round(Number(variant?.total_trades) || 0);
  const tp = Math.round(Number(parent?.total_trades) || 0);
  if (tv !== tp) return { ok: false, detail: `${tv} trade contro ${tp} del padre` };
  const nv = Number(variant?.net_profit) || 0;
  const np = Number(parent?.net_profit) || 0;
  const diff = np === 0 ? Math.abs(nv - np) : Math.abs(nv - np) / Math.abs(np);
  if (diff > tolerance) return { ok: false, detail: `net ${trim(nv)} contro ${trim(np)} del padre (oltre lo 0,1%)` };
  return { ok: true, detail: null };
}

/** La strategia sul chart col titolo atteso: esatto, poi case-insensitive. */
export function resolveStrategyEntity(state, strategyName) {
  const studies = Array.isArray(state?.studies) ? state.studies : [];
  const wanted = String(strategyName || '').trim();
  const titoli = studies.map((s) => s.name).join(', ') || '(nessuno)';
  if (!wanted) return { error: { kind: 'strategy_not_on_chart', detail: `nome strategia assente; sul chart: ${titoli}` } };
  let hits = studies.filter((s) => String(s.name || '').trim() === wanted);
  if (!hits.length) hits = studies.filter((s) => String(s.name || '').trim().toLowerCase() === wanted.toLowerCase());
  if (!hits.length) return { error: { kind: 'strategy_not_on_chart', detail: `attesa "${wanted}", sul chart: ${titoli}` } };
  if (hits.length > 1) return { error: { kind: 'strategy_ambiguous', detail: `${hits.length} studi col titolo "${wanted}" (${hits.map((h) => h.id).join(', ')})` } };
  return { entity_id: hits[0].id };
}

/**
 * Traduce gli input di un backtest nella mappa id → valore della strategia VIVA.
 * Accetta sia il dizionario per nome (`inputs`, con eventuali id `in_K` in mezzo — succede)
 * sia l'archivio per id (`applied_inputs`: id → {value, type, block}).
 * Un id di sistema (`text`, `pineId`…) si ignora; una chiave che non si risolve e' un segnale
 * di versione diversa e va riportata, non saltata.
 */
export function resolveInputKeys(info, inputs) {
  const items = (info || []).filter((i) => i && i.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const byName = new Map();
  for (const i of items) { const n = String(i.name || '').trim(); if (n && !byName.has(n)) byName.set(n, i); }
  const resolved = {};
  const unresolved = [];
  const ignored = [];
  for (const [key, raw] of Object.entries(inputs || {})) {
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    if (SYSTEM_IDS.has(key)) { ignored.push(key); continue; }
    if (raw && typeof raw === 'object' && 'value' in raw && value === null) continue;
    const item = byId.get(key) || byName.get(String(key).trim());
    if (!item) { unresolved.push(key); continue; }
    resolved[item.id] = value;
  }
  return { resolved, unresolved, ignored };
}

function trim(n) {
  return Number.isFinite(n) ? String(Number(n.toPrecision(10))) : String(n);
}
