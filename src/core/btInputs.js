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
 * ATTENZIONE: la separazione 2/3 si basa sui NOMI (vedi PROPERTY_NAMES) perché TradingView
 * non espone un marcatore strutturale affidabile. Se TV localizzasse quei nomi, il filtro va
 * aggiornato: il sintomo è un 422 "Incomplete inputs" dal finalize, che è la rete di sicurezza
 * lato server.
 */

const SYSTEM_IDS = new Set(['text', 'pineId', 'pineVersion', 'pineFeatures']);

export const PROPERTY_NAMES = new Set([
  'Initial Capital', 'Base Currency', 'Order size', 'Pyramiding',
  'Commission Type', 'Commission Value', 'Verify Price For Limit Orders', 'Slippage',
  'Margin Long', 'Margin Short', 'Recalculate After Order Filled',
  'Recalculate On Every Tick', 'Use Bar Magnifier', 'Fill Orders On Bar Close',
]);

export function classifyInputs(info) {
  const system = [];
  const logic = [];
  const properties = [];
  for (const item of info || []) {
    if (!item || !item.id) continue;
    if (SYSTEM_IDS.has(item.id) || !/^in_\d+$/.test(item.id)) { system.push(item); continue; }
    if (PROPERTY_NAMES.has(String(item.name || '').trim())) { properties.push(item); continue; }
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
