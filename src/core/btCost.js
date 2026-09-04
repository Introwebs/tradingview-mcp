/**
 * Funzioni PURE delle varianti di costo e della replica di un backtest sul chart.
 * Niente I/O qui: tutto cio' che si puo' testare senza TradingView sta in questo file.
 */

const SYSTEM_IDS = new Set(['text', 'pineId', 'pineVersion', 'pineFeatures']);
const HOMONYM_RE = /^(.*) \((in_\d+)\)$/;

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
 * `kind` distingue i due esiti negativi come in checkControlRun: 'mismatch' | 'unverifiable' | null.
 * Valida SOLO per commissioni di tipo `cash_per_contract` (qty × rate) — l'unico tipo che
 * la piattaforma crea; altri tipi (percent, cash_per_order) non seguono questa proporzionalita'.
 */
export function checkImpliedRate({ commission_paid, filled_qty_sum, expected, tolerance = 1e-4 }) {
  if (typeof commission_paid !== 'number' || !Number.isFinite(commission_paid)) {
    return { ok: false, kind: 'unverifiable', implied_rate: null, detail: 'commissione pagata non letta dal report: rate implicito non verificabile' };
  }
  if (typeof expected !== 'number' || !Number.isFinite(expected)) {
    return { ok: false, kind: 'unverifiable', implied_rate: null, detail: 'commissione attesa non numerica: non verificabile' };
  }
  const q = Number(filled_qty_sum) || 0;
  if (q <= 0) return { ok: false, kind: 'unverifiable', implied_rate: null, detail: 'nessun fill nel report: rate implicito non verificabile' };
  const implied = commission_paid / q;
  const rel = expected === 0 ? Math.abs(implied) : Math.abs(implied - expected) / Math.abs(expected);
  if (rel <= tolerance) return { ok: true, kind: null, implied_rate: implied, detail: null };
  return { ok: false, kind: 'mismatch', implied_rate: implied, detail: `rate implicito ${fmtNum(implied)} invece di ${fmtNum(expected)}` };
}

/**
 * La variante a commissione 0 e' il run di CONTROLLO: se non riproduce il padre, l'identita' del
 * re-run non e' preservata e nessuna variante della batch e' attendibile.
 * Un padre non leggibile (total_trades/net_profit assenti) o una commissione pagata non letta
 * NON sono un mismatch: sono "unverifiable" — non c'e' niente da confrontare, non un errore di 0 trade.
 */
export function checkControlRun({ variant, parent, tolerance = 0.001 }) {
  const paid = variant?.commission_paid;
  if (typeof paid !== 'number' || !Number.isFinite(paid)) {
    return { ok: false, kind: 'unverifiable', detail: 'commissione pagata sul run di controllo non letta: controllo non verificabile' };
  }
  if (paid !== 0) return { ok: false, kind: 'mismatch', detail: `commissioni pagate ${fmtNum(paid)} sul run di controllo (attese 0)` };

  // ⚠️ Il padre arriva dall'API, e li' i decimali sono STRINGHE: `net_profit` e' "4061.6300", non
  // 4061.63 (cast decimal di Laravel). Un `typeof === 'number'` secco su questi campi legge come
  // "padre assente" un padre perfettamente leggibile — misurato il 2026-09-04 sul #1056, il run di
  // controllo dichiarato non verificabile con tutti i dati sotto il naso. Si converte, e si chiama
  // assente solo cio' che non e' un numero nemmeno dopo la conversione.
  const tp = numeroLeggibile(parent?.total_trades);
  const np = numeroLeggibile(parent?.net_profit);
  if (tp === null || np === null) {
    const mancanti = [tp === null ? 'total_trades' : null, np === null ? 'net_profit' : null].filter(Boolean).join(' e ');
    return { ok: false, kind: 'unverifiable', detail: `padre non leggibile (${mancanti} non numerici): controllo non verificabile` };
  }

  const tv = Math.round(Number(variant?.total_trades) || 0);
  if (tv !== Math.round(tp)) return { ok: false, kind: 'mismatch', detail: `${tv} trade contro ${Math.round(tp)} del padre` };

  const nv = Number(variant?.net_profit) || 0;
  const diff = np === 0 ? Math.abs(nv - np) : Math.abs(nv - np) / Math.abs(np);
  if (diff > tolerance) {
    return { ok: false, kind: 'mismatch', detail: `net ${fmtNum(nv)} contro ${fmtNum(np)} del padre (oltre lo ${fmtPct(tolerance)}%)` };
  }
  return { ok: true, kind: null, detail: null };
}

/** La strategia sul chart col titolo atteso: esatto, poi case-insensitive; poi errore di runtime. */
export function resolveStrategyEntity(state, strategyName) {
  const studies = Array.isArray(state?.studies) ? state.studies : [];
  const wanted = String(strategyName || '').trim();
  const titoli = studies.map((s) => s?.name).join(', ') || '(nessuno)';
  if (!wanted) return { error: { kind: 'strategy_not_on_chart', detail: `nome strategia assente; sul chart: ${titoli}` } };
  let hits = studies.filter((s) => s && String(s.name || '').trim() === wanted);
  if (!hits.length) hits = studies.filter((s) => s && String(s.name || '').trim().toLowerCase() === wanted.toLowerCase());
  if (!hits.length) return { error: { kind: 'strategy_not_on_chart', detail: `attesa "${wanted}", sul chart: ${titoli}` } };
  if (hits.length > 1) return { error: { kind: 'strategy_ambiguous', detail: `${hits.length} studi col titolo "${wanted}" (${hits.map((h) => h.id).join(', ')})` } };
  const hit = hits[0];
  if (hit && hit.error) {
    return { error: { kind: 'strategy_in_error', detail: `la strategia "${wanted}" è in errore di runtime: ${hit.error}` } };
  }
  return { entity_id: hit.id };
}

/**
 * Traduce gli input di un backtest nella mappa id → valore della strategia VIVA.
 * Accetta sia il dizionario per nome (`inputs`, con eventuali id `in_K` in mezzo — succede)
 * sia l'archivio per id (`applied_inputs`: id → {value, type, block}).
 * Un id di sistema (`text`, `pineId`…) si ignora; una chiave che non si risolve e' un segnale
 * di versione diversa e va riportata, non saltata.
 * Chiavi omonime: `buildInputsPayload` (btInputs.js) tiene il nome nudo per il primo input
 * duplicato e usa `"Nome (in_K)"` per gli altri — quella forma si risolve per id (in_K), non
 * per nome, altrimenti tutti gli omonimi finirebbero sullo stesso id.
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
    const homonym = HOMONYM_RE.exec(key);
    const item = byId.get(key) || (homonym && byId.get(homonym[2])) || byName.get(String(key).trim());
    if (!item) { unresolved.push(key); continue; }
    resolved[item.id] = value;
  }
  return { resolved, unresolved, ignored };
}

/**
 * Il numero che c'e' davvero, o null. Accetta le stringhe numeriche dell'API (i decimali di Laravel
 * viaggiano come "4061.6300"); rifiuta null, undefined, stringa vuota, booleani e qualunque cosa non
 * si converta. "Assente" e "zero" restano distinguibili, che e' tutto il punto.
 */
function numeroLeggibile(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(n) {
  return Number.isFinite(n) ? String(Number(n.toPrecision(10))) : String(n);
}

function fmtPct(tolerance) {
  return String(tolerance * 100).replace('.', ',');
}
