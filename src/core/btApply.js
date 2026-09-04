/**
 * Replica un backtest della piattaforma sul chart TradingView: symbol, timeframe, periodo di
 * test, input di logica e Proprieta'. Ogni passo si rilegge; nessuna decisione dentro.
 *
 * E' il motore del comando «Imposta input su TV». Fino al 2026-09-03 era un handler manuale
 * eseguito dal modello turno per turno; qui e' codice, e quando qualcosa non torna si ferma con
 * un codice d'errore invece di provare altro.
 *
 * La difesa dal pannello in ritardo e' la stessa del grind (backtest.js, `corsaColRidisegno`):
 * si fotografa una baseline DOPO il contesto e PRIMA del set, si attende il ricalcolo contro
 * quella firma, e se i numeri sono identici pur avendo chiesto un cambiamento si rilegge invece
 * di fidarsi. Identita' con banner sparito anche dopo le riletture = legittima (C4); identita'
 * con banner ancora su = report mai ricalcolato, `stale_metrics`.
 */
import { setInputs as realSetInputs } from './indicators.js';
import { setSymbol as realSetSymbol, setTimeframe as realSetTimeframe, getState as realGetState } from './chart.js';
import { setCustomPeriod as realSetCustomPeriod, readTestPeriod as realReadTestPeriod } from './btPeriod.js';
import {
  readPanelMetrics as realReadPanelMetrics, ensureTesterPanel as realEnsureTesterPanel,
  attendiReportAggiornato as realAttendiReport, aggiornaReportSeObsoleto as realAggiornaReportSeObsoleto,
} from './btPanel.js';
import {
  readInputsInfo as realReadInputsInfo, readInputValues as realReadInputValues,
  readReportFor as realReadReportFor, readStrategyLoading as realReadStrategyLoading,
  readbackMatches,
} from './btChart.js';
import {
  waitForRecalc, applicaContestoRun, leggiMetricheEffettive, giornoISO, rileggiFinoACambio, fpNotoO,
} from './backtest.js';
import { resolveStrategyEntity, resolveInputKeys } from './btCost.js';
import { fingerprint } from './btMetrics.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = (kind, detail, extra = {}) => ({ ok: false, error: { kind, detail }, ...extra });

/**
 * Cosa scrivere sulla strategia viva. Preferisce l'archivio per id (`applied_inputs`, dal
 * 2026-08-24), altrimenti il dizionario per nome + le Proprieta' da `extra_metrics.properties`.
 * Un input di logica irrisolto = versione diversa (si ferma). Una Proprieta' irrisolta si salta
 * con avviso: dipende dalla versione di TradingView, non della strategia.
 */
function inputsDaReplicare(bt, info) {
  const archivio = bt.applied_inputs && typeof bt.applied_inputs === 'object' && Object.keys(bt.applied_inputs).length ? bt.applied_inputs : null;
  if (archivio) {
    const logica = {};
    const proprieta = {};
    for (const [id, e] of Object.entries(archivio)) {
      if (e && e.block === 'property') proprieta[id] = e; else logica[id] = e;
    }
    const rl = resolveInputKeys(info, logica);
    const rp = resolveInputKeys(info, proprieta);
    return {
      resolved: { ...rl.resolved, ...rp.resolved },
      unresolved: rl.unresolved,
      // Per nome, come nel ramo per nome: un id `in_K` orfano non dice niente a chi legge.
      properties_skipped: rp.unresolved.map((id) => archivio[id]?.name || id),
      inputs: Object.keys(rl.resolved).length,
      properties: Object.keys(rp.resolved).length,
    };
  }
  const logica = resolveInputKeys(info, bt.inputs || {});
  const props = resolveInputKeys(info, bt.extra_metrics?.properties || {});
  return {
    resolved: { ...logica.resolved, ...props.resolved },
    unresolved: logica.unresolved,
    properties_skipped: props.unresolved,
    inputs: Object.keys(logica.resolved).length,
    properties: Object.keys(props.resolved).length,
  };
}

/**
 * Confronto tollerante fra richiesto e riletto: `"60"` e `60` sono lo stesso valore (TV rilegge
 * le resolution come stringa), ma `""` NON e' `0` e `true` NON e' `1` — `Number('')` e
 * `Number(true)` mentirebbero, e un input vuoto passerebbe per applicato.
 */
function stessoValore(expected, got) {
  if (expected == null || got == null) return expected == got;
  if (got === expected) return true;
  if (typeof expected === 'boolean' || typeof got === 'boolean') return false;
  const vuota = (v) => typeof v === 'string' && v.trim() === '';
  if (vuota(expected) || vuota(got)) return false;
  const a = Number(expected);
  const b = Number(got);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

export async function applyBacktest(opts, deps = {}) {
  const { backtest_id, command_id = null, recalc_timeout_ms = 45000 } = opts;
  const {
    api,
    getChartState = realGetState, readInputsInfo = realReadInputsInfo, readInputValues = realReadInputValues,
    setInputs = realSetInputs, setSymbol = realSetSymbol, setTimeframe = realSetTimeframe,
    setCustomPeriod = realSetCustomPeriod, readTestPeriod = realReadTestPeriod, ensureTesterPanel = realEnsureTesterPanel,
    attendiReportAggiornato = realAttendiReport, aggiornaReportSeObsoleto = realAggiornaReportSeObsoleto,
    readStrategyLoading = realReadStrategyLoading,
    readReportFor = realReadReportFor, readPanelMetrics = realReadPanelMetrics, sleep = realSleep,
  } = deps;
  if (!backtest_id) throw new Error('backtest_id è obbligatorio');
  if (!api || typeof api.getBacktest !== 'function') throw new Error('deps.api.getBacktest è obbligatorio');
  const nota = async (m) => { if (typeof api.progress === 'function') await api.progress(command_id, m); };

  const bt = await api.getBacktest(backtest_id);
  if (!bt) return fail('backtest_not_found', `backtest #${backtest_id} non trovato`);

  const ris = resolveStrategyEntity(await getChartState(), bt.strategy_name);
  if (ris.error) return fail(ris.error.kind, ris.error.detail);
  const entity_id = ris.entity_id;

  const info = await readInputsInfo(entity_id);
  if (!Array.isArray(info) || !info.length) return fail('strategy_not_on_chart', `nessun input leggibile per ${entity_id}`);

  const piano = inputsDaReplicare(bt, info);
  if (piano.unresolved.length) {
    return fail('version_mismatch', `input del backtest assenti sulla strategia viva: ${piano.unresolved.join(', ')} — versione diversa?`);
  }

  // Da qui in poi il chart viene toccato: ogni fallimento riporta cosa e' gia' stato applicato.
  let periodo = null;
  let inputsSet = false;
  const appliedSoFar = () => ({
    applied_so_far: { symbol: bt.symbol, timeframe: String(bt.timeframe), period: periodo?.label ?? null, inputs_set: inputsSet },
  });

  await nota(`Imposto sul chart il backtest #${bt.id}: ${bt.symbol} ${bt.timeframe}, ${piano.inputs} input + ${piano.properties} Proprietà`);
  const contesto = await applicaContestoRun(
    { symbol: bt.symbol, timeframe: bt.timeframe, period_start: bt.period_start, period_end: bt.period_end },
    { getChartState, setSymbol, setTimeframe, setCustomPeriod, readTestPeriod, ensureTesterPanel, sleep },
  );
  periodo = contesto.periodo;
  if (contesto.problemi.length) return fail(contesto.problemi[0].kind, contesto.problemi[0].detail, appliedSoFar());

  // Baseline DOPO il contesto e PRIMA del set: e' la firma contro cui si giudica se il pannello
  // si e' mosso. Un cambio di symbol/timeframe/periodo lascia il report obsoleto: si rinfresca
  // prima, altrimenti la baseline sarebbe quella del contesto precedente.
  const periodoRistretto = !!(giornoISO(bt.period_start) && giornoISO(bt.period_end));
  const leggi = (id) => leggiMetricheEffettive(id, { readReportFor, readPanelMetrics, periodoRistretto });
  if (contesto.contestoCambiato) await aggiornaReportSeObsoleto();
  const prima = await leggi(entity_id);
  const baselineFp = fpNotoO(null, prima?.success !== false ? prima?.metrics : null);
  // Se il chart e' GIA' sui valori richiesti, non ricalcolare e' corretto e l'identita' con la
  // baseline non e' un sintomo.
  const valoriPrima = await readInputValues(entity_id);
  const deltaReale = !readbackMatches(piano.resolved, valoriPrima);

  const setResult = await setInputs({ entity_id, inputs: piano.resolved });
  inputsSet = true;
  if (setResult.missing?.length) {
    return fail('inputs_not_applied', `id non accettati dalla strategia: ${setResult.missing.join(', ')}`, appliedSoFar());
  }

  // Si aspetta che TradingView dichiari il report ATTUALE (banner sparito), poi la fine del
  // ricalcolo. Vedi backtest.js per le misure dal vivo.
  const report = await attendiReportAggiornato({ timeoutMs: Math.max(recalc_timeout_ms, 30000) });
  if (report.click > 0) await nota('report obsoleto → premuto "Aggiorna report"');
  const { results: results0 } = await waitForRecalc(entity_id, baselineFp, {
    readReport: leggi, readLoading: readStrategyLoading, sleep, timeoutMs: recalc_timeout_ms,
  });
  let results = results0;
  let avviso = null;

  // Metriche identiche alla baseline DOPO aver chiesto un cambiamento: quasi sempre e' il
  // pannello che non si e' ancora ridisegnato (il banner sparisce a calcolo finito, il DOM si
  // ridipinge dopo). Si rilegge invece di scrivere: se i numeri si muovono era stale; se non si
  // muovono nemmeno insistendo e il banner e' sparito, l'identita' e' vera (C4). Banner ancora su
  // = ricalcolo mai partito, si insiste di piu' e, se non basta, e' `stale_metrics`.
  if (deltaReale && results?.metrics && fingerprint(results.metrics) === baselineFp) {
    const corsaColRidisegno = report.aggiornato;
    const ri = await rileggiFinoACambio(entity_id, baselineFp, {
      leggiMetriche: leggi, periodoRistretto, sleep, aggiornaReport: aggiornaReportSeObsoleto,
      ...(corsaColRidisegno ? { tentativi: 4, attesaMs: 1000 } : {}),
    });
    if (ri.cambiato) {
      results = ri.results;
      avviso = `pannello in ritardo, metriche rilette al tentativo ${ri.tentativi}`;
    } else if (!report.aggiornato) {
      return fail('stale_metrics', 'TradingView dichiara ancora il report obsoleto e le metriche sono quelle della configurazione precedente', appliedSoFar());
    }
  }
  if (!results || results.success === false) {
    return fail('metrics_unreadable', results?.error || 'metriche non leggibili', appliedSoFar());
  }

  const actual = await readInputValues(entity_id);
  const byId = new Map(info.map((i) => [i.id, i]));
  const mismatches = [];
  for (const [id, expected] of Object.entries(piano.resolved)) {
    const got = actual[id];
    if (!stessoValore(expected, got)) mismatches.push({ id, key: byId.get(id)?.name ?? id, expected, actual: got ?? null });
  }

  const periodoFinale = await readTestPeriod();
  const metrics = results.metrics || {};
  const tt = Number(metrics.total_trades);
  const np = Number(metrics.net_profit);
  const btNet = Number(bt.net_profit);
  const vs_backtest = {
    total_trades_delta: Number.isFinite(tt) ? tt - Math.round(Number(bt.total_trades) || 0) : null,
    net_profit_delta_pct: Number.isFinite(np) && Number.isFinite(btNet)
      ? (btNet === 0 ? np : (np - btNet) / Math.abs(btNet)) : null,
  };
  const code = [
    mismatches.length ? `${mismatches.length} input non confermati` : null,
    piano.properties_skipped.length ? `Proprietà saltate: ${piano.properties_skipped.join(', ')}` : null,
    avviso,
  ].filter(Boolean);
  await nota(`Tester: ${Number.isFinite(tt) ? tt : '?'} trade (backtest: ${bt.total_trades})${code.length ? ` — ${code.join('; ')}` : ''}`);

  return {
    ok: true, entity_id,
    applied: {
      symbol: bt.symbol, timeframe: String(bt.timeframe),
      period_applied: periodoFinale?.label || periodo?.label || null,
      inputs: piano.inputs, properties: piano.properties,
    },
    ...(piano.properties_skipped.length && { properties_skipped: piano.properties_skipped }),
    ...(avviso && { warning: avviso }),
    mismatches, metrics, vs_backtest,
    metrics_source: results.source || null,
  };
}
