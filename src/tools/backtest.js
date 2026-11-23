import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/backtest.js';
import { resolveConfig, makeApi } from '../core/pinealgos.js';
import { applyBacktest } from '../core/btApply.js';
import { eseguiFase } from '../core/btFase.js';

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
      measure_timing: z.boolean().optional().describe('Restituisce la scomposizione del tempo di ogni run (timing). Default false: il ritorno resta quello di sempre'),
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

  server.tool(
    'bt_phase',
    'Esegue tutte le prove di una FASE di una campagna Pine Algos in una chiamata: applica mercato, timeframe, periodo e input, misura, e manda le righe alla piattaforma. Non salva backtest, non fa screenshot. Rifiuta le prove che toccano il periodo riservato o che sforano le prove rimaste prima di eseguirne una. Ritorna la tabella calcolata dalla piattaforma, mai le righe. Se torna remaining_in_phase > 0 o pending_file, richiamalo con phase_id.',
    {
      campaign_id: z.number().int().describe('Id della campagna Pine Algos'),
      phase_id: z.number().int().optional().describe('Id della fase da riprendere; senza, si apre una fase nuova (servono type e trials)'),
      type: z.enum(['base', 'entry', 'filter', 'management', 'risk', 'hold']).optional().describe('Tipo della fase nuova'),
      symbol: z.string().optional().describe('Mercato della fase'),
      trials: z.array(z.object({
        key: z.string().max(64).optional().describe('Chiave della prova'),
        label: z.string().max(120).optional().describe('Etichetta leggibile della prova'),
        period_start: z.string().optional().describe('Inizio periodo ISO (YYYY-MM-DD)'),
        period_end: z.string().optional().describe('Fine periodo ISO (YYYY-MM-DD)'),
        inputs: z.array(z.object({
          name: z.string().describe("Nome dell'input"),
          position: z.number().int().optional().describe("Posizione dell'input quando il nome si ripete"),
          value: z.union([z.string(), z.number(), z.boolean()]).describe('Valore da applicare (la stringa vuota e un valore valido)'),
        })).max(10).optional().describe('Input da impostare per la prova'),
      })).max(60).optional().describe('Prove della fase nuova'),
      entity_id: z.string().optional().describe('entity_id della strategia bersaglio. Opzionale se passi strategy_name'),
      strategy_name: z.string().optional().describe('Titolo della strategia sul chart, per risolvere entity_id'),
      command_id: z.number().int().optional().describe('Id del comando operatore, per i progress in console'),
      max_trials_per_call: z.number().int().optional().describe('Massimo di prove per chiamata'),
      time_budget_ms: z.number().int().optional().describe('Tempo massimo della chiamata in millisecondi'),
      recalc_timeout_ms: z.number().int().optional().describe('Attesa massima del ricalcolo per prova'),
    },
    async (args) => {
      try {
        if (!args.phase_id && !(args.type && args.trials)) {
          return jsonResult({ success: false, error: 'Servono phase_id (per riprendere una fase) oppure type e trials (per aprirne una nuova)' }, true);
        }
        const { base, token } = resolveConfig();
        const api = makeApi({ base, token });
        return jsonResult(await eseguiFase(args, { api }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
