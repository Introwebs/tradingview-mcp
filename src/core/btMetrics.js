/**
 * Mapping metriche TradingView → payload di finalize Pine Algos, e rilevamento anomalie.
 *
 * NESSUNA conversione di scala sulle percentuali. VERIFICATO DAL VIVO (2026-08-10, Imbalance
 * Strategy su TVC:NDQ 5m): i campi `*Percent` dell'API interna di TradingView sono già ratio
 * 0-1, non percentuali — esattamente la scala che l'API Pine Algos si aspetta.
 *
 *   netProfit 14184.535 su 100.000 di capitale  →  netProfitPercent 0.14184  (= 14,18%)
 *   121 vincenti su 294                          →  percentProfitable 0.41156 (= 41,16%)
 *   drawdown 8065.93                             →  maxStrategyDrawDownPercent 0.0668 (= 6,68%)
 *
 * La prima versione di questo file divideva per 100 dando per scontato che TV restituisse
 * "12.345" per il 12,345%. Risultato: OGNI metrica percentuale finiva sulla piattaforma 100
 * volte più piccola del vero — un drawdown del 6,68% registrato come 0,067%, e obiettivi tipo
 * "DD <= 6%" superati da qualsiasi cosa. I test unitari non l'hanno intercettato perché
 * codificavano la stessa assunzione sbagliata: solo l'esecuzione su dati reali poteva scoprirlo.
 * Se un giorno i numeri sembrassero fuori scala, ricontrolla QUI per primo.
 */

const CORE_KEYS = new Set([
  'net_profit', 'net_profit_percent', 'max_drawdown', 'max_drawdown_percent',
  'profit_factor', 'total_trades', 'percent_profitable', 'sharpe_ratio', 'sortino_ratio',
]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
    // Già ratio 0-1 lato TradingView: passano così come sono (vedi il commento in testa).
    net_profit_pct: num(tv.net_profit_percent) ?? 0,
    max_drawdown: num(tv.max_drawdown) ?? 0,
    max_drawdown_pct: num(tv.max_drawdown_percent) ?? 0,
    win_rate: num(tv.percent_profitable) ?? 0,
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
 * ⚠️ CORREZIONE DEL 2026-08-11 — questa nota diceva il contrario, e il contrario era sbagliato ⚠️
 * La stesura originale ragionava così: «metriche identiche NON sono di per sé un'anomalia — due set
 * di input diversi possono legittimamente produrre lo stesso risultato (es. un filtro che non si
 * attiva mai). Diventa anomalia solo se qualcosa dice che il set non ha avuto effetto». Sembra
 * prudente ed è il buco da cui è passata una sessione intera di dati falsi: con `recalcObserved`
 * a true — il motore ricalcola davvero — e readback corretto, l'identità veniva accettata e
 * finalizzata.
 *
 * Cos'era davvero: il pannello è ASINCRONO rispetto al ricalcolo e mostrava ancora i numeri della
 * run precedente. Sessione 43, misurata: 15 backtest M5 su 19 identici al bit, e lo stesso identico
 * risultato su tutti i 9 M15 **e su uno M5**. Cambiare timeframe non può lasciare i numeri
 * invariati: quei numeri appartenevano a un'altra run.
 *
 * La regola giusta: l'identità è **sempre** sospetta quando è stato chiesto un cambiamento. Chi
 * chiama rilegge il pannello finché la firma cambia (`rileggiFinoACambio`); se dopo i tentativi
 * resta identica passa `staleConfermato` e qui ci si ferma. Un test che produce davvero lo stesso
 * risultato del precedente costa un fermo e una ripartenza; un pannello lento non riletto costa un
 * database di numeri plausibili e falsi.
 *
 * `recalcObserved`: true = si è visto `isLoading()` passare a true (o le metriche cambiare);
 * false = il set non ha smosso il motore; null = segnale non leggibile, e allora NON si accusa
 * un no-op che non si è in grado di vedere.
 */
export function detectAnomaly({
  setResult, results, readbackOk = true, sameAsPrevious = false,
  staleConfermato = false, contestoCambiato = false, recalcObserved = null,
  baselineAssente = false,
} = {}) {
  const missing = setResult?.missing || [];
  if (missing.length) {
    return { kind: 'inputs_not_applied', detail: `id non applicati: ${missing.join(', ')}` };
  }
  if (!results || results.success === false) {
    return { kind: 'runtime_error', detail: results?.error || 'report della strategia non disponibile' };
  }
  // Nessun ricalcolo E metriche invariate: il set è arrivato a TradingView senza cambiare nulla.
  // Fail-closed di proposito — fermarsi per sbaglio costa un riavvio del grind, proseguire per
  // sbaglio scrive nel database un backtest che non corrisponde agli input dichiarati.
  // Il readback si valuta PRIMA del no-op: se i valori riletti non sono quelli richiesti, quella e'
  // la diagnosi primaria e dice cosa fare. Che le metriche siano anche rimaste ferme e' una
  // conseguenza, non un'informazione in piu': etichettarlo `silent_noop` mandava a cercare un
  // problema di ricalcolo quando il problema era che il set non si era applicato.
  if (!readbackOk) {
    return {
      kind: 'readback_mismatch',
      detail: sameAsPrevious
        ? 'i valori riletti non corrispondono a quelli richiesti, e le metriche sono rimaste invariate'
        : 'i valori riletti non corrispondono a quelli richiesti',
    };
  }
  // Valori applicati e confermati, ma il motore non si e' mosso e i numeri sono quelli di prima.
  if (recalcObserved === false && sameAsPrevious) {
    return { kind: 'silent_noop', detail: 'nessun ricalcolo osservato dopo il set e metriche invariate' };
  }
  // PRIMA di `stale_metrics`: due run consecutive a zero trade hanno per forza la stessa firma
  // (sono tutti zeri), e chiamarla "pannello fermo" nasconderebbe il dato vero. E' anche innocuo
  // metterlo prima, perche' `zero_trades` non finalizza nulla: marca la run failed e prosegue.
  if (Math.round(results.metrics?.total_trades ?? 0) === 0) {
    return { kind: 'zero_trades', detail: 'la strategia non ha prodotto alcun trade (verifica badge errore, pannello, leva e size nelle Proprietà)' };
  }
  // Il pannello non ha MAI avuto metriche con cui confrontarsi, nemmeno dopo l'attesa. Tutto il
  // rilevamento dello stale poggia su una domanda sola — «i numeri si sono mossi rispetto a prima?»
  // — e senza un "prima" quella domanda non ha risposta: rispetto al nulla ogni valore sembra nuovo,
  // compreso quello che il pannello mostra della configurazione salvata sul chart.
  // Fail-closed come il resto del file: fermarsi per sbaglio costa un rilancio del grind, accettare
  // per sbaglio scrive un numero falso dentro una conclusione che poi si eredita per catena.
  // Successo davvero: #999 (sessione 63) e #1006 (sessione 64), 553 trade e -14.049,87 identici al
  // centesimo a settimane di distanza, da due configurazioni diverse. Nessuno dei due era storico
  // troncato — erano due letture dello stesso stato di partenza, accettate perche' non c'era niente
  // con cui smentirle.
  if (baselineAssente) {
    return {
      kind: 'baseline_unavailable',
      detail: 'il pannello non aveva metriche al momento della baseline e non ne ha avute nemmeno dopo l\'attesa: senza un termine di confronto questo risultato non e\' verificabile (chart ancora in caricamento? TradingView appena rilanciato?)',
    };
  }
  // Il pannello non si e' mosso nemmeno dopo le riletture. Con un cambio di symbol/timeframe di
  // mezzo non e' nemmeno un dubbio: metriche identiche fra due contesti diversi sono impossibili.
  if (staleConfermato) {
    return {
      kind: 'stale_metrics',
      detail: contestoCambiato
        ? 'metriche identiche alla run precedente DOPO un cambio di symbol/timeframe: impossibile, il pannello sta ancora mostrando i numeri della run prima'
        : 'metriche identiche alla run precedente dopo il cambio di input, invariate anche alle riletture: il pannello non si e\' aggiornato',
    };
  }
  return null;
}
