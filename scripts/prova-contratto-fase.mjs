#!/usr/bin/env node
/**
 * La prova del contratto fra lo strumento di fase e la piattaforma, senza grafico.
 *
 *   node scripts/prova-contratto-fase.mjs <base> <token> <project_id>
 *
 * Piattaforma VERA (via HTTP, di solito su un database usa-e-getta), TradingView FINTO (le sole
 * dipendenze TradingView del banco di tests/helpers/bancoFase.js) e client API VERO (`makeApi`).
 * Il progetto deve essere una strategia con la mappa degli input e un periodo riservato SIGILLATO su
 * TEST:CONTRATTO 15 che comincia il 2024-01-02.
 *
 * Passi: crea la campagna, deposita un piano minimo, esegue la fase `base` (e, se la mappa ha un
 * input dal nome oltre 60 caratteri, controlla che arrivi intero), la decide, esegue una fase
 * `management` con tre valori del primo input numerico della mappa, prova una fase con una prova
 * che finisce nel periodo riservato, rilegge lo stato; poi decide la gestione, esegue una fase con
 * una prova a zero trade, una che si ferma (input non applicato) e una che resta da fare, la
 * riprende con phase_id e rilegge lo stato. Stampa una riga per passo; l'ultima e' `CONTRATTO OK`
 * solo se ogni condizione tiene, altrimenti le differenze e un codice d'uscita 1.
 *
 * Non usa ~/.pinealgos: il registro locale delle righe sta in una cartella temporanea, cancellata
 * alla fine. Base, token e progetto arrivano solo dalla riga di comando.
 */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eseguiFase } from '../src/core/btFase.js';
import { makeApi } from '../src/core/pinealgos.js';
import { TIPI_TV } from '../src/core/btMappa.js';
import { creaRegistro } from '../src/core/btRegistro.js';
import { banco, M } from '../tests/helpers/bancoFase.js';

const [baseArg, token, projectArg] = process.argv.slice(2);
if (!baseArg || !token || !projectArg) {
  console.error('uso: node scripts/prova-contratto-fase.mjs <base> <token> <project_id>');
  process.exit(2);
}
const base = baseArg.replace(/\/+$/, '');
const projectId = Number(projectArg);

const SIMBOLO = 'TEST:CONTRATTO';
const TIMEFRAME = '15';
const RICHIESTO_DAL = '2018-01-01';
const ENTITY = 'contratto';

const differenze = [];
const passo = (nome, ok, dettaglio) => {
  console.log(`${ok ? 'OK' : 'KO'}  ${nome}${dettaglio ? ` — ${dettaglio}` : ''}`);
  if (!ok) differenze.push(`${nome}: ${dettaglio}`);
  return ok;
};
const breve = (x) => JSON.stringify(x)?.slice(0, 600);

/** Le chiamate che lo strumento non fa (crea, piano, decisione): fetch diretta, corpo sempre letto. */
async function chiama(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* resta il testo */ }
  return { status: res.status, json, text: text.slice(0, 600) };
}

// Un valore iniziale per tipo di mappa: e' quello che il grafico finto "ha" e che la base deve riportare.
const VALORE_PER_TIPO = {
  int: 10, float: 2, price: 1.5, bool: true, string: 'A', enum: 'A', text_area: 'A',
  source: 'close', timeframe: '', session: '0930-1600', symbol: SIMBOLO, time: 0,
};
const NUMERICI = ['int', 'float', 'price'];

// Metriche finte con le percentuali come rapporti (come TradingView): ognuna diversa dall'altra,
// cosi' ogni ricalcolo ha un'impronta nuova.
const metriche = Array.from({ length: 30 }, (_, i) => M({
  net_profit: 30000 + 1000 * i, net_profit_percent: 0.3 + 0.01 * i,
  max_drawdown: 15000 + 100 * i, max_drawdown_percent: 0.15 + 0.001 * i,
  profit_factor: 1.3 + 0.02 * i, total_trades: 200 + i, percent_profitable: 0.45,
}));

const dirRegistro = mkdtempSync(join(tmpdir(), 'prova-contratto-fase-'));
let codice = 1;
try {
  codice = await prova();
} catch (err) {
  console.log(`KO  eccezione — ${err.stack || err.message}`);
  codice = 1;
} finally {
  rmSync(dirRegistro, { recursive: true, force: true });
}
process.exit(codice);

async function prova() {
  const api = makeApi({ base, token });

  // 1. La campagna.
  const creata = await chiama('POST', `/api/v1/projects/${projectId}/campaigns`, { symbol: SIMBOLO, timeframe: TIMEFRAME, requested_from: RICHIESTO_DAL });
  const campagna = creata.json?.data;
  const confine = campagna?.boundaries?.[SIMBOLO];
  if (!passo('crea la campagna', creata.status === 201 && campagna?.id && confine?.search_until === '2024-01-01',
    creata.status === 201 ? `id ${campagna?.id}, ricerca ${confine?.search_from} → ${confine?.search_until}, riserva ${confine?.reserve_kind} ${confine?.reserved_from} → ${confine?.reserved_until} (${confine?.final_check})`
      : `HTTP ${creata.status} ${creata.text}`)) return fine();
  const campaignId = campagna.id;

  // 2. La mappa letta come la legge lo strumento, poi il piano minimo.
  let stato = await api.campaignState(campaignId);
  const mappa = stato?.map?.inputs;
  if (!passo('legge lo stato con la mappa', Array.isArray(mappa) && mappa.length > 0, `${mappa?.length ?? 0} input nella mappa, next ${stato?.next?.action}`)) return fine();
  const numerico = mappa.find((v) => NUMERICI.includes(v.type) && v.group !== 'skip');
  if (!passo('primo input numerico della mappa', !!numerico, numerico ? `${numerico.name} (${numerico.type}, posizione ${numerico.position})` : 'nessuno')) return fine();

  const piano = {
    starting_points: [{ label: 'base', inputs: [] }],
    phases: [
      { type: 'base', inputs: [], trials: 1 },
      { type: 'management', inputs: [{ name: numerico.name, position: numerico.position }], trials: 3 },
      { type: 'hold', inputs: [], trials: 2 },
    ],
    budget: { exploration: 20, hold: 5 },
  };
  const depositato = await chiama('PUT', `/api/v1/campaigns/${campaignId}/plan`, { plan: piano });
  if (!passo('deposita il piano', depositato.status === 200 && depositato.json?.data?.next?.action === 'open_phase',
    depositato.status === 200 ? `status ${depositato.json?.data?.status}, next ${depositato.json?.data?.next?.action}` : `HTTP ${depositato.status} ${depositato.text}`)) return fine();

  // 3. Il grafico finto costruito dalla mappa: un input per voce, col tipo tradotto, piu' una
  // Proprieta' (Initial Capital, senza group) che il banco ha gia' nei valori.
  stato = await api.campaignState(campaignId);
  const info = stato.map.inputs.map((v, i) => ({ id: `in_${i}`, name: v.name, type: (TIPI_TV[v.type] ?? [v.type])[0], group: 'Contratto' }));
  info.push({ id: 'in_40', name: 'Initial Capital', type: 'float', group: null });
  let valori = { in_40: 10000 };
  stato.map.inputs.forEach((v, i) => {
    valori[`in_${i}`] = v.type === 'color' ? 4278190335 : (VALORE_PER_TIPO[v.type] ?? 'A');
  });
  const iniziali = { ...valori };
  const idNumerico = `in_${stato.map.inputs.indexOf(stato.map.inputs.find((v) => v.name === numerico.name && v.position === numerico.position))}`;

  const b = banco({ stato, metricsSeq: metriche });
  const registro = creaRegistro({ dir: dirRegistro });
  const deps = {
    ...b.deps,
    api,
    registro,
    readInputsInfo: async () => info.map((x) => ({ ...x })),
    readInputValues: async () => ({ ...valori }),
    setInputs: async (args) => { valori = { ...valori, ...args.inputs }; return b.deps.setInputs(args); },
  };
  const opzioni = { campaign_id: campaignId, symbol: SIMBOLO, entity_id: ENTITY };

  // 4. La base.
  const fBase = await eseguiFase({ ...opzioni, type: 'base', trials: [{}] }, deps);
  if (!passo('fase base', fBase.executed === 1 && !!fBase.table?.reference && fBase.stopped_reason === null,
    `executed ${fBase.executed}, reference ${breve(fBase.table?.reference)}${fBase.stopped_reason ? `, fermo ${breve(fBase.stopped_reason)}` : ''}`)) return fine();

  stato = await api.campaignState(campaignId);
  const attesa = stato.map.inputs.map((v, i) => ({ v, i })).filter(({ v }) => v.type !== 'color')
    .map(({ v, i }) => ({ name: v.name, position: v.position, value: iniziali[`in_${i}`] }));
  const lavoro = stato.working_config;
  const lavoroOk = Array.isArray(lavoro) && lavoro.length === attesa.length
    && attesa.every((a) => lavoro.some((w) => w.name === a.name && Number(w.position) === a.position && (w.value === a.value || (typeof a.value === 'number' && Number(w.value) === a.value))));
  passo('la base registra i valori del grafico', lavoroOk, `working_config ${breve(lavoro)}`);
  // Un nome oltre 60 caratteri: la riga deve portarlo intero, come la piattaforma lo indicizza.
  // Se la mappa non ne ha, il passo si segnala e si salta (non e' una differenza).
  const lungo = stato.map.inputs.find((v) => v.type !== 'color' && String(v.name).length > 60);
  if (lungo) {
    passo('input dal nome lungo', Array.isArray(lavoro) && lavoro.some((w) => w.name === lungo.name && Number(w.position ?? 1) === Number(lungo.position ?? 1)),
      `«${lungo.name}» (${lungo.name.length} caratteri) in working_config: ${lavoro?.some((w) => w.name === lungo.name) ? 'col nome intero' : 'ASSENTE col nome intero'}`);
  } else {
    console.log('--  input dal nome lungo — la mappa non ha nomi oltre 60 caratteri: passo saltato');
  }
  passo('la base registra le Proprieta', stato.measurement?.properties?.['Initial Capital'] === 10000, `measurement ${breve(stato.measurement)}`);
  passo('next dopo la base', stato.next?.action === 'decide' && stato.next?.phase_id === fBase.phase_id, `next ${breve(stato.next)}`);

  // 5. La decisione sulla base.
  const deciso = await chiama('POST', `/api/v1/campaign-phases/${fBase.phase_id}/decision`, { adopt: [], reason: 'Base misurata: si parte dai valori di partenza.' });
  if (!passo('decide la base', deciso.status === 200 && deciso.json?.data?.next?.action === 'open_phase',
    deciso.status === 200 ? `next ${breve(deciso.json?.data?.next)}` : `HTTP ${deciso.status} ${deciso.text}`)) return fine();

  // 6. La fase di gestione: tre valori del primo input numerico, tutti diversi da quello di lavoro.
  const v0 = iniziali[idNumerico];
  const passi = numerico.type === 'int' ? [1, 2, 3] : [0.5, 1, 1.5];
  const prove = passi.map((d) => ({ inputs: [{ name: numerico.name, position: numerico.position, value: v0 + d }] }));
  const fGest = await eseguiFase({ ...opzioni, type: 'management', trials: prove }, deps);
  const serie = fGest.table?.inputs?.[0];
  if (!passo('fase management', fGest.executed === 3 && !!serie?.reading && fGest.budget?.used === 4 && fGest.stopped_reason === null,
    `executed ${fGest.executed}, inputs[0] ${serie ? `${serie.name} reading ${serie.reading} proposed ${breve(serie.proposed)}` : 'assente'}, budget.used ${fGest.budget?.used}${fGest.stopped_reason ? `, fermo ${breve(fGest.stopped_reason)}` : ''}`)) return fine();
  passo('righe consegnate, niente in locale', readdirSync(dirRegistro).length === 0, `file nel registro: ${readdirSync(dirRegistro).join(', ') || 'nessuno'}`);

  // 7. Una prova che finisce nel periodo riservato: nessuna prova parte.
  const prima = valori[idNumerico];
  const fRiservato = await eseguiFase({
    ...opzioni, type: 'management',
    trials: [{ inputs: [{ name: numerico.name, position: numerico.position, value: v0 + 2 }], period_start: '2023-01-02', period_end: '2024-03-01' }],
  }, deps);
  passo('prova nel periodo riservato', fRiservato.stopped_reason?.kind === 'outside_search_interval' && fRiservato.executed === 0 && valori[idNumerico] === prima,
    `fermo ${fRiservato.stopped_reason?.kind}, executed ${fRiservato.executed}, input sul grafico ${valori[idNumerico] === prima ? 'non toccato' : 'CAMBIATO'}`);

  // 8. Lo stato finale.
  const finale = await chiama('GET', `/api/v1/campaigns/${campaignId}`);
  const next = finale.json?.data?.next;
  passo('stato finale', finale.status === 200 && next?.action === 'decide' && next?.phase_id === fGest.phase_id,
    finale.status === 200 ? `next ${breve(next)}, budget ${breve(finale.json?.data?.budget)}, status ${finale.json?.data?.status}` : `HTTP ${finale.status} ${finale.text}`);

  // 9. La gestione si decide, per poter dichiarare un'altra fase.
  const decisoGest = await chiama('POST', `/api/v1/campaign-phases/${fGest.phase_id}/decision`, { adopt: [], reason: 'Gestione misurata: si resta sui valori di lavoro.' });
  if (!passo('decide la gestione', decisoGest.status === 200 && decisoGest.json?.data?.next?.action === 'open_phase',
    decisoGest.status === 200 ? `next ${breve(decisoGest.json?.data?.next)}` : `HTTP ${decisoGest.status} ${decisoGest.text}`)) return fine();

  // 10. Una fase con una prova a zero trade, una che si ferma (input non applicato) e una che
  // resta da fare. Il grafico finto decide dal valore dell'input numerico.
  const passiZ = numerico.type === 'int' ? [4, 5, 6] : [0.25, 0.75, 1.25];
  const [vZero, vFallita, vOk] = passiZ.map((d) => v0 + d);
  let rompiUnaVolta = true;
  const conZero = (r) => (r && r.metrics && valori[idNumerico] === vZero ? { ...r, metrics: { ...r.metrics, total_trades: 0 } } : r);
  const depsProve = {
    ...deps,
    readReportFor: async (id) => conZero(await deps.readReportFor(id)),
    readPanelMetrics: async () => conZero(await deps.readPanelMetrics()),
    setInputs: async (args) => {
      if (rompiUnaVolta && Object.values(args.inputs || {}).includes(vFallita)) {
        rompiUnaVolta = false;
        return { updated_inputs: {}, missing: Object.keys(args.inputs) };
      }
      return deps.setInputs(args);
    },
  };
  const proveZF = [vZero, vFallita, vOk].map((value) => ({ inputs: [{ name: numerico.name, position: numerico.position, value }] }));
  const fZF = await eseguiFase({ ...opzioni, type: 'management', trials: proveZF, recalc_start_grace_ms: 500 }, depsProve);
  if (!passo('fase con zero trade e un fermo', fZF.zero_trades === 1 && fZF.failed === 1 && fZF.stopped_reason?.kind === 'inputs_not_applied'
      // remaining 2: la fallita e quella mai partita sono entrambe senza risultato.
      && fZF.stopped_reason?.trial === 't2' && fZF.remaining_in_phase === 2 && !!fZF.table && fZF.pending_file === false,
    `zero ${fZF.zero_trades}, failed ${fZF.failed}, fermo ${fZF.stopped_reason?.kind} su ${fZF.stopped_reason?.trial}, remaining ${fZF.remaining_in_phase}, table ${fZF.table ? 'presente' : 'assente'}, pending_file ${fZF.pending_file}`)) return fine();
  const letta = await chiama('GET', `/api/v1/campaign-phases/${fZF.phase_id}`);
  const stati = letta.json?.data?.trials?.map((t) => t.status);
  passo('la piattaforma ha la riga a zero trade, la fallita e il fermo', letta.status === 200
      && JSON.stringify(stati) === JSON.stringify(['zero_trades', 'failed', 'pending']) && letta.json?.data?.stop?.kind === 'inputs_not_applied',
    letta.status === 200 ? `stati ${breve(stati)}, stop ${breve(letta.json?.data?.stop)}` : `HTTP ${letta.status} ${letta.text}`);
  stato = await api.campaignState(campaignId);
  passo('next dopo il fermo', stato.next?.action === 'run_phase' && stato.next?.phase_id === fZF.phase_id, `next ${breve(stato.next)}`);

  // 11. La ripresa con phase_id: prima la prova da fare, poi la fallita, che ora passa.
  const fRipresa = await eseguiFase({ ...opzioni, phase_id: fZF.phase_id, recalc_start_grace_ms: 500 }, depsProve);
  passo('ripresa con phase_id', fRipresa.executed === 2 && fRipresa.failed === 0 && fRipresa.remaining_in_phase === 0 && fRipresa.stopped_reason === null
      && !!fRipresa.table && fRipresa.discarded_local_file === false,
    `executed ${fRipresa.executed}, failed ${fRipresa.failed}, remaining ${fRipresa.remaining_in_phase}, table ${fRipresa.table ? 'presente' : 'assente'}${fRipresa.stopped_reason ? `, fermo ${breve(fRipresa.stopped_reason)}` : ''}`);
  passo('dopo la ripresa niente in locale', readdirSync(dirRegistro).length === 0, `file nel registro: ${readdirSync(dirRegistro).join(', ') || 'nessuno'}`);

  // 12. Lo stato dopo la ripresa.
  const dopoRipresa = await chiama('GET', `/api/v1/campaigns/${campaignId}`);
  const nextRipresa = dopoRipresa.json?.data?.next;
  passo('stato dopo la ripresa', dopoRipresa.status === 200 && nextRipresa?.action === 'decide' && nextRipresa?.phase_id === fZF.phase_id,
    dopoRipresa.status === 200 ? `next ${breve(nextRipresa)}, budget ${breve(dopoRipresa.json?.data?.budget)}` : `HTTP ${dopoRipresa.status} ${dopoRipresa.text}`);

  return fine();
}

function fine() {
  if (differenze.length) {
    console.log(`CONTRATTO NON OK — ${differenze.length} differenze:`);
    for (const d of differenze) console.log(`  - ${d}`);
    return 1;
  }
  console.log('CONTRATTO OK');
  return 0;
}
