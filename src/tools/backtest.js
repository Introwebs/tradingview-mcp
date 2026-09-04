import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/backtest.js';
import { resolveConfig, makeApi } from '../core/pinealgos.js';
import { applyBacktest } from '../core/btApply.js';

export function registerBacktestTools(server) {
  server.tool(
    'bt_grind',
    'Esegue le run PENDING di una sessione di backtest Pine Algos senza tornare al modello a ogni passo: applica input_set, attende il ricalcolo, legge le metriche, cattura l\'equity, finalizza. Si ferma da solo su anomalia (0 trade, errore di runtime, input non applicati) e restituisce una tabella compatta. Allega anche il DIGEST della sessione (assi esplorati, known-good per gruppo, mosse): non richiamare l\'endpoint digest dopo un grind, ce l\'hai già nel ritorno.',
    {
      session_id: z.number().int().describe('Id della BacktestSession Pine Algos'),
      entity_id: z.string().optional().describe('entity_id della strategia bersaglio (da chart_get_state). Opzionale se passi strategy_name'),
      // OPZIONALI: sono solo il RIPIEGO per una run che non dichiara un periodo suo. Le run-variante
      // di costo lo portano sempre (copiato dal padre lato server), quindi il runner non li passa —
      // e finche' erano obbligatori il tool rifiutava la chiamata prima ancora di partire (misurato
      // il 2026-09-04 sul #1050: MCP error -32602 in un secondo).
      period_start: z.string().optional().describe('Inizio periodo ISO (YYYY-MM-DD), ripiego quando la run non ne ha uno proprio'),
      period_end: z.string().optional().describe('Fine periodo ISO (YYYY-MM-DD), ripiego quando la run non ne ha una propria'),
      command_id: z.number().int().optional().describe('Id del comando operatore, per postare i progress in console'),
      max_runs: z.number().int().optional().describe('Massimo di run da eseguire in questa chiamata (0 = tutte le pending)'),
      recalc_timeout_ms: z.number().int().optional().describe('Attesa massima del ricalcolo per run (default 45000)'),
      recalc_step_ms: z.number().int().optional().describe('Passo di campionamento di isLoading (default 250; la finestra di ricalcolo misurata dura ~1,1 s)'),
      recalc_start_grace_ms: z.number().int().optional().describe('Quanto attendere che il ricalcolo PARTA prima di dichiarare no-op (default 5000; misurato ~0,6 s)'),
      verbose: z.boolean().optional().describe('Progress passo-passo in console per il debug (default false: si postano solo run conclusa, zero-trade e stop)'),
      maximize_for_screenshot: z.boolean().optional().describe('Massimizza il pannello Strategy Tester per lo scatto dell\'equity e lo rimette com\'era (default true)'),
      run_ids: z.array(z.number().int()).optional().describe('Esegui QUESTE run per id, nell\'ordine dato (varianti di costo: il ?next=1 le filtra apposta). Senza, esegue le pending della sessione come sempre'),
      strategy_name: z.string().optional().describe('Titolo della strategia sul chart, per risolvere entity_id quando non lo hai'),
    },
    async (args) => {
      try {
        const { base, token } = resolveConfig();
        const api = makeApi({ base, token });
        return jsonResult(await core.grindSession(args, { api }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'bt_apply',
    'Replica un backtest Pine Algos sul chart: symbol, timeframe, periodo di test, input di logica e Proprietà, per id esatto, con readback. Ritorna cosa ha applicato, gli input non confermati e il confronto fra le metriche del tester e quelle del backtest. Si ferma con un codice (strategy_not_on_chart, version_mismatch, period_not_applied, stale_metrics…) invece di improvvisare.',
    {
      backtest_id: z.number().int().describe('Id del backtest Pine Algos da replicare'),
      command_id: z.number().int().optional().describe('Id del comando operatore, per i progress in console'),
      recalc_timeout_ms: z.number().int().optional().describe('Attesa massima del ricalcolo (default 45000)'),
    },
    async (args) => {
      try {
        const { base, token } = resolveConfig();
        const api = makeApi({ base, token });
        return jsonResult(await applyBacktest(args, { api }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
