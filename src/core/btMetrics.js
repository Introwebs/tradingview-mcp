/**
 * Mapping metriche TradingView → payload di finalize Pine Algos, e rilevamento anomalie.
 *
 * TradingView espone le percentuali come 12.345 (= 12,345%); l'API Pine Algos le vuole
 * come ratio 0-1 (obiettivi e is_best sono valutati su quella scala). La conversione sta
 * QUI e in nessun altro posto.
 */

const CORE_KEYS = new Set([
  'net_profit', 'net_profit_percent', 'max_drawdown', 'max_drawdown_percent',
  'profit_factor', 'total_trades', 'percent_profitable', 'sharpe_ratio', 'sortino_ratio',
]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v) => (num(v) === null ? null : num(v) / 100);

/**
 * @param {Object} tv  metrics di getStrategyResults()
 * @param {Object} ctx {symbol, timeframe, period_start, period_end, initial_capital, inputs, properties}
 */
export function toFinalizePayload(tv = {}, ctx = {}) {
  const extra = {};
  for (const [k, v] of Object.entries(tv)) if (!CORE_KEYS.has(k)) extra[k] = v;
  if (ctx.properties && Object.keys(ctx.properties).length) extra.properties = ctx.properties;

  const totalTrades = Math.round(num(tv.total_trades) ?? 0);

  // TradingView riporta profitFactor come Infinity (o lo omette del tutto, undefined) quando
  // la strategia non ha NESSUN trade in perdita: profit_factor = grossProfit / grossLoss e
  // grossLoss è 0. num() scarta i valori non finiti, quindi senza questa correzione il
  // payload finirebbe con profit_factor: 0 — il valore semanticamente OPPOSTO a quello vero
  // (0 = pessimo, mentre "nessuna perdita" è il caso migliore possibile).
  //
  // Non è cosmetico: la piattaforma normalizza le metriche col min-max ALL'INTERNO della
  // sessione per calcolare il punteggio che sceglie il miglior backtest. Un run senza perdite
  // verrebbe classificato come il peggiore della matrice.
  //
  // Perché si scrive 100 e non un numero enorme tipo 9999: il min-max della sessione
  // schiaccerebbe a zero il profit factor di TUTTI gli altri backtest, falsando la classifica
  // dell'intera sessione. 100 resta chiaramente "ottimo" senza distruggere la scala. Il flag
  // `profit_factor_capped` va letto come "nessun trade in perdita" — NON come se 100 fosse un
  // valore realmente misurato. Se non ci sono trade, 0 resta corretto: non c'è nulla da limitare.
  let profitFactor = num(tv.profit_factor) ?? 0;
  if (!Number.isFinite(tv.profit_factor) && totalTrades > 0) {
    profitFactor = 100;
    extra.profit_factor_capped = true;
  }

  return {
    symbol: ctx.symbol,
    timeframe: ctx.timeframe,
    period_start: ctx.period_start,
    period_end: ctx.period_end,
    initial_capital: ctx.initial_capital,
    inputs: ctx.inputs || {},
    net_profit: num(tv.net_profit) ?? 0,
    net_profit_pct: pct(tv.net_profit_percent) ?? 0,
    max_drawdown: num(tv.max_drawdown) ?? 0,
    max_drawdown_pct: pct(tv.max_drawdown_percent) ?? 0,
    win_rate: pct(tv.percent_profitable) ?? 0,
    profit_factor: profitFactor,
    total_trades: totalTrades,
    sharpe: num(tv.sharpe_ratio),
    sortino: num(tv.sortino_ratio),
    extra_metrics: extra,
  };
}

/** Firma compatta delle metriche core: serve a capire se il ricalcolo ha prodotto un risultato nuovo. */
export function fingerprint(tv = {}) {
  return [
    tv.net_profit, tv.max_drawdown, tv.profit_factor,
    tv.total_trades, tv.percent_profitable,
  ].map((v) => (v == null ? '-' : String(v))).join('|');
}

/**
 * Traduce in codice il circuit breaker operativo: su anomalia ci si FERMA e si segnala,
 * non si ritenta e non si continua a variare a caso.
 * Ritorna null se tutto è regolare, altrimenti {kind, detail}.
 *
 * Nota sul caso `sameAsPrevious`: metriche identiche NON sono di per sé un'anomalia — due set di
 * input diversi possono legittimamente produrre lo stesso risultato (es. un filtro che non si
 * attiva mai). Diventa anomalia solo se il READBACK dice che i valori non sono stati applicati:
 * quello è il no-op silenzioso noto dei dropdown input.string con options.
 */
export function detectAnomaly({ setResult, results, readbackOk = true, sameAsPrevious = false } = {}) {
  const missing = setResult?.missing || [];
  if (missing.length) {
    return { kind: 'inputs_not_applied', detail: `id non applicati: ${missing.join(', ')}` };
  }
  if (!results || results.success === false) {
    return { kind: 'runtime_error', detail: results?.error || 'report della strategia non disponibile' };
  }
  if (!readbackOk) {
    return sameAsPrevious
      ? { kind: 'silent_noop', detail: 'valori non confermati dal readback e metriche invariate' }
      : { kind: 'readback_mismatch', detail: 'i valori riletti non corrispondono a quelli richiesti' };
  }
  if (Math.round(results.metrics?.total_trades ?? 0) === 0) {
    return { kind: 'zero_trades', detail: 'la strategia non ha prodotto alcun trade (verifica badge errore, pannello, leva e size nelle Proprietà)' };
  }
  return null;
}
