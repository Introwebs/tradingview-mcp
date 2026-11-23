/**
 * La mappa degli input della piattaforma (nome + posizione + tipo) risolta contro il grafico.
 * Due input con lo stesso titolo si distinguono per posizione: la n-esima occorrenza e' la n.
 */
import { classifyInputs } from './btInputs.js';
import { readbackMatches } from './btChart.js';

// Tipo della mappa -> tipi di TradingView ammessi.
export const TIPI_TV = {
  int: ['integer'],
  float: ['float'],
  price: ['price', 'float'],
  bool: ['bool'],
  string: ['text'],
  enum: ['text'],
  text_area: ['text_area', 'text'],
  source: ['source'],
  timeframe: ['resolution'],
  color: ['color'],
  session: ['session'],
  symbol: ['symbol'],
  time: ['time'],
};

const TIPI_NOTI = new Set(Object.values(TIPI_TV).flat());

export function chiaveMappa(name, position = 1) {
  return `${String(name ?? '').trim().slice(0, 60)}\u0000${position}`;
}

const posizione = (v) => v.position ?? 1;

export function risolviMappa(info, mapInputs) {
  const sulGrafico = new Map();
  const viste = new Map();
  for (const item of classifyInputs(info).logic) {
    const nome = String(item.name ?? '').trim();
    const n = (viste.get(nome) ?? 0) + 1;
    viste.set(nome, n);
    sulGrafico.set(chiaveMappa(nome, n), item);
  }

  const perChiave = new Map();
  const mancanti = [];
  const tipoDiverso = [];
  // Due voci della mappa che cadono sulla stessa chiave (stessi primi 60 caratteri, o diverse solo
  // per gli spazi ai bordi): per la piattaforma sono due input, sul grafico se ne indirizzerebbe uno.
  const doppioni = [];
  const primaVoce = new Map();
  const inMappa = new Set();
  for (const voce of mapInputs || []) {
    const chiave = chiaveMappa(voce.name, posizione(voce));
    if (primaVoce.has(chiave)) {
      doppioni.push({ name: voce.name, position: posizione(voce), come: primaVoce.get(chiave).name });
      continue;
    }
    primaVoce.set(chiave, voce);
    inMappa.add(chiave);
    const item = sulGrafico.get(chiave);
    if (!item) {
      if (voce.group !== 'skip') mancanti.push({ name: voce.name, position: posizione(voce) });
      continue;
    }
    // `name` e `position` sono quelli della mappa, interi: la piattaforma indicizza per quelli.
    perChiave.set(chiave, { id: item.id, type: item.type, tipoMappa: voce.type, group: voce.group, name: voce.name, position: posizione(voce) });
    const ammessi = TIPI_TV[voce.type];
    if (voce.group !== 'skip' && ammessi && TIPI_NOTI.has(item.type) && !ammessi.includes(item.type)) {
      tipoDiverso.push({ name: voce.name, position: posizione(voce), mappa: voce.type, grafico: item.type });
    }
  }

  const nonInMappa = [];
  for (const [chiave, item] of sulGrafico) {
    const nome = String(item.name ?? '').trim();
    if (!inMappa.has(chiave) && !nonInMappa.includes(nome)) nonInMappa.push(nome);
  }
  return { perChiave, mancanti, tipoDiverso, nonInMappa, doppioni };
}

const primi = (lista, f) => lista.slice(0, 8).map(f).join(', ') + (lista.length > 8 ? ', ...' : '');

export function verificaMappa(info, mapInputs) {
  const { mancanti, tipoDiverso, nonInMappa, doppioni } = risolviMappa(info, mapInputs);
  if (!mancanti.length && !tipoDiverso.length && !doppioni.length) return null;
  const utili = (mapInputs || []).filter((v) => v.group !== 'skip').length;
  const probabile = utili > 0 && mancanti.length * 2 >= utili;
  const parti = [];
  if (mancanti.length) parti.push(`la mappa elenca input che il grafico non ha: ${primi(mancanti, (m) => m.name)}`);
  if (tipoDiverso.length) parti.push(`input con un tipo diverso dal grafico: ${primi(tipoDiverso, (t) => `${t.name} (${t.mappa} contro ${t.grafico})`)}`);
  if (doppioni.length) {
    parti.push(`due voci della mappa cadono sullo stesso input del grafico (nomi uguali nei primi 60 caratteri, o diversi solo per gli spazi ai bordi): ${primi(doppioni, (d) => `«${d.come}» e «${d.name}» (posizione ${d.position})`)}`);
  }
  if (probabile) parti.push('il grafico sembra un\'altra versione della strategia');
  return {
    kind: 'map_mismatch',
    detail: `La mappa degli input non corrisponde al grafico: ${parti.join('; ')}.`,
    mancanti,
    tipo_diverso: tipoDiverso,
    non_in_mappa: nonInMappa,
    doppioni,
    probabile_altra_versione: probabile,
  };
}

export function daApplicare(perChiave, config, attuali = {}) {
  const target = {};
  const delta = {};
  const ignoti = [];
  for (const voce of config || []) {
    const position = posizione(voce);
    const ris = perChiave.get(chiaveMappa(voce.name, position));
    if (!ris) { ignoti.push({ name: voce.name, position }); continue; }
    if (ris.tipoMappa === 'color' || ris.type === 'color') continue;
    if (voce.value === null || voce.value === undefined) continue;
    target[ris.id] = voce.value;
    if (!readbackMatches({ [ris.id]: voce.value }, attuali)) delta[ris.id] = voce.value;
  }
  return { target, delta, ignoti };
}

export function configLetta(perChiave, valori = {}) {
  const out = [];
  for (const [chiave, ris] of perChiave) {
    if (ris.tipoMappa === 'color' || ris.type === 'color') continue;
    // Il nome intero della mappa, non la chiave rifilata e tagliata a 60: e' quello che la
    // piattaforma usa per configurazione di lavoro, differenze e tabella.
    const [nomeChiave, posChiave] = chiave.split('\u0000');
    const name = ris.name ?? nomeChiave;
    const position = ris.position ?? Number(posChiave);
    out.push({ name, position, value: Object.prototype.hasOwnProperty.call(valori, ris.id) ? valori[ris.id] : null });
  }
  return out;
}
