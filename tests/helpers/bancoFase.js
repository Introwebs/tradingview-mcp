/**
 * Il banco dello strumento di fase: le dipendenze TradingView finte del nucleo per-prova
 * (tradingviewFinto.js) piu' un'API Pine Algos finta che registra cio' che riceve.
 *
 *  - `visto.open`          i corpi di `openPhase`
 *  - `visto.inviate`       i corpi di `sendTrials`
 *  - `visto.progress`      i testi del progress
 *  - `visto.altreChiamate` il nome di ogni altro metodo dell'API chiamato (markRunning, finalize…):
 *                          lo strumento di fase non ne deve chiamare nessuno.
 *
 * Il registro e' in memoria, con la stessa interfaccia di `creaRegistro`. Il chart parte su
 * TVC:NDQ 15 (o su `simboloGrafico`) col periodo di ricerca gia' impostato. Lo riusa la prova del contratto (Task 16), che
 * prende le sole dipendenze TradingView e ci mette l'API vera.
 */
import { creaTradingViewFinto, INFO_FINTO, M } from './tradingviewFinto.js';

export { M };

export const STATO = {
  id: 3,
  timeframe: '15',
  boundaries: { 'TVC:NDQ': { search_from: '2018-01-01', search_until: '2024-01-01' } },
  budget: { remaining: 100, remaining_exploration: 80 },
  working_config: [{ name: 'Risk/Reward', position: 1, value: 1 }],
  map: { inputs: [{ name: 'Risk/Reward', position: 1, type: 'float', group: 'management' }] },
  next: { action: 'open_phase' },
};

function registroInMemoria() {
  const file = new Map();
  // I file messi da parte (`scarta`): il contenuto, nell'ordine in cui sono stati scartati.
  const scartati = [];
  return {
    scartati,
    leggi: (phaseId) => (file.has(String(phaseId)) ? JSON.parse(file.get(String(phaseId))) : null),
    scrivi: (phaseId, dati) => { file.set(String(phaseId), JSON.stringify(dati)); },
    cancella: (phaseId) => { file.delete(String(phaseId)); },
    scarta: (phaseId) => {
      if (!file.has(String(phaseId))) return;
      scartati.push(JSON.parse(file.get(String(phaseId))));
      file.delete(String(phaseId));
    },
  };
}

const copia = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// La chiave del confine come la trova la piattaforma (HoldoutService::sameSymbol): uguali, oppure
// un lato senza borsa e lo stesso ticker. Come la piattaforma, `openPhase` restituisce QUESTA
// scrittura, non quella di chi chiama.
const bare = (s) => String(s).toUpperCase().split(':').pop();
const stessoMercato = (a, b) => {
  const A = String(a).trim().toUpperCase();
  const B = String(b).trim().toUpperCase();
  if (A === B) return true;
  if (A.includes(':') && B.includes(':')) return false;
  return bare(A) === bare(B);
};

export function banco({ stato = STATO, fase, metricsSeq, apiOver = {}, registro, simboloGrafico = 'TVC:NDQ' } = {}) {
  const chiaveDi = (symbol) => Object.keys(stato.boundaries ?? {}).find((k) => symbol && stessoMercato(k, symbol)) ?? symbol;
  const confineDi = (symbol) => stato.boundaries?.[chiaveDi(symbol)] ?? Object.values(stato.boundaries ?? {})[0];
  const ricerca = confineDi('TVC:NDQ');
  const { deps: tv, chart } = creaTradingViewFinto({
    metricsSeq, symbol: simboloGrafico, resolution: '15',
    periodo: { label: `${ricerca.search_from} — ${ricerca.search_until}`, from: ricerca.search_from, to: ricerca.search_until },
  });

  const visto = { open: [], inviate: [], progress: [], altreChiamate: [] };
  const metodi = {
    campaignState: async () => copia(stato),
    // Accetta tutto: i controlli del confine e delle prove rimaste li deve fare lo strumento.
    openPhase: async (campaignId, body) => {
      visto.open.push(copia(body));
      const confine = confineDi(body.symbol);
      return {
        ok: true, status: 201,
        data: {
          id: 9, campaign_id: campaignId, position: 2, type: body.type, symbol: chiaveDi(body.symbol),
          trials: (body.trials || []).map((t, i) => ({
            key: t.key ?? `t${i + 1}`, label: t.label ?? null, status: 'pending',
            period_start: t.period_start ?? confine.search_from, period_end: t.period_end ?? confine.search_until,
            inputs: t.inputs ?? [],
          })),
        },
      };
    },
    getPhase: async () => copia(fase),
    sendTrials: async (phaseId, body) => {
      visto.inviate.push(copia(body));
      return { ok: true, data: { table: { phase: { position: 2 } }, budget: { remaining: 100 } } };
    },
    progress: async (commandId, message) => { visto.progress.push(message); return null; },
    ...apiOver,
  };
  const api = new Proxy(metodi, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // `then` resta assente: l'oggetto non deve sembrare una promessa.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return async () => { visto.altreChiamate.push(prop); return null; };
    },
  });

  const reg = registro ?? registroInMemoria();
  const vietata = (nome) => async () => { throw new Error(`${nome} non deve essere chiamata dallo strumento di fase`); };
  const deps = {
    ...tv,
    api,
    registro: reg,
    readInputsInfo: async () => INFO_FINTO.map((x) => ({ ...x })),
    ensureVisibleFor: async () => ({ found: true, wasHidden: false }),
    setStrategyVisibility: async () => true,
    captureScreenshot: vietata('captureScreenshot'),
    setPanelMaximized: vietata('setPanelMaximized'),
  };
  return { deps, visto, chart, registro: reg };
}
