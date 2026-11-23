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

/** Il confine del mercato: chiave esatta, altrimenti lo stesso mercato con o senza borsa. */
function confineDi(boundaries, symbol) {
  if (!boundaries || !symbol) return null;
  if (boundaries[symbol]) return boundaries[symbol];
  const chiave = Object.keys(boundaries).find((k) => stessoSymbol(k, symbol));
  return chiave ? boundaries[chiave] : null;
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

// Le parole del progress per i fermi piu' comuni. Gli altri hanno gia' un `detail` in italiano
// (le anomalie della misura, i rifiuti del server).
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
};
const motivoBreve = (m) => MOTIVI[m.kind] ?? String(m.detail || m.kind).slice(0, 160);

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
    stopped_reason: null, table: null, budget: null, pending_file: false,
  };
  const nome = () => NOMI_FASE[esito.type] ?? esito.type ?? '?';
  const avvisaFermo = (m) => api.progress(command_id, `⛔ Fase ${nome()}: ${motivoBreve(m)} — mi fermo`);
  const ferma = async (m) => { esito.stopped_reason = m; await avvisaFermo(m); return esito; };

  // 1. Lo stato della campagna, con la mappa degli input.
  const stato = await api.campaignState(campaign_id);
  if (!stato) throw new Error(`campagna ${campaign_id} non trovata`);
  if (!Array.isArray(stato.map?.inputs)) throw new Error(`lo stato della campagna ${campaign_id} non porta la mappa degli input`);
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

  // Consegna alla piattaforma. Il file locale si cancella quando la piattaforma ha risposto, anche
  // con un rifiuto (le righe rifiutate non vanno riproposte); resta solo se non ha risposto.
  const consegna = async (phaseId, corpo) => {
    let r;
    try { r = await api.sendTrials(phaseId, corpo); } catch (e) { return { guasto: e }; }
    registro.cancella(phaseId);
    if (!r?.ok) return { rifiuto: r ?? { message: 'risposta vuota' } };
    esito.table = r.data?.table ?? null;
    esito.budget = r.data?.budget ?? null;
    return { ok: true };
  };
  const fermoRifiuto = (r) => ({ kind: r.reason_code || `http_${r.status ?? '?'}`, detail: r.message, ...(r.data != null && { data: r.data }) });
  const fermoIrraggiungibile = (e, alSicuro) => ({
    kind: 'platform_unreachable',
    detail: alSicuro
      ? 'Le righe sono al sicuro in locale: richiama bt_phase con phase_id per consegnarle, senza rieseguire le prove.'
      : 'La piattaforma non ha risposto e le righe non si sono potute salvare in locale: le prove di questa chiamata andranno rifatte, richiama bt_phase con phase_id.',
    error: String(e?.message ?? e).slice(0, 300),
  });

  // 3. La fase: nuova (controlli locali, poi dichiarazione) o ripresa.
  let fase;
  const consegnate = new Set();
  if (!ripresa) {
    const confine = confineDi(stato.boundaries, mercatoChiesto);
    if (!confine) {
      return ferma({ kind: 'unknown_symbol', detail: `Il mercato ${mercatoChiesto ?? '?'} non è fra quelli della campagna: non ha un periodo di ricerca. Nessuna prova è partita.` });
    }
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
    const aperta = await api.openPhase(campaign_id, { type, symbol: mercatoChiesto, trials: dichiarate });
    if (!aperta?.ok) {
      const r = aperta ?? {};
      return ferma({
        kind: r.reason_code || `http_${r.status ?? '?'}`, detail: r.message,
        ...(r.data?.phase_id != null && { phase_id: r.data.phase_id }),
        ...(r.data?.trial != null && { trial: r.data.trial }),
        ...(r.data?.budget != null && { budget: r.data.budget }),
      });
    }
    fase = aperta.data;
  } else {
    fase = await api.getPhase(phase_id);
    if (!fase) throw new Error(`fase ${phase_id} non trovata`);
  }
  if (!Array.isArray(fase.trials)) throw new Error(`la fase ${fase.id ?? phase_id} non porta l'elenco delle prove`);
  esito.phase_id = fase.id ?? phase_id;
  esito.position = fase.position ?? null;
  esito.type = fase.type ?? esito.type;

  if (ripresa) {
    // Le righe rimaste in locale da una chiamata precedente si consegnano PRIMA di tutto: le prove
    // gia' misurate non si rifanno.
    const salvato = registro.leggi(esito.phase_id);
    if (salvato?.rows?.length) {
      const fatteInLocale = salvato.rows.filter((r) => r.status === 'measured' || r.status === 'zero_trades').map((r) => r.key);
      const c = await consegna(esito.phase_id, {
        rows: salvato.rows,
        ...(salvato.properties && { properties: salvato.properties }),
        ...(salvato.stopped_reason && { stopped_reason: salvato.stopped_reason }),
      });
      if (!c.ok) {
        esito.remaining_in_phase = fase.trials.filter((t) => (t.status === 'pending' || t.status === 'failed') && !fatteInLocale.includes(t.key)).length;
        if (c.guasto) { esito.pending_file = true; return ferma(fermoIrraggiungibile(c.guasto, true)); }
        return ferma(fermoRifiuto(c.rifiuto));
      }
      for (const k of fatteInLocale) consegnate.add(k);
    }
  }
  const daFare = ripresa
    ? fase.trials.filter((t) => (t.status === 'pending' || t.status === 'failed') && !consegnate.has(t.key))
    : fase.trials;
  esito.remaining_in_phase = daFare.length;
  if (!daFare.length) return esito;

  // Il confine si guarda anche sulle prove come le restituisce la piattaforma: e' la stessa regola,
  // e nessuna prova parte senza esserci passata.
  const mercato = fase.symbol ?? mercatoChiesto;
  const confineFase = confineDi(stato.boundaries, mercato);
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
    try {
      const st = await readStudyStatus(entity_id);
      if (st && st.ok === false) {
        const err = st.error || 'errore di runtime';
        return await ferma({
          kind: 'study_runtime_error',
          detail: `la strategia ${entity_id} e' in errore di runtime su TradingView: "${err}". Nessuna prova eseguita: riparala sul chart (ricaricala, oppure correggi l'input che la rompe) e richiama bt_phase con phase_id ${esito.phase_id}.`,
          entity_id, status_type: st.type,
        });
      }
    } catch { /* guardia, non oracolo: se lo stato non e' leggibile si prosegue */ }

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
                  + `${rifiuto ? ' Riavvia TradingView e richiama' : ' Controlla il tester su TradingView e richiama'} bt_phase con phase_id: riparte dalle prove mancanti.`,
              };
              break;
            }
            case 'studio_rotto':
              stop = {
                kind: 'study_runtime_error',
                detail: `la strategia e' andata in errore di runtime su TradingView ("${m.errore}") mentre la fase girava: da qui in poi ogni prova darebbe zero trade. Riparala sul chart (ricaricala, o togli l'input che la rompe) e richiama bt_phase con phase_id: riparte dalle prove mancanti.`,
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
      if (stop) fermo = { ...stop, trial: prova.key, label: prova.label ?? null };

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

    // 6. Consegna.
    if (rows.length) {
      const c = await consegna(esito.phase_id, {
        rows,
        ...(properties && { properties }),
        ...(fermo && { stopped_reason: fermoPerPiattaforma(fermo) }),
      });
      if (c.guasto) {
        esito.pending_file = fileScritto;
        await ferma(fermoIrraggiungibile(c.guasto, fileScritto));
      } else if (c.rifiuto) {
        await ferma(fermoRifiuto(c.rifiuto));
      }
    }
    await api.progress(command_id, `Fase ${nome()}: ${esito.executed + esito.zero_trades} prove in ${durataLeggibile(now() - t0)}`);
    return esito;
  } finally {
    // 7. Il chart torna com'era: se la strategia era nascosta la si rimette nascosta.
    if (vis.wasHidden) {
      try { await setStrategyVisibility(entity_id, false); } catch { /* il layout non fa fallire la fase */ }
    }
  }
}
