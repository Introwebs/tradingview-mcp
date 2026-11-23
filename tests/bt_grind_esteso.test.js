/**
 * Il grind contro un tester in modalita' ESTESO che si comporta come quello vero (vedi
 * helpers/testerFinto.js): le richieste impiegano secondi, il banner sparisce al click e non compare
 * mentre una richiesta e' in volo. Sono i test che la sessione 36 (2026-11-23) avrebbe fatto fallire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grindSession } from '../src/core/backtest.js';
import { creaTesterFinto } from './helpers/testerFinto.js';

const P1 = { from: '2022-12-08', to: '2023-12-08' };
const P4 = { from: '2020-01-01', to: '2023-12-08' };
const BASE = { in_0: 2, in_40: 10000 };

function depsEsteso({ runs, tv }) {
  const queue = [...runs];
  const finalized = [];
  const failed = [];
  const reclaimed = [];
  const progress = [];
  const deps = {
    api: {
      nextRun: async () => queue.shift() ?? null,
      markRunning: async () => ({}),
      markFailed: async (id, motivo) => { failed.push({ id, motivo }); return {}; },
      reclaimRun: async (id, motivo) => { reclaimed.push({ id, motivo }); return {}; },
      listRuns: async () => [],
      stageEquity: async () => ({}),
      finalize: async (runId, payload) => { finalized.push({ runId, payload }); return { data: { id: runId * 10 } }; },
      progress: async (_c, msg) => { progress.push(String(msg)); return null; },
      sessionDigest: async (id) => ({ data: { session: { id }, compact: true, groups: [], moves: { total: 0, omitted: 0, items: [] } } }),
    },
    setInputs: async ({ inputs }) => { tv.setInputs(inputs); return { updated_inputs: inputs, missing: [] }; },
    readInputValues: async () => ({ ...tv.stato.inputs }),
    readInputsInfo: async () => ([
      { id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Ingressi' },
      { id: 'in_9', name: 'Mostra linee', type: 'bool', group: 'Grafica' },
      { id: 'in_40', name: 'Initial Capital', type: 'float', group: null },
    ]),
    readPanelMetrics: async () => ({ success: true, source: 'panel', metrics: tv.metricheMostrate() }),
    readReportFor: async () => ({ success: true, metrics: tv.metricheMostrate() }),
    readStrategyLoading: async () => tv.strategiaInCaricamento(),
    readStudyStatus: async () => ({ ok: true, type: 0, error: null }),
    readPeriodReport: async () => ({ found: false, error: 'stub' }),
    ensureTesterPanel: async () => ({ ok: true, altezza: 400 }),
    ensureVisibleFor: async () => ({ found: true, wasHidden: false, visible: true }),
    setStrategyVisibility: async () => true,
    getChartState: async () => ({ symbol: 'TVC:DJI', resolution: tv.stato.timeframe }),
    setSymbol: async () => ({ success: true }),
    setTimeframe: async ({ timeframe }) => { tv.setTimeframe(timeframe); return { success: true }; },
    readTestPeriod: async () => ({ label: `${tv.stato.periodo.from} — ${tv.stato.periodo.to}`, ...tv.stato.periodo }),
    setCustomPeriod: async (from, to) => { tv.setPeriodo({ from, to }); return { applied: true, label: `${from} — ${to}`, from, to }; },
    captureScreenshot: async () => ({ file_path: '/tmp/shot.png' }),
    setPanelMaximized: async (m) => ({ ok: true, prima: m ? 'normal' : 'maximized' }),
    // Le due attese di PRIMA, fedeli alla logica vera di btPanel.js: guardano solo il banner.
    aggiornaReportSeObsoleto: async () => tv.cliccaAggiorna(),
    attendiReportAggiornato: async () => {
      let click = 0;
      await tv.sleep(500);
      for (;;) {
        const e = tv.cliccaAggiorna();
        if (e.cliccato) click += 1;
        else if (!tv.reportObsoleto()) return { aggiornato: true, click };
        await tv.sleep(1000);
      }
    },
    // Il segnale vero.
    readDeepState: async () => tv.readDeepState(),
    reportObsoleto: async () => tv.reportObsoleto(),
    sleep: tv.sleep,
    now: tv.now,
  };
  return { deps, finalized, failed, reclaimed, progress };
}

const run = (id, rr, periodo = P4, extra = {}) => ({
  id, symbol: 'TVC:DJI', timeframe: '5', period_start: periodo.from, period_end: periodo.to,
  input_set: { in_0: rr }, label: `RR ${rr}`, attempts: 0, ...extra,
});

/** Ogni backtest registrato deve portare i numeri della SUA configurazione, non di quella prima. */
function assertNumeriGiusti(tv, finalized, attesi) {
  assert.equal(finalized.length, attesi.length, `finalizzati ${finalized.length} su ${attesi.length}`);
  attesi.forEach(({ rr, periodo, tf = '5' }, i) => {
    const vero = tv.metricheDi(periodo, { ...BASE, in_0: rr }, tf);
    const p = finalized[i].payload;
    assert.equal(p.inputs['Risk/Reward'], rr, `run ${i + 1}: input registrato`);
    assert.equal(p.total_trades, vero.total_trades, `run ${i + 1} (RR ${rr}, TF ${tf}): trade registrati ${p.total_trades}, veri ${vero.total_trades}`);
    assert.equal(p.net_profit, vero.net_profit, `run ${i + 1} (RR ${rr}, TF ${tf}): P&L registrato ${p.net_profit}, vero ${vero.net_profit}`);
  });
}

test('dopo un cambio di periodo ogni run registra i numeri dei PROPRI input (sessione 36, A-1 e A-2)', async () => {
  const tv = creaTesterFinto({ periodo: P1, inputs: BASE, durataMs: 6500 });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 1), run(2, 1.5), run(3, 2.5)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [{ rr: 1, periodo: P4 }, { rr: 1.5, periodo: P4 }, { rr: 2.5, periodo: P4 }]);
});

test('stessa sequenza con tempi ostili: richiesta che parte tardi, banner in ritardo, click lento', async () => {
  // I ritardi mai misurati sotto i 200 ms: il grind non deve appoggiarsi a nessuno di loro.
  const tv = creaTesterFinto({
    periodo: P1, inputs: BASE, durataMs: 6500,
    partenzaPeriodoMs: 700, ritardoBannerMs: 2500, partenzaMs: 900, ritardoIdMs: 400,
  });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 1), run(2, 1.5), run(3, 2, P1), run(4, 3, P4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [
    { rr: 1, periodo: P4 }, { rr: 1.5, periodo: P4 }, { rr: 2, periodo: P1 }, { rr: 3, periodo: P4 },
  ]);
});

test('una run che cambia solo il periodo aspetta la richiesta automatica prima di registrare', async () => {
  const tv = creaTesterFinto({ periodo: P1, inputs: BASE, durataMs: 6500, partenzaPeriodoMs: 1000 });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 2, P4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [{ rr: 2, periodo: P4 }]);
});

test('cambio di timeframe in esteso: la richiesta parte da sola e ogni run ha i numeri del SUO timeframe', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: BASE, durataMs: 5000, requestIdIniziale: 17 });
  const runs = [run(1, 2, P4, { timeframe: '15' }), run(2, 2, P4, { timeframe: '5' }), run(3, 3, P4, { timeframe: '15' })];
  const { deps, finalized } = depsEsteso({ tv, runs });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [
    { rr: 2, periodo: P4, tf: '15' }, { rr: 2, periodo: P4, tf: '5' }, { rr: 3, periodo: P4, tf: '15' },
  ]);
});

test('il tester entra in esteso dentro la run (prima non lo era): la prima run e\' gia\' sincronizzata', async () => {
  const tv = creaTesterFinto({ periodo: P1, inputs: BASE, durataMs: 4000, deep: false, statoIniziale: null });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 1, P4), run(2, 3, P4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [{ rr: 1, periodo: P4 }, { rr: 3, periodo: P4 }]);
});

test('input diversi a contesto fermo: nessuna run prende i numeri della precedente', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: BASE, durataMs: 5000 });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 1), run(2, 3), run(3, 3.5), run(4, 4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [1, 3, 3.5, 4].map((rr) => ({ rr, periodo: P4 })));
});

test('due input_set che danno lo stesso identico report: identita\' legittima, registrata senza fermarsi', async () => {
  // Regola C4: un input che non muove i numeri non e' un guasto. Con la richiesta vista partire e
  // atterrare l'identita' e' provata, e non si perde tempo a rileggere.
  const piatta = (p) => ({ net_profit: 500, net_profit_percent: 0.05, max_drawdown: 10, max_drawdown_percent: 0.005, profit_factor: 1.2, total_trades: 77 + Number(p.from.slice(2, 4)), percent_profitable: 0.5 });
  const tv = creaTesterFinto({ periodo: P4, inputs: BASE, durataMs: 5000, metriche: piatta });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 3), run(2, 4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 2);
  assert.equal(tv.stato.requestId, 2, 'una richiesta per run: i due report sono stati calcolati davvero');
});

test('input che TradingView non considera (nessun banner): la run si chiude lo stesso, per le vie di prima', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: { ...BASE, in_9: true }, durataMs: 5000, bannerMaiPerInput: ['in_9'] });
  const runs = [{ ...run(1, 2), input_set: { in_9: false }, label: 'linee spente' }];
  const { deps, finalized } = depsEsteso({ tv, runs });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1', recalc_start_grace_ms: 20 }, deps);

  assert.equal(out.stopped_reason, null, JSON.stringify(out.stopped_reason));
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].payload.total_trades, tv.metricheDi(P4, BASE).total_trades);
});

test('TradingView rifiuta il backtest esteso: stop col motivo vero, la run torna in coda col motivo scritto', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: BASE, durataMs: 3000 });
  const { deps, finalized, failed, reclaimed, progress } = depsEsteso({ tv, runs: [run(1, 1), run(2, 3)] });
  tv.rifiuta('not_allowed');

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(finalized.length, 0);
  assert.equal(out.stopped_reason?.kind, 'deep_backtest_error');
  assert.match(out.stopped_reason.detail, /not_allowed/);
  assert.equal(reclaimed.length, 1, 'solo la run in corso; la seconda non e\' stata toccata');
  assert.equal(reclaimed[0].id, 1);
  assert.match(reclaimed[0].motivo, /deep_backtest_error: not_allowed/);
  assert.equal(failed.length, 0);
  assert.ok(progress.some((m) => /not_allowed/.test(m)), 'il motivo arriva in console');
});

test('stesso rifiuto al secondo tentativo della run: resta failed, non blocca la coda per sempre', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: BASE, durataMs: 3000 });
  const { deps, failed, reclaimed } = depsEsteso({ tv, runs: [run(1, 1, P4, { attempts: 1 })] });
  tv.rifiuta('not_allowed');

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason?.kind, 'deep_backtest_error');
  assert.equal(reclaimed.length, 0);
  assert.deepEqual(failed, [{ id: 1, motivo: 'deep_backtest_error: not_allowed' }]);
});

test('rifiuto gia\' sul cambio di periodo: si ferma prima di toccare gli input', async () => {
  const tv = creaTesterFinto({ periodo: P1, inputs: BASE, durataMs: 3000 });
  const { deps, finalized, reclaimed } = depsEsteso({ tv, runs: [run(1, 1, P4)] });
  tv.rifiuta('not_allowed');

  const out = await grindSession({ session_id: 36, entity_id: 'ent1', measure_timing: true }, deps);

  assert.equal(finalized.length, 0);
  assert.equal(out.stopped_reason?.kind, 'deep_backtest_error');
  assert.equal(reclaimed.length, 1);
  assert.equal(tv.stato.inputs.in_0, 2, 'gli input non sono stati toccati');
  assert.equal(out.timing.run.length, 1, 'il record dei tempi si chiude lo stesso');
});

test('richiesta che non atterra in tempo: report_not_synced, niente numeri registrati', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: BASE, durataMs: 10 * 60 * 1000 });
  const { deps, finalized, reclaimed } = depsEsteso({ tv, runs: [run(1, 1)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(finalized.length, 0);
  assert.equal(out.stopped_reason?.kind, 'report_not_synced');
  assert.match(out.stopped_reason.detail, /timeout/);
  assert.match(reclaimed[0].motivo, /report_not_synced: timeout/);
});
