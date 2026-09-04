/**
 * Replica un backtest della piattaforma sul chart TradingView: symbol, timeframe, periodo di
 * test, input di logica e Proprieta'. Ogni passo si rilegge; nessuna decisione dentro.
 *
 * E' il motore del comando «Imposta input su TV». Fino al 2026-09-03 era un handler manuale
 * eseguito dal modello turno per turno; qui e' codice, e quando qualcosa non torna si ferma con
 * un codice d'errore invece di provare altro.
 */
import { setInputs as realSetInputs } from './indicators.js';
import { setSymbol as realSetSymbol, setTimeframe as realSetTimeframe, getState as realGetState } from './chart.js';
import { setCustomPeriod as realSetCustomPeriod, readTestPeriod as realReadTestPeriod } from './btPeriod.js';
import {
  readPanelMetrics as realReadPanelMetrics, ensureTesterPanel as realEnsureTesterPanel,
  attendiReportAggiornato as realAttendiReport,
} from './btPanel.js';
import {
  readInputsInfo as realReadInputsInfo, readInputValues as realReadInputValues,
  readReportFor as realReadReportFor, readStrategyLoading as realReadStrategyLoading,
} from './btChart.js';
import { waitForRecalc, applicaContestoRun, leggiMetricheEffettive, giornoISO } from './backtest.js';
import { resolveStrategyEntity, resolveInputKeys } from './btCost.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fail = (kind, detail) => ({ ok: false, error: { kind, detail } });

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
      properties_skipped: rp.unresolved,
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
    attendiReportAggiornato = realAttendiReport, readStrategyLoading = realReadStrategyLoading,
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

  await nota(`Imposto sul chart il backtest #${bt.id}: ${bt.symbol} ${bt.timeframe}, ${piano.inputs} input + ${piano.properties} Proprietà`);
  const { problemi, periodo } = await applicaContestoRun(
    { symbol: bt.symbol, timeframe: bt.timeframe, period_start: bt.period_start, period_end: bt.period_end },
    { getChartState, setSymbol, setTimeframe, setCustomPeriod, readTestPeriod, ensureTesterPanel, sleep },
  );
  if (problemi.length) return fail(problemi[0].kind, problemi[0].detail);

  const setResult = await setInputs({ entity_id, inputs: piano.resolved });
  if (setResult.missing?.length) return fail('inputs_not_applied', `id non accettati dalla strategia: ${setResult.missing.join(', ')}`);

  const periodoRistretto = !!(giornoISO(bt.period_start) && giornoISO(bt.period_end));
  const report = await attendiReportAggiornato({ timeoutMs: Math.max(recalc_timeout_ms, 30000) });
  if (report.click > 0) await nota('report obsoleto → premuto "Aggiorna report"');
  const { results } = await waitForRecalc(entity_id, null, {
    readReport: (id) => leggiMetricheEffettive(id, { readReportFor, readPanelMetrics, periodoRistretto }),
    readLoading: readStrategyLoading, sleep, timeoutMs: recalc_timeout_ms,
  });

  const actual = await readInputValues(entity_id);
  const byId = new Map(info.map((i) => [i.id, i]));
  const mismatches = [];
  for (const [id, expected] of Object.entries(piano.resolved)) {
    const got = actual[id];
    if (!stessoValore(expected, got)) mismatches.push({ id, key: byId.get(id)?.name ?? id, expected, actual: got ?? null });
  }

  const periodoFinale = await readTestPeriod();
  const metrics = results?.metrics || {};
  const tt = Number(metrics.total_trades);
  const np = Number(metrics.net_profit);
  const btNet = Number(bt.net_profit);
  const vs_backtest = {
    total_trades_delta: Number.isFinite(tt) ? tt - Math.round(Number(bt.total_trades) || 0) : null,
    net_profit_delta_pct: Number.isFinite(np) && Number.isFinite(btNet)
      ? (btNet === 0 ? np : (np - btNet) / Math.abs(btNet)) : null,
  };
  await nota(`Tester: ${Number.isFinite(tt) ? tt : '?'} trade (backtest: ${bt.total_trades})${mismatches.length ? ` — ${mismatches.length} input non confermati` : ''}`);

  return {
    ok: true, entity_id,
    applied: {
      symbol: bt.symbol, timeframe: String(bt.timeframe),
      period_applied: periodoFinale?.label || periodo?.label || null,
      inputs: piano.inputs, properties: piano.properties,
    },
    ...(piano.properties_skipped.length && { properties_skipped: piano.properties_skipped }),
    mismatches, metrics, vs_backtest,
    metrics_source: results?.source || null,
  };
}
