/**
 * Un tester di TradingView finto, in modalita' ESTESO, fedele a cio' che e' stato misurato dal vivo il
 * 2026-11-23 (NDQ Box Strategy, TVC:DJI 5m). Il tempo e' finto: avanza solo con `sleep`.
 *
 *  - cambio di periodo            -> parte da sola una richiesta, senza banner;
 *  - cambio di input a fermo      -> banner subito, NESSUNA richiesta finche' non si preme il pulsante;
 *  - click su "Aggiorna report"   -> il banner sparisce subito, la richiesta parte dopo `partenzaMs`;
 *  - cambio di input IN VOLO      -> il banner NON compare finche' la richiesta in corso non atterra;
 *                                    poi atterra il risultato VECCHIO e solo allora compare il banner;
 *  - finche' una richiesta e' in volo il pannello mostra il report di prima.
 *
 * `mostrato` e' cio' con cui e' stato calcolato il report che si vede: e' la verita' contro cui i test
 * confrontano quello che il grind registra.
 */
export function creaTesterFinto({
  periodo = { from: '2022-12-08', to: '2023-12-08' },
  inputs = { in_0: 2 },
  durataMs = 5000,
  partenzaMs = 300,
  deep = true,
  metriche = (p, i) => ({
    net_profit: 1000 + Number(i.in_0) * 100 + p.from.length + Number(p.from.slice(0, 4)),
    net_profit_percent: 0.01, max_drawdown: 10, max_drawdown_percent: 0.005,
    profit_factor: 1.5, total_trades: 100 + Math.round(Number(i.in_0) * 10) + Number(p.from.slice(2, 4)), percent_profitable: 0.5,
  }),
} = {}) {
  let t = 0;
  const s = {
    periodo: { ...periodo }, inputs: { ...inputs },
    mostrato: { periodo: { ...periodo }, inputs: { ...inputs } },
    banner: false, bannerInSospeso: false,
    inVolo: null, inPartenza: null,
    requestId: 0, status: 2, errore: null, deep,
    click: 0, ultimoSetInputs: -Infinity,
    prossimoErrore: null,
  };
  const uguali = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function parti() {
    s.inPartenza = null;
    s.requestId += 1;
    s.status = 1;
    s.inVolo = { arrivo: t + durataMs, periodo: { ...s.periodo }, inputs: { ...s.inputs }, errore: s.prossimoErrore };
    s.prossimoErrore = null;
  }
  function atterra() {
    const r = s.inVolo;
    s.inVolo = null;
    if (r.errore) { s.status = 3; s.errore = r.errore; return; }
    s.mostrato = { periodo: r.periodo, inputs: r.inputs };
    s.status = 2;
    if (s.bannerInSospeso || !uguali(r.inputs, s.inputs)) { s.banner = true; s.bannerInSospeso = false; }
  }
  function avanza(ms) {
    const fine = t + ms;
    // Gli eventi si processano in ordine di tempo, cosi' una partenza e un atterraggio dentro la
    // stessa attesa non si scavalcano.
    for (;;) {
      const prossimi = [s.inPartenza?.a, s.inVolo?.arrivo].filter((x) => x !== undefined && x !== null && x <= fine);
      if (!prossimi.length) break;
      t = Math.min(...prossimi);
      if (s.inPartenza && s.inPartenza.a === t) parti();
      else if (s.inVolo && s.inVolo.arrivo === t) atterra();
    }
    t = fine;
  }

  return {
    stato: s,
    now: () => t,
    sleep: async (ms) => { avanza(ms); },
    /** Le metriche del report che il pannello mostra ADESSO. */
    metricheMostrate: () => metriche(s.mostrato.periodo, s.mostrato.inputs),
    metricheDi: (p, i) => metriche(p, i),
    setPeriodo(p) {
      s.periodo = { ...p };
      s.banner = false; s.bannerInSospeso = false;
      s.inPartenza = null;
      parti();
    },
    setInputs(nuovi) {
      const prima = JSON.stringify(s.inputs);
      s.inputs = { ...s.inputs, ...nuovi };
      s.ultimoSetInputs = t;
      if (JSON.stringify(s.inputs) === prima) return;
      if (s.inVolo || s.inPartenza) s.bannerInSospeso = true;
      else s.banner = true;
    },
    cliccaAggiorna() {
      if (!s.banner) return { obsoleto: false, cliccato: false };
      s.banner = false;
      s.click += 1;
      s.inPartenza = { a: t + partenzaMs };
      return { obsoleto: true, cliccato: true };
    },
    reportObsoleto: () => s.banner,
    /** Il ricalcolo sul GRAFICO (non il report esteso): isLoading resta true fra 0,7 e 2,4 s dal set. */
    strategiaInCaricamento: () => t - s.ultimoSetInputs >= 700 && t - s.ultimoSetInputs < 2400,
    readDeepState: () => ({
      found: true, deep: s.deep, status: s.deep ? s.status : null,
      error: s.status === 3 ? s.errore : null, requestId: s.requestId,
    }),
    /** La prossima richiesta che parte verra' rifiutata da TradingView con questo errore. */
    rifiutaLaProssima(errore = 'not_allowed') { s.prossimoErrore = errore; },
  };
}
