import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/backtest.js';
import { resolveConfig, makeApi } from '../core/pinealgos.js';

export function registerBacktestTools(server) {
  server.tool(
    'bt_grind',
    'Esegue le run PENDING di una sessione di backtest Pine Algos senza tornare al modello a ogni passo: applica input_set, attende il ricalcolo, legge le metriche, cattura l\'equity, finalizza. Si ferma da solo su anomalia (0 trade, errore di runtime, input non applicati) e restituisce una tabella compatta.',
    {
      session_id: z.number().int().describe('Id della BacktestSession Pine Algos'),
      entity_id: z.string().describe('entity_id della strategia bersaglio sul chart (da chart_get_state)'),
      period_start: z.string().describe('Inizio periodo ISO (YYYY-MM-DD) usato quando la run non ne ha uno proprio'),
      period_end: z.string().describe('Fine periodo ISO (YYYY-MM-DD) usata quando la run non ne ha una propria'),
      command_id: z.number().int().optional().describe('Id del comando operatore, per postare i progress in console'),
      max_runs: z.number().int().optional().describe('Massimo di run da eseguire in questa chiamata (0 = tutte le pending)'),
      recalc_timeout_ms: z.number().int().optional().describe('Attesa massima del ricalcolo per run (default 20000)'),
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
}
