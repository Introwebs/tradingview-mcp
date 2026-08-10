/**
 * Costruzione del campo `inputs` del finalize a partire dalla strategia VIVA.
 *
 * getInputsInfo() restituisce tre blocchi mescolati in un solo array:
 *   1. campi di SISTEMA in testa (text = sorgente compilato, pineId, pineVersion, pineFeatures)
 *   2. gli input di LOGICA della strategia (in_0..in_N)
 *   3. il blocco PROPRIETÀ esposto come input (Initial Capital, Margin Long, ...)
 *
 * Solo il blocco 2 va nel campo `inputs` del finalize, e con chiave = NOME leggibile
 * (regola operativa: "in_18 = 240" non dice nulla a chi legge la piattaforma; "Risk/Reward = 2.5" sì).
 * Il blocco 3 finisce in extra_metrics; il blocco 1 non si tocca mai.
 *
 * La separazione 2/3 usa DUE condizioni insieme: assenza di `group` E nome nella lista
 * verificata. Vedi il commento di classifyInputs per il perché.
 */

const SYSTEM_IDS = new Set(['text', 'pineId', 'pineVersion', 'pineFeatures']);

// Lista VERIFICATA dal vivo (2026-08-10) su tre strategie reali via getInputsInfo().
// NON aggiungere nomi "plausibili" senza averli visti: la prima versione di questa lista era
// per metà inventata ('Order size', 'Slippage', 'Recalculate After Order Filled'... non
// esistono) e avrebbe fatto passare 18 Proprietà per input di logica, scrivendole dentro
// `inputs` di ogni backtest. In silenzio: il finalize lato server rifiuta quando le chiavi
// sono MENO del previsto, mai quando sono di più.
export const PROPERTY_NAMES = new Set([
  'Initial Capital',
  'Base Currency',
  'Default entry/order Qty Type',
  'Default entry/order Qty Value',
  'pyramiding',
  'Commission Type',
  'Commission Value',
  'Margin Long',
  'Margin Short',
  'Process orders on bar Close',
  'Calculate Strategy on every Tick(s)',
  "Calculate Strategy on Order's Fill(s)",
  'Calculate Strategy on every History Tick',
  'Backtesting Limit Order(s) fill assumption',
  'Backtesting slippage for market orders',
  'Close entries rule',
  'Risk free rate',
  'Use Bar Magnifier',
  'Fill orders using standard OHLC',
  "Run mode: 'backtest', 'alert' or something else",
  "Alert message template for run mode 'alert'",
  "Alert type for run mode 'alert'",
  'exclude_from_report',
  'trim_orders',
  'calc_range',
]);

/**
 * Proprietà = NESSUN group E nome nella lista verificata.
 *
 * Le due condizioni insieme perché ognuna da sola sbaglia. Il `group` (il `group=` dichiarato
 * in Pine, che TradingView riporta in getInputsInfo) è nullo su tutto il blocco Proprietà, ma
 * anche su un input di logica dichiarato senza `group=`: da solo lo scambierebbe per una
 * Proprietà, facendolo sparire da `inputs`. I nomi da soli si rompono se TradingView li cambia.
 *
 * Insieme, un eventuale disallineamento sbaglia nella direzione giusta: fa scivolare una
 * Proprietà dentro `inputs`, dove si vede leggendo la piattaforma, invece di far sparire un
 * input di logica, che nessuno noterebbe.
 */
export function classifyInputs(info) {
  const system = [];
  const logic = [];
  const properties = [];
  for (const item of info || []) {
    if (!item || !item.id) continue;
    if (SYSTEM_IDS.has(item.id) || !/^in_\d+$/.test(item.id)) { system.push(item); continue; }
    if (!item.group && PROPERTY_NAMES.has(String(item.name || '').trim())) { properties.push(item); continue; }
    logic.push(item);
  }
  return { system, logic, properties };
}

/**
 * @param {Array} info  output (trimmato) di getInputsInfo(): {id, name, type}
 * @param {Object} values  mappa id → valore corrente (da getInputValues)
 * @returns {{inputs: Object, properties: Object, initialCapital: number|null}}
 */
export function buildInputsPayload(info, values = {}) {
  const { logic, properties: propItems } = classifyInputs(info);

  const inputs = {};
  for (const item of logic) {
    const name = String(item.name || item.id);
    // Nomi duplicati: il PRIMO tiene il nome nudo, gli altri prendono " (in_K)".
    // Serve a mantenere il conteggio delle chiavi = numero di input di logica, che è
    // esattamente ciò che il finalize verifica lato server.
    const key = Object.prototype.hasOwnProperty.call(inputs, name) ? `${name} (${item.id})` : name;
    inputs[key] = values[item.id];
  }

  const properties = {};
  for (const item of propItems) properties[String(item.name || item.id)] = values[item.id];

  const cap = properties['Initial Capital'];
  const initialCapital = typeof cap === 'number' ? cap : cap != null && !Number.isNaN(Number(cap)) ? Number(cap) : null;

  return { inputs, properties, initialCapital };
}
