/**
 * Lo strumento di fase (bt_phase): esegue le prove di una FASE di campagna Pine Algos e le manda
 * alla piattaforma, senza salvarle come backtest.
 *
 * Una fase si DICHIARA prima di eseguirla: la piattaforma conosce il confine del periodo riservato e
 * le prove rimaste, e rifiuta prima che parta una sola prova. Lo strumento fa gli stessi due controlli
 * in locale prima di chiamarla, cosi' una prova sbagliata non arriva nemmeno al server.
 *
 * Le prove si misurano col nucleo di bt_grind (`misuraProva`), ma qui non ci sono coda delle run,
 * screenshot ne' finalize: ogni prova diventa una riga, le righe vanno alla piattaforma in una
 * consegna sola e al modello torna SOLO la tabella che la piattaforma ha calcolato.
 *
 * Nessuna prova si perde e nessuna si rifa': dopo ogni prova le righe si scrivono in un file locale
 * (btRegistro.js); se la consegna non arriva il file resta, e la chiamata successiva con `phase_id`
 * lo consegna PRIMA di eseguire altro, togliendo dall'elenco le prove gia' misurate.
 */
import { performance } from 'node:perf_hooks';
import { setInputs as realSetInputs } from './indicators.js';
import { creaCronometro } from './cronometro.js';
import { setSymbol as realSetSymbol, setTimeframe as realSetTimeframe, getState as realGetState } from './chart.js';
import { setCustomPeriod as realSetCustomPeriod, readTestPeriod as realReadTestPeriod } from './btPeriod.js';
import {
  readPanelMetrics as realReadPanelMetrics, ensureTesterPanel as realEnsureTesterPanel,
  aggiornaReportSeObsoleto as realAggiornaReport,
  attendiReportAggiornato as realAttendiReport,
  readPeriodReport as realReadPeriodReport,
  reportObsoleto as realReportObsoleto,
} from './btPanel.js';
import { readDeepState as realReadDeepState } from './btDeep.js';
import {
  readInputsInfo as realReadInputsInfo,
  readInputValues as realReadInputValues,
  readReportFor as realReadReportFor,
  readStrategyLoading as realReadStrategyLoading,
  readStudyStatus as realReadStudyStatus,
  ensureVisibleFor as realEnsureVisibleFor,
  setStrategyVisibility as realSetStrategyVisibility,
  readCommissionFor as realReadCommissionFor,
  readbackMatches,
} from './btChart.js';
import { buildInputsPayload } from './btInputs.js';
import { resolveStrategyEntity } from './btCost.js';
import { toFinalizePayload, fingerprint } from './btMetrics.js';
import { misuraProva, fpNotoO, stessoSymbol } from './btProva.js';
import { risolviMappa, verificaMappa, daApplicare, configLetta, chiaveMappa } from './btMappa.js';
import { creaRegistro } from './btRegistro.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Valori fissati dal design: per chiamata al massimo 25 prove e 10 minuti (sotto il timeout di
// 15 minuti dei tool e del watchdog del runner); tre prove di fila a zero trade fermano la fase.
const MAX_PROVE_PER_CHIAMATA = 25;
const MAX_TEMPO_MS = 600000;
const ZERO_DI_FILA = 3;

const NOMI_FASE = { base: 'base', entry: 'ingresso', filter: 'filtri', management: 'gestione', risk: 'rischio', hold: 'tenuta' };

// I nove numeri di una riga: quelli che la piattaforma legge, con la scala di toFinalizePayload
// (le percentuali sono rapporti).
const CAMPI_METRICHE = ['net_profit', 'net_profit_pct', 'max_drawdown', 'max_drawdown_pct', 'profit_factor', 'total_trades', 'win_rate', 'sharpe', 'sortino'];

const GIORNO = /^\d{4}-\d{2}-\d{2}$/;
const giorno = (d) => typeof d === 'string' && GIORNO.test(d);

/**
 * Vero solo con entrambe le date e `search_from <= from <= to <= search_until`.
 * Le date sono stringhe YYYY-MM-DD e si confrontano come stringhe: nessuna conversione di fuso,
 * che potrebbe spostare un giorno di confine dentro il periodo riservato.
 */
export function dentroIlConfine(boundary, from, to) {
  if (!boundary || !giorno(from) || !giorno(to) || !giorno(boundary.search_from) || !giorno(boundary.search_until)) return false;
  return boundary.search_from <= from && from <= to && to <= boundary.search_until;
}

/**
 * «Stesso mercato» con la regola della piattaforma (HoldoutService::sameSymbol): uguali, oppure un
 * lato senza borsa e lo stesso ticker. Due borse DICHIARATE diverse sono due feed diversi: piu'
 * stretto di `stessoSymbol` del nucleo, che le considera uguali.
 */
function stessoMercato(a, b) {
  if (!a || !b) return false;
  const A = String(a).trim().toUpperCase();
  const B = String(b).trim().toUpperCase();
  if (A === B) return true;
  if (A.includes(':') && B.includes(':')) return false;
  const nudo = (s) => s.slice(s.lastIndexOf(':') + 1);
  return nudo(A) === nudo(B);
}

/**
 * Il confine del mercato e la sua chiave (la scrittura della campagna): chiave esatta, altrimenti
 * lo stesso mercato con la regola della piattaforma.
 */
function confineDi(boundaries, symbol) {
  if (!boundaries || !symbol) return null;
  if (boundaries[symbol]) return { chiave: symbol, confine: boundaries[symbol] };
  const chiave = Object.keys(boundaries).find((k) => stessoMercato(k, symbol));
  return chiave ? { chiave, confine: boundaries[chiave] } : null;
}

/** Configurazione come lista nome/posizione/valore: sostituisce o aggiunge, ordine stabile. */
function fondi(config, overrides) {
  const out = (config || []).map((v) => ({ ...v }));
  for (const o of overrides || []) {
    const k = chiaveMappa(o.name, o.position ?? 1);
    const i = out.findIndex((v) => chiaveMappa(v.name, v.position ?? 1) === k);
    if (i >= 0) out[i] = { ...out[i], value: o.value };
    else out.push({ name: o.name, position: o.position ?? 1, value: o.value });
  }
  return out;
}

function durataLeggibile(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// Oltre questo tempo dall'inizio della chiamata la consegna non aspetta piu' la piattaforma (i
// ritenti sul 429 possono durare minuti): il watchdog del runner uccide a 15 minuti di silenzio, e
// le righe sono gia' al sicuro nel file locale.
const LIMITE_CONSEGNA_MS = 13 * 60 * 1000;

// Le parole del progress per i fermi. Servono anche per i fermi che arrivano da fuori: le anomalie
// del nucleo di bt_grind hanno un `detail` che parla di «run» e di «symbol/timeframe», e un
// rifiuto di forma della piattaforma arriva come frase inglese di Laravel.
const MOTIVI = {
  campaign_blocked: 'la campagna è bloccata',
  map_mismatch: 'gli input della campagna non corrispondono a quelli sul grafico',
  unknown_symbol: 'il mercato non è della campagna',
  outside_search_interval: 'una prova esce dal periodo di ricerca',
  budget_exceeded: 'chiede più prove di quelle rimaste',
  study_runtime_error: 'la strategia è in errore su TradingView',
  zero_trades_systemic: `${ZERO_DI_FILA} prove di fila senza nessun trade`,
  unknown_input: 'un input della prova non è sul grafico',
  readback_mismatch: 'gli input riletti non sono quelli chiesti',
  runtime_error: 'errore imprevisto',
  deep_backtest_error: 'TradingView ha rifiutato il backtest esteso',
  report_not_synced: 'il report di TradingView non è arrivato',
  platform_unreachable: 'la piattaforma non risponde, le righe sono al sicuro in locale',
  holdout_breach: 'una prova è finita nel periodo riservato',
  period_unreadable: 'il periodo del tester non si è potuto rileggere',
  phase_not_in_campaign: 'la fase è di un\'altra campagna',
  // Dal nucleo della misura.
  inputs_not_applied: 'un input della prova non si è applicato sul grafico',
  silent_noop: 'TradingView non ha ricalcolato dopo il cambio degli input',
  stale_metrics: 'il pannello di TradingView mostra ancora i numeri della prova prima',
  baseline_unavailable: 'il pannello di TradingView non ha numeri con cui confrontare la prova',
  symbol_not_applied: 'il grafico non è passato al mercato della campagna',
  timeframe_not_applied: 'il grafico non è passato al timeframe della campagna',
  period_not_applied: 'TradingView non ha applicato il periodo della prova',
  panel_not_open: 'il pannello Strategy Tester non si è aperto',
  // Dalla piattaforma.
  phase_open: 'c\'è già una fase con prove da fare',
  decision_missing: 'l\'ultima fase non ha ancora una decisione',
  already_decided: 'la fase è già stata decisa',
  unknown_trial: 'una prova non è fra quelle dichiarate nella fase',
};
const motivoBreve = (m) => MOTIVI[m.kind]
  ?? (/^http_/.test(String(m.kind)) ? `la piattaforma ha rifiutato la richiesta (HTTP ${String(m.kind).slice(5)})` : String(m.detail || m.kind).slice(0, 160));

// I fermi che non si spiegano da soli: dicono anche cosa puo' fare l'operatore. Rifare la stessa
// chiamata senza cambiare niente ferma la stessa prova nello stesso modo (e dopo tre prove a zero
// trade ne spende altre tre).
const SENZA_RIMEDIO = new Set(['readback_mismatch', 'inputs_not_applied', 'unknown_input', 'zero_trades_systemic']);
const conRimedio = (stop, phaseId) => (SENZA_RIMEDIO.has(stop.kind)
  ? `${stop.detail} Cosa fare: se la causa si può correggere (sul grafico o nella prova), correggila e richiama bt_phase con phase_id ${phaseId}; se no registra la decisione della fase (le prove non eseguite si scartano) e dichiarane una nuova senza quel valore.`
  : stop.detail);

/**
 * Le chiamate di avvio (stato della campagna, dichiarazione, lettura della fase): se lanciano,
 * l'eccezione sale com'e', marcata, e il gestore del tool la dice in italiano. Prima di loro non si
 * e' toccato ne' il grafico ne' il file locale.
 */
async function allAvvio(chiamata) {
  try {
    return await chiamata();
  } catch (err) {
    if (err && typeof err === 'object') err.piattaforma_all_avvio = true;
    throw err;
  }
}

/** Il fermo come lo accetta la piattaforma: `kind` ≤ 60, `detail` ≤ 1000. */
const fermoPerPiattaforma = (m) => (m ? { kind: String(m.kind).slice(0, 60), detail: String(m.detail ?? '').slice(0, 1000) } : null);

export async function eseguiFase(opts, deps = {}) {
  let {
    campaign_id, phase_id = null, type = null, trials = null, symbol = null,
    entity_id = null, strategy_name = null, command_id = null,
    max_trials_per_call = MAX_PROVE_PER_CHIAMATA, time_budget_ms = MAX_TEMPO_MS,
    // Gli stessi default di grindSession.
    recalc_timeout_ms = 45000, recalc_stable_checks = 3, recalc_step_ms = 250, recalc_start_grace_ms = 5000,
  } = opts;

  const {
    api,
    setInputs = realSetInputs,
    readInputsInfo = realReadInputsInfo,
    readInputValues = realReadInputValues,
    readReportFor = realReadReportFor,
    readStrategyLoading = realReadStrategyLoading,
    readStudyStatus = realReadStudyStatus,
    readCommissionFor = realReadCommissionFor,
    ensureVisibleFor = realEnsureVisibleFor,
    setStrategyVisibility = realSetStrategyVisibility,
    setSymbol = realSetSymbol,
    setTimeframe = realSetTimeframe,
    getChartState = realGetState,
    setCustomPeriod = realSetCustomPeriod,
    readTestPeriod = realReadTestPeriod,
    readPanelMetrics = realReadPanelMetrics,
    readPeriodReport = realReadPeriodReport,
    ensureTesterPanel = realEnsureTesterPanel,
    aggiornaReportSeObsoleto = realAggiornaReport,
    attendiReportAggiornato = realAttendiReport,
    readDeepState = realReadDeepState,
    reportObsoleto = realReportObsoleto,
    registro = creaRegistro(),
    sleep = realSleep,
    now = () => performance.now(),
  } = deps;

  const t0 = now();
  const ripresa = phase_id !== null && phase_id !== undefined;
  if (!campaign_id) throw new Error('campaign_id è obbligatorio');
  if (!ripresa && (!type || !Array.isArray(trials) || !trials.length)) {
    throw new Error('serve phase_id (per riprendere una fase) oppure type + trials (per una fase nuova, almeno una prova)');
  }
  const limiteProve = Math.min(Math.max(1, Math.floor(Number(max_trials_per_call)) || MAX_PROVE_PER_CHIAMATA), MAX_PROVE_PER_CHIAMATA);
  const limiteTempo = time_budget_ms != null && Number.isFinite(Number(time_budget_ms)) ? Math.min(Number(time_budget_ms), MAX_TEMPO_MS) : MAX_TEMPO_MS;

  const esito = {
    success: true, campaign_id, phase_id: null, position: null, type: ripresa ? null : type,
    executed: 0, zero_trades: 0, failed: 0, remaining_in_phase: 0,
    stopped_reason: null, table: null, budget: null, pending_file: false, discarded_local_file: false,
  };
  let stato = null;
  let fase = null;
  // Vero appena questa chiamata prova a consegnare righe: da li' in poi `table` e `budget` sono
  // quelli della consegna (o null se e' fallita), mai quelli letti all'inizio.
  let consegnaTentata = false;
  // Una ripresa che non consegna niente restituisce la tabella e le prove rimaste come la
  // piattaforma le ha adesso: lo stato letto all'inizio della chiamata.
  let faseAltrui = false;
  const tabellaSalvata = () => {
    if (ripresa && fase && !consegnaTentata && !faseAltrui) {
      esito.table = fase.table ?? null;
      esito.budget = stato?.budget ?? null;
    }
  };
  const nome = () => NOMI_FASE[esito.type] ?? esito.type ?? '?';
  const avvisaFermo = (m) => api.progress(command_id, `⛔ Fase ${nome()}: ${motivoBreve(m)} — mi fermo`);
  const ferma = async (m) => { esito.stopped_reason = m; tabellaSalvata(); await avvisaFermo(m); return esito; };

  // 1. Lo stato della campagna, con la mappa degli input.
  stato = await allAvvio(() => api.campaignState(campaign_id));
  if (!stato) throw new Error(`campagna ${campaign_id} non trovata`);
  if (!Array.isArray(stato.map?.inputs)) throw new Error(`lo stato della campagna ${campaign_id} non porta la mappa degli input`);
  // Senza timeframe ogni prova si misurerebbe su quello che il grafico ha in quel momento.
  if (stato.timeframe == null || String(stato.timeframe).trim() === '') {
    throw new Error(`lo stato della campagna ${campaign_id} non porta il timeframe: nessuna prova si misura sul timeframe che il grafico ha per caso`);
  }
  if (stato.next?.action === 'blocked') {
    return ferma({ kind: 'campaign_blocked', detail: 'La campagna è bloccata e non accetta altre fasi: guarda in piattaforma il motivo (per esempio una prova finita nel periodo riservato).' });
  }

  // 2. La strategia sul grafico e la mappa contro il grafico, a ogni chiamata: il grafico puo' essere
  // cambiato fra due fasi. Niente e' ancora dichiarato ne' eseguito.
  if (!entity_id && strategy_name) {
    const ris = resolveStrategyEntity(await getChartState(), strategy_name);
    if (ris.error) throw new Error(`${ris.error.kind}: ${ris.error.detail}`);
    entity_id = ris.entity_id;
  }
  if (!entity_id) throw new Error('entity_id è obbligatorio (prendilo da chart_get_state, o passa strategy_name)');
  const info = await readInputsInfo(entity_id);
  if (!info.length) throw new Error(`nessun input leggibile per entity_id=${entity_id}: la strategia è sul chart?`);
  const mappaDiversa = verificaMappa(info, stato.map.inputs);
  if (mappaDiversa) return ferma(mappaDiversa);
  const { perChiave } = risolviMappa(info, stato.map.inputs);

  const mercatoChiesto = symbol ?? stato.symbol ?? stato.symbols?.[0]
    ?? (Object.keys(stato.boundaries ?? {}).length === 1 ? Object.keys(stato.boundaries)[0] : null);

  // Consegna alla piattaforma. Il file locale si cancella quando la piattaforma ha accettato, o ha
  // rifiutato con un motivo (`reason_code`: holdout_breach, already_decided, unknown_trial…): e' una
  // decisione sulla campagna, e quelle righe non vanno riproposte. Un rifiuto senza motivo (un 422
  // di forma, 401, 403, 404, 413…) non dice niente sulle prove: il file resta.
  const consegna = async (phaseId, corpo) => {
    consegnaTentata = true;
    let r;
    try { r = await api.sendTrials(phaseId, corpo); } catch (e) { return { guasto: e }; }
    if (!r?.ok) {
      const rifiuto = r ?? { message: 'risposta vuota' };
      if (rifiuto.reason_code) registro.cancella(phaseId);
      return { rifiuto };
    }
    registro.cancella(phaseId);
    esito.table = r.data?.table ?? null;
    esito.budget = r.data?.budget ?? null;
    return { ok: true };
  };
  const fermoRifiuto = (r, alSicuro) => {
    if (r.reason_code) return { kind: r.reason_code, detail: r.message, ...(r.data != null && { data: r.data }) };
    const http = r.status ?? '?';
    return {
      kind: `http_${http}`,
      detail: `La piattaforma ha rifiutato la consegna delle righe (HTTP ${http}): «${r.message ?? 'nessun messaggio'}». `
        + (alSicuro
          ? `Le righe sono al sicuro in locale: correggi la causa (il token, i permessi, o la riga che la piattaforma non accetta) e richiama bt_phase con phase_id ${esito.phase_id} per consegnarle, senza rieseguire le prove.`
          : `Le righe non si sono potute salvare in locale: le prove di questa chiamata andranno rifatte, richiama bt_phase con phase_id ${esito.phase_id}.`),
      ...(r.data != null && { data: r.data }),
    };
  };
  const fermoIrraggiungibile = (e, alSicuro) => ({
    kind: 'platform_unreachable',
    detail: alSicuro
      ? `Le righe sono al sicuro in locale: richiama bt_phase con phase_id ${esito.phase_id} per consegnarle, senza rieseguire le prove.`
      : `La piattaforma non ha risposto e le righe non si sono potute salvare in locale: le prove di questa chiamata andranno rifatte, richiama bt_phase con phase_id ${esito.phase_id}.`,
    error: String(e?.message ?? e).slice(0, 300),
  });
  // Il fermo del ciclo, tenuto dentro quello della consegna: senza, resterebbe solo nel file locale.
  const precedente = (m) => (m ? { previous: { kind: m.kind, detail: m.detail ?? null, trial: m.trial ?? null } } : {});

  // Il mercato e' quello della fase come lo scrive la piattaforma; in mancanza, la chiave del
  // confine (la scrittura della campagna), mai quella di chi chiama.
  const mercatoDella = (f) => f?.symbol ?? confineDi(stato.boundaries, mercatoChiesto)?.chiave ?? mercatoChiesto;

  // ⛔ Il cambio di mercato lo fa il nucleo (applicaContestoRun), con tutte le sue guardie sul
  // report vecchio: qui non si chiama mai setSymbol. Resta un solo caso che il nucleo non vede: lo
  // stesso ticker su due borse DICHIARATE (grafico FX:EURUSD, campagna OANDA:EURUSD). Per il nucleo
  // e' lo stesso mercato e non cambierebbe niente; per la piattaforma sono due feed, e ogni prova
  // verrebbe misurata sull'altro e registrata sotto la campagna. Ci si ferma, senza cambiare ne'
  // misurare niente: e' l'operatore a portare il grafico sul mercato giusto.
  const dueBorse = async (mercato, faseId) => {
    const sulGrafico = (await getChartState())?.symbol;
    if (!stessoSymbol(sulGrafico, mercato) || stessoMercato(sulGrafico, mercato)) return null;
    return {
      kind: 'symbol_not_applied',
      detail: `Il grafico è su ${sulGrafico}, la campagna è su ${mercato}: stesso ticker ma due borse diverse, cioè due feed diversi. Non ho cambiato niente e nessuna prova è partita. Porta il grafico su ${mercato} e richiama bt_phase`
        + (faseId != null ? ` con phase_id ${faseId}.` : ' (la fase non è stata dichiarata).'),
      chart_symbol: sulGrafico,
      campaign_symbol: mercato,
    };
  };

  // 3. La fase: nuova (controlli locali, poi dichiarazione) o ripresa.
  const consegnate = new Set();
  if (!ripresa) {
    const trovato = confineDi(stato.boundaries, mercatoChiesto);
    if (!trovato) {
      return ferma({ kind: 'unknown_symbol', detail: `Il mercato ${mercatoChiesto ?? '?'} non è fra quelli della campagna: non ha un periodo di ricerca. Nessuna prova è partita.` });
    }
    const { confine } = trovato;
    // Periodo assente = periodo di ricerca. Si dichiara il periodo esplicito: cio' che si e'
    // controllato qui e' esattamente cio' che arriva al server.
    const dichiarate = trials.map((t) => {
      const senzaPeriodo = t.period_start == null && t.period_end == null;
      return {
        ...(t.key != null && { key: t.key }),
        ...(t.label != null && { label: t.label }),
        period_start: senzaPeriodo ? confine.search_from : t.period_start ?? null,
        period_end: senzaPeriodo ? confine.search_until : t.period_end ?? null,
        inputs: t.inputs ?? [],
      };
    });
    const fuori = dichiarate.findIndex((t) => !dentroIlConfine(confine, t.period_start, t.period_end));
    if (fuori >= 0) {
      const t = dichiarate[fuori];
      return ferma({
        kind: 'outside_search_interval',
        detail: `La prova ${t.key ?? `n. ${fuori + 1}`} (${t.period_start ?? '?'} → ${t.period_end ?? '?'}) esce dal periodo di ricerca ${confine.search_from} → ${confine.search_until}: potrebbe toccare il periodo riservato. Servono entrambe le date, nel formato AAAA-MM-GG. Nessuna prova è partita e la fase non è stata dichiarata.`,
        trial: t.key ?? fuori,
      });
    }
    const budget = stato.budget ?? {};
    const rimaste = type === 'hold' ? budget.remaining : budget.remaining_exploration;
    if (typeof rimaste === 'number' && dichiarate.length > rimaste) {
      return ferma({
        kind: 'budget_exceeded',
        detail: `La fase chiede ${dichiarate.length} prove ma ne restano ${rimaste}${type === 'hold' ? '' : ' per l\'esplorazione'}: nessuna prova è partita e la fase non è stata dichiarata.`,
        budget,
      });
    }
    // Prima di dichiarare: una fase dichiarata e mai eseguita resterebbe aperta per niente.
    const borse = await dueBorse(trovato.chiave, null);
    if (borse) return ferma(borse);
    // Si dichiara la scrittura della campagna (la chiave del confine), non quella di chi chiama:
    // e' anche quella su cui poi si misura.
    const aperta = await allAvvio(() => api.openPhase(campaign_id, { type, symbol: trovato.chiave, trials: dichiarate }));
    if (!aperta?.ok) {
      const r = aperta ?? {};
      let detail = r.message;
      if (!r.reason_code) {
        detail = `La piattaforma ha rifiutato la dichiarazione della fase (HTTP ${r.status ?? '?'}): «${r.message ?? 'nessun messaggio'}». Nessuna prova è partita.`;
      } else if (r.reason_code === 'phase_open' && r.data?.phase_id != null) {
        detail = `${r.message} Per finirla richiama bt_phase con phase_id ${r.data.phase_id}.`;
      }
      return ferma({
        kind: r.reason_code || `http_${r.status ?? '?'}`, detail,
        ...(r.data?.phase_id != null && { phase_id: r.data.phase_id }),
        ...(r.data?.trial != null && { trial: r.data.trial }),
        ...(r.data?.budget != null && { budget: r.data.budget }),
      });
    }
    fase = aperta.data;
  } else {
    fase = await allAvvio(() => api.getPhase(phase_id));
    if (!fase) throw new Error(`fase ${phase_id} non trovata`);
  }
  if (!Array.isArray(fase.trials)) throw new Error(`la fase ${fase.id ?? phase_id} non porta l'elenco delle prove`);
  esito.phase_id = fase.id ?? phase_id;
  esito.position = fase.position ?? null;
  esito.type = fase.type ?? esito.type;

  if (ripresa) {
    // La fase deve essere di QUESTA campagna: configurazione di lavoro, timeframe e confini sono
    // quelli della campagna chiamata, e le righe andrebbero a un'altra.
    if (fase.campaign_id != null && String(fase.campaign_id) !== String(campaign_id)) {
      // La tabella e' di un'altra campagna: non va accanto al budget di questa.
      faseAltrui = true;
      return ferma({
        kind: 'phase_not_in_campaign',
        detail: `La fase ${esito.phase_id} è della campagna ${fase.campaign_id}, non della campagna ${campaign_id}: non la riprendo e non ho toccato il grafico. Richiama bt_phase con il campaign_id della fase.`,
      });
    }
    if (fase.decision != null) {
      return ferma({
        kind: 'already_decided',
        detail: `La fase ${esito.phase_id} è già stata decisa: le sue prove non si eseguono più. Per provare altro dichiara una fase nuova (type e trials).`,
      });
    }
    // Prima di consegnare il file e di toccare il grafico.
    const borse = await dueBorse(mercatoDella(fase), esito.phase_id);
    if (borse) return ferma(borse);

    // Le righe rimaste in locale da una chiamata precedente si consegnano PRIMA di tutto: le prove
    // gia' misurate non si rifanno. Ma solo se il file e' di questa fase: stessa campagna, e ogni
    // sua prova fra quelle dichiarate. Un file di un'altra campagna (o di un'altra piattaforma con
    // gli stessi id) porterebbe in questa i numeri di un'altra strategia, in silenzio.
    const salvato = registro.leggi(esito.phase_id);
    if (salvato) {
      const dichiarate = new Set(fase.trials.map((t) => t.key));
      const righe = Array.isArray(salvato.rows) ? salvato.rows : [];
      const suo = String(salvato.campaign_id) === String(campaign_id) && righe.every((r) => dichiarate.has(r.key));
      if (!suo) {
        registro.scarta(esito.phase_id);
        esito.discarded_local_file = true;
      } else if (righe.length) {
        const fatteInLocale = righe.filter((r) => r.status === 'measured' || r.status === 'zero_trades').map((r) => r.key);
        const c = await consegna(esito.phase_id, {
          rows: righe,
          ...(salvato.properties && { properties: salvato.properties }),
          ...(salvato.stopped_reason && { stopped_reason: salvato.stopped_reason }),
        });
        if (!c.ok) {
          const senza = fase.trials.filter((t) => t.status === 'pending' || t.status === 'failed');
          const prima = precedente(salvato.stopped_reason);
          if (c.guasto) {
            // Le righe del file restano e la prossima chiamata le consegna: quelle non sono da rifare.
            esito.remaining_in_phase = senza.filter((t) => !fatteInLocale.includes(t.key)).length;
            esito.pending_file = true;
            return ferma({ ...fermoIrraggiungibile(c.guasto, true), ...prima });
          }
          // Rifiutate: sulla piattaforma nessuna di queste prove ha un risultato.
          esito.remaining_in_phase = senza.length;
          esito.pending_file = !c.rifiuto.reason_code;
          return ferma({ ...fermoRifiuto(c.rifiuto, true), ...prima });
        }
        for (const k of fatteInLocale) consegnate.add(k);
      }
    }
  }
  // Alla ripresa prima le prove ancora da fare, per ultime quelle fallite: una prova che fallisce
  // sempre, messa in testa, fermerebbe la fase ogni volta prima che le altre partano.
  const senzaRisultato = ripresa
    ? fase.trials.filter((t) => (t.status === 'pending' || t.status === 'failed') && !consegnate.has(t.key))
    : fase.trials;
  const daFare = ripresa
    ? [...senzaRisultato.filter((t) => t.status === 'pending'), ...senzaRisultato.filter((t) => t.status === 'failed')]
    : senzaRisultato;
  esito.remaining_in_phase = daFare.length;
  if (!daFare.length) { tabellaSalvata(); return esito; }

  // Il confine si guarda anche sulle prove come le restituisce la piattaforma: e' la stessa regola,
  // e nessuna prova parte senza esserci passata.
  const mercato = mercatoDella(fase);
  const confineFase = confineDi(stato.boundaries, mercato)?.confine ?? null;
  const fuori = daFare.find((t) => !dentroIlConfine(confineFase, t.period_start, t.period_end));
  if (fuori) {
    return ferma({
      kind: 'outside_search_interval',
      detail: `La prova ${fuori.key} (${fuori.period_start ?? '?'} → ${fuori.period_end ?? '?'}) non sta nel periodo di ricerca del mercato ${mercato ?? '?'}: nessuna prova è partita.`,
      trial: fuori.key,
    });
  }

  // 4. Come grindSession: pannello, strategia visibile, studio non rotto, impronta di partenza.
  const pannello = await ensureTesterPanel();
  if (!pannello.ok) {
    throw new Error(`${pannello.error || 'pannello Strategy Tester non pronto'}. Aprilo (ui_open_panel strategy-tester) e richiama bt_phase con phase_id ${esito.phase_id}: riparte dalle prove mancanti.`);
  }
  const vis = await ensureVisibleFor(entity_id);
  if (!vis.found) {
    throw new Error(`la strategia ${entity_id} non è fra le data source del chart: aprila e richiama bt_phase con phase_id ${esito.phase_id}.`);
  }

  try {
    // Il fermo si calcola dentro la guardia e si restituisce fuori: un guasto del progress dentro
    // `ferma` non deve finire nel catch che lascia partire le prove su uno studio rotto.
    let studioRotto = null;
    try {
      const st = await readStudyStatus(entity_id);
      if (st && st.ok === false) {
        const err = st.error || 'errore di runtime';
        studioRotto = {
          kind: 'study_runtime_error',
          detail: `la strategia ${entity_id} e' in errore di runtime su TradingView: "${err}". Nessuna prova eseguita: riparala sul chart (ricaricala, oppure correggi l'input che la rompe) e richiama bt_phase con phase_id ${esito.phase_id}.`,
          entity_id, status_type: st.type,
        };
      }
    } catch { /* guardia, non oracolo: se lo stato non e' leggibile si prosegue */ }
    if (studioRotto) return await ferma(studioRotto);

    const cron = creaCronometro(now);
    const statoProva = { prevFp: fpNotoO(null, (await readReportFor(entity_id))?.metrics), snapshotCommissione: null };
    const amb = {
      entity_id, info, idsCommissione: null, stato: statoProva, cron, nota: async () => {},
      deps: {
        setInputs, readInputValues, readReportFor, readStrategyLoading, readStudyStatus, readCommissionFor,
        setSymbol, setTimeframe, getChartState, setCustomPeriod, readTestPeriod, readPanelMetrics,
        readPeriodReport, ensureTesterPanel, aggiornaReportSeObsoleto, attendiReportAggiornato,
        readDeepState, reportObsoleto, sleep, now,
      },
      opzioni: { recalc_timeout_ms, recalc_stable_checks, recalc_step_ms, recalc_start_grace_ms },
      // Una prova di fase non e' mai una variante di costo.
      leggiPadre: async () => { throw new Error('una prova di fase non ha un backtest padre'); },
    };

    // 5. Le prove.
    const rows = [];
    let properties;
    let fermo = null;
    let fileScritto = false;
    let zeroDiFila = 0;
    let fatte = 0;
    const n = daFare.length;
    await api.progress(command_id, `Fase ${nome()}: ${n} prove`);

    for (let i = 0; i < Math.min(n, limiteProve); i++) {
      // La prima prova parte sempre; dalla seconda, a tempo scaduto la chiamata si chiude e le
      // prove rimaste restano da fare.
      if (i > 0 && now() - t0 > limiteTempo) break;
      const prova = daFare[i];
      cron.apri();
      cron.assegna(prova.key);
      let riga = null;
      let stop = null;
      try {
        const configurazione = fondi(stato.working_config ?? [], prova.inputs ?? []);
        const { target, delta, ignoti } = daApplicare(perChiave, configurazione, await readInputValues(entity_id));
        if (ignoti.length) {
          stop = { kind: 'unknown_input', detail: `input della prova che il grafico non ha: ${ignoti.map((x) => `${x.name} (${x.position})`).join(', ')}` };
        } else {
          const m = await misuraProva({
            id: prova.key, label: prova.label ?? null, symbol: mercato, timeframe: stato.timeframe,
            period_start: prova.period_start, period_end: prova.period_end, input_set: delta,
          }, amb);
          switch (m.uscita) {
            case 'misurata':
            case 'zero_trade': {
              const zero = m.uscita === 'zero_trade';
              const actual = zero ? await readInputValues(entity_id) : m.actual;
              if (!readbackMatches(target, actual)) {
                stop = { kind: 'readback_mismatch', detail: 'i valori riletti non corrispondono a quelli richiesti' };
                break;
              }
              const letto = zero ? await readTestPeriod() : { from: m.periodoFinale?.from || m.periodo?.from, to: m.periodoFinale?.to || m.periodo?.to };
              // Una riga misurata porta il periodo su cui e' stata misurata, nel formato che la
              // piattaforma accetta: senza, il lotto intero verrebbe rifiutato. Il periodo NON si
              // confronta qui col confine: quel controllo (e il blocco) e' della piattaforma.
              if (!giorno(letto?.from) || !giorno(letto?.to)) {
                stop = {
                  kind: 'period_unreadable',
                  detail: `il periodo del tester non si è potuto rileggere dopo la prova (${letto?.from ?? '?'} → ${letto?.to ?? '?'}): una prova senza il periodo su cui è stata misurata non si registra. Controlla il pulsante del periodo nello Strategy Tester e richiama bt_phase con phase_id ${esito.phase_id}: riparte dalle prove mancanti.`,
                };
                break;
              }
              const p = toFinalizePayload(zero ? m.results.metrics : m.metricheFinali);
              riga = {
                key: prova.key, status: zero ? 'zero_trades' : 'measured',
                period_start: letto.from ?? null, period_end: letto.to ?? null,
                config: configLetta(perChiave, actual),
                metrics: Object.fromEntries(CAMPI_METRICHE.map((k) => [k, p[k]])),
                metrics_source: m.results.source || 'internal_api',
              };
              if (esito.type === 'base') properties = buildInputsPayload(info, actual).properties;
              // Dopo uno zero l'impronta l'ha gia' aggiornata il nucleo.
              if (!zero) statoProva.prevFp = fingerprint(m.results.metrics);
              break;
            }
            case 'contesto':
              stop = { ...m.problema };
              break;
            case 'report_prima':
            case 'report_dopo': {
              const rifiuto = m.sinc.motivo === 'errore_tradingview';
              const cosa = rifiuto ? `TradingView ha rifiutato il backtest esteso ("${m.sinc.errore}")` : `il report del backtest esteso non e' arrivato (${m.sinc.motivo})`;
              stop = {
                kind: rifiuto ? 'deep_backtest_error' : 'report_not_synced',
                detail: `${cosa}: non c'e' un report da misurare e nessuna prova e' stata registrata con numeri non suoi. La prova ${prova.key} resta da rifare.`
                  + `${rifiuto ? ' Riavvia TradingView e richiama' : ' Controlla il tester su TradingView e richiama'} bt_phase con phase_id ${esito.phase_id}: riparte dalle prove mancanti.`,
              };
              break;
            }
            case 'studio_rotto':
              stop = {
                kind: 'study_runtime_error',
                detail: `la strategia e' andata in errore di runtime su TradingView ("${m.errore}") mentre la fase girava: da qui in poi ogni prova darebbe zero trade. Riparala sul chart (ricaricala, o togli l'input che la rompe) e richiama bt_phase con phase_id ${esito.phase_id}: riparte dalle prove mancanti.`,
              };
              break;
            case 'anomalia':
              stop = { ...m.anomaly };
              break;
            default:
              // Le uscite di costo non possono capitare (una prova di fase non ha `cost_params`):
              // se capitano lo stesso, e' un'eccezione.
              throw new Error(`misuraProva: uscita inattesa "${m.uscita}" per una prova di fase`);
          }
        }
      } catch (err) {
        riga = null;
        stop = { kind: 'runtime_error', detail: `eccezione durante la prova: ${err.message}` };
      }
      const duration_ms = cron.chiudi()?.totale_ms ?? null;

      if (riga) {
        riga.duration_ms = duration_ms;
        rows.push(riga);
        fatte += 1;
        if (riga.status === 'zero_trades') {
          esito.zero_trades += 1;
          zeroDiFila += 1;
          if (zeroDiFila >= ZERO_DI_FILA) {
            stop = { kind: 'zero_trades_systemic', detail: `${zeroDiFila} prove di fila senza alcun trade: non e' il periodo, e' la configurazione (badge errore, leva, size — vedi properties.md)` };
          }
        } else {
          esito.executed += 1;
          zeroDiFila = 0;
        }
      } else {
        rows.push({ key: prova.key, status: 'failed', error: `${stop.kind}: ${stop.detail}`.slice(0, 500), duration_ms });
        esito.failed += 1;
      }
      if (stop) fermo = { ...stop, detail: conRimedio(stop, esito.phase_id), trial: prova.key, label: prova.label ?? null };

      // Dopo OGNI prova: e' la rete che rende sicura un'interruzione a meta'.
      try {
        registro.scrivi(esito.phase_id, {
          campaign_id, rows,
          ...(properties && { properties }),
          ...(fermo && { stopped_reason: fermoPerPiattaforma(fermo) }),
        });
        fileScritto = true;
      } catch { fileScritto = false; }

      if (fermo) { esito.stopped_reason = fermo; await avvisaFermo(fermo); break; }
      if ((i + 1) % 5 === 0 && i + 1 < n) await api.progress(command_id, `Fase ${nome()}: ${i + 1} di ${n}`);
    }
    esito.remaining_in_phase = n - fatte;

    // 6. Consegna. Se non riesce, `table` e `budget` restano null (non quelli di una consegna
    // precedente della stessa chiamata) e il fermo del ciclo resta dentro quello nuovo.
    if (rows.length) {
      const nonRiuscita = (m) => { esito.table = null; esito.budget = null; return ferma({ ...m, ...precedente(fermo) }); };
      if (fileScritto && now() - t0 > LIMITE_CONSEGNA_MS) {
        // Tardi per aspettare la piattaforma: le righe sono nel file e la prossima chiamata le consegna.
        consegnaTentata = true;
        esito.pending_file = true;
        await nonRiuscita({
          kind: 'platform_unreachable',
          detail: `La chiamata dura da più di ${Math.round(LIMITE_CONSEGNA_MS / 60000)} minuti: non aspetto la piattaforma. Le righe sono al sicuro in locale: richiama bt_phase con phase_id ${esito.phase_id} per consegnarle, senza rieseguire le prove.`,
        });
      } else {
        const c = await consegna(esito.phase_id, {
          rows,
          ...(properties && { properties }),
          ...(fermo && { stopped_reason: fermoPerPiattaforma(fermo) }),
        });
        if (c.guasto) {
          esito.pending_file = fileScritto;
          // Senza file le prove di questa chiamata sono da rifare.
          if (!fileScritto) esito.remaining_in_phase = n;
          await nonRiuscita(fermoIrraggiungibile(c.guasto, fileScritto));
        } else if (c.rifiuto) {
          // Rifiutate: sulla piattaforma nessuna prova di questa chiamata ha un risultato.
          esito.remaining_in_phase = n;
          esito.pending_file = fileScritto && !c.rifiuto.reason_code;
          await nonRiuscita(fermoRifiuto(c.rifiuto, fileScritto));
        }
      }
    }
    tabellaSalvata();
    await api.progress(command_id, `Fase ${nome()}: ${esito.executed + esito.zero_trades} prove in ${durataLeggibile(now() - t0)}`);
    return esito;
  } finally {
    // 7. Il chart torna com'era: se la strategia era nascosta la si rimette nascosta.
    if (vis.wasHidden) {
      try { await setStrategyVisibility(entity_id, false); } catch { /* il layout non fa fallire la fase */ }
    }
  }
}
