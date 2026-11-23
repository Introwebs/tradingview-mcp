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
      reclaimRun: async (id) => { reclaimed.push(id); return {}; },
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
    getChartState: async () => ({ symbol: 'TVC:DJI', resolution: '5' }),
    setSymbol: async () => ({ success: true }),
    setTimeframe: async () => ({ success: true }),
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

const run = (id, rr, periodo = P4) => ({
  id, symbol: 'TVC:DJI', timeframe: '5', period_start: periodo.from, period_end: periodo.to,
  input_set: { in_0: rr }, label: `RR ${rr}`,
});

/** Ogni backtest registrato deve portare i numeri della SUA configurazione, non di quella prima. */
function assertNumeriGiusti(tv, finalized, attesi) {
  assert.equal(finalized.length, attesi.length, `finalizzati ${finalized.length} su ${attesi.length}`);
  attesi.forEach(({ rr, periodo }, i) => {
    const vero = tv.metricheDi(periodo, { in_0: rr, in_40: 10000 });
    const p = finalized[i].payload;
    assert.equal(p.inputs['Risk/Reward'], rr, `run ${i + 1}: input registrato`);
    assert.equal(p.total_trades, vero.total_trades, `run ${i + 1} (RR ${rr}): trade registrati ${p.total_trades}, veri ${vero.total_trades}`);
    assert.equal(p.net_profit, vero.net_profit, `run ${i + 1} (RR ${rr}): P&L registrato ${p.net_profit}, vero ${vero.net_profit}`);
  });
}

test('dopo un cambio di periodo ogni run registra i numeri dei PROPRI input (sessione 36, A-1 e A-2)', async () => {
  const tv = creaTesterFinto({ periodo: P1, inputs: { in_0: 2, in_40: 10000 }, durataMs: 6500 });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 1), run(2, 1.5), run(3, 2.5)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [{ rr: 1, periodo: P4 }, { rr: 1.5, periodo: P4 }, { rr: 2.5, periodo: P4 }]);
});

test('una run che cambia solo il periodo aspetta la richiesta automatica prima di registrare', async () => {
  const tv = creaTesterFinto({ periodo: P1, inputs: { in_0: 2, in_40: 10000 }, durataMs: 6500 });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 2, P4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [{ rr: 2, periodo: P4 }]);
});

test('input diversi a contesto fermo: nessuna run prende i numeri della precedente', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: { in_0: 2, in_40: 10000 }, durataMs: 5000 });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 1), run(2, 3), run(3, 3.5), run(4, 4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assertNumeriGiusti(tv, finalized, [1, 3, 3.5, 4].map((rr) => ({ rr, periodo: P4 })));
});

test('due input_set che danno lo stesso identico report: identita\' legittima, registrata senza fermarsi', async () => {
  // Regola C4: un input che non muove i numeri non e' un guasto. Con la richiesta vista partire e
  // atterrare l'identita' e' provata, e non si perde tempo a rileggere.
  const piatta = (p) => ({ net_profit: 500, net_profit_percent: 0.05, max_drawdown: 10, max_drawdown_percent: 0.005, profit_factor: 1.2, total_trades: 77 + Number(p.from.slice(2, 4)), percent_profitable: 0.5 });
  const tv = creaTesterFinto({ periodo: P4, inputs: { in_0: 2, in_40: 10000 }, durataMs: 5000, metriche: piatta });
  const { deps, finalized } = depsEsteso({ tv, runs: [run(1, 3), run(2, 4)] });

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(out.stopped_reason, null);
  assert.equal(finalized.length, 2);
  assert.equal(tv.stato.requestId, 2, 'una richiesta per run: i due report sono stati calcolati davvero');
});

test('TradingView rifiuta il backtest esteso: il grind si ferma col motivo vero e la run torna in coda', async () => {
  const tv = creaTesterFinto({ periodo: P4, inputs: { in_0: 2, in_40: 10000 }, durataMs: 3000 });
  const { deps, finalized, failed, reclaimed, progress } = depsEsteso({ tv, runs: [run(1, 1), run(2, 3)] });
  tv.rifiutaLaProssima('not_allowed');

  const out = await grindSession({ session_id: 36, entity_id: 'ent1' }, deps);

  assert.equal(finalized.length, 0);
  assert.equal(out.stopped_reason?.kind, 'deep_backtest_error');
  assert.match(out.stopped_reason.detail, /not_allowed/);
  assert.deepEqual(reclaimed, [1], 'la run non ha colpa: resta da eseguire');
  assert.equal(failed.length, 0);
  assert.ok(progress.some((m) => /not_allowed/.test(m)), 'il motivo arriva in console');
});
