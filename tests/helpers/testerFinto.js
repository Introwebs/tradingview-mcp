/**
 * Un tester di TradingView finto, in modalita' ESTESO, fedele a cio' che e' stato misurato dal vivo il
 * 2026-11-23 (NDQ Box Strategy, TVC:DJI 5m). Il tempo e' finto: avanza solo con `sleep`.
 *
 *  - cambio di periodo o timeframe -> parte da sola una richiesta, senza banner;
 *  - cambio di input a fermo       -> banner subito, NESSUNA richiesta finche' non si preme il pulsante;
 *  - click su "Aggiorna report"    -> il banner sparisce subito; lo stato va a 1 dopo `partenzaMs` e il
 *                                     contatore avanza `ritardoIdMs` piu' tardi (misurato: 0,2 e 0,4 s);
 *  - cambio di input IN VOLO       -> il banner NON compare finche' la richiesta in corso non atterra;
 *                                     poi atterra il risultato VECCHIO e compare il banner;
 *  - finche' una richiesta e' in volo il pannello mostra il report di prima;
 *  - un rifiuto (`not_allowed`) e' PERSISTENTE: da li' ogni richiesta fallisce subito, come dal vivo,
 *    finche' non si chiama `riavvia()`.
 *
 * I ritardi che dal vivo non sono stati misurati sotto i 200 ms sono parametri (`ritardoBannerMs`,
 * `partenzaPeriodoMs`), cosi' i test possono provare che il codice non ci si appoggia.
 *
 * `mostrato` e' cio' con cui e' stato calcolato il report che si vede: e' la verita' contro cui i test
 * confrontano quello che il grind registra.
 */
export function creaTesterFinto({
  periodo = { from: '2022-12-08', to: '2023-12-08' },
  timeframe = '5',
  inputs = { in_0: 2 },
  durataMs = 5000,
  partenzaMs = 200,
  ritardoIdMs = 200,
  partenzaPeriodoMs = 0,
  ritardoBannerMs = 0,
  deep = true,
  statoIniziale = 2,
  requestIdIniziale = 0,
  bannerMaiPerInput = [],
  metriche = (p, i, tf) => ({
    net_profit: 1000 + Number(i.in_0) * 100 + Number(p.from.slice(0, 4)) + Number(tf),
    net_profit_percent: 0.01, max_drawdown: 10, max_drawdown_percent: 0.005,
    profit_factor: 1.5,
    total_trades: 100 + Math.round(Number(i.in_0) * 10) + Number(p.from.slice(2, 4)) + Number(tf) * 3,
    percent_profitable: 0.5,
  }),
} = {}) {
  let t = 0;
  const s = {
    periodo: { ...periodo }, timeframe: String(timeframe), inputs: { ...inputs },
    mostrato: { periodo: { ...periodo }, timeframe: String(timeframe), inputs: { ...inputs } },
    banner: false, bannerInSospeso: false,
    inVolo: null,
    requestId: requestIdIniziale, status: statoIniziale, errore: null, deep,
    click: 0, ultimoSetInputs: -Infinity,
    rifiuto: null,
  };
  /** Eventi futuri {a, fn}, eseguiti in ordine di tempo da `avanza`. */
  let eventi = [];
  const tra = (ms, fn) => { eventi.push({ a: t + ms, fn }); };
  const uguali = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function parti() {
    // Una richiesta nuova rimpiazza quella in volo (TradingView non le accoda).
    const mia = { periodo: { ...s.periodo }, timeframe: s.timeframe, inputs: { ...s.inputs } };
    s.inVolo = mia;
    s.status = 1;
    tra(ritardoIdMs, () => { s.requestId += 1; });
    if (s.rifiuto) {
      tra(Math.min(ritardoIdMs + 50, durataMs), () => { if (s.inVolo === mia) { s.inVolo = null; s.status = 3; s.errore = s.rifiuto; } });
      return;
    }
    tra(durataMs, () => { if (s.inVolo === mia) atterra(mia); });
  }
  function atterra(r) {
    s.inVolo = null;
    s.mostrato = { periodo: r.periodo, timeframe: r.timeframe, inputs: r.inputs };
    s.status = 2;
    if (s.bannerInSospeso || !uguali(r.inputs, s.inputs)) {
      s.bannerInSospeso = false;
      if (ritardoBannerMs > 0) tra(ritardoBannerMs, () => { if (!s.inVolo) s.banner = true; });
      else s.banner = true;
    }
  }
  function avanza(ms) {
    const fine = t + ms;
    for (;;) {
      const pronti = eventi.filter((e) => e.a <= fine);
      if (!pronti.length) break;
      const e = pronti.reduce((m, x) => (x.a < m.a ? x : m));
      eventi = eventi.filter((x) => x !== e);
      t = e.a;
      e.fn();
    }
    t = fine;
  }
  function contesto(cambia) {
    cambia();
    s.banner = false; s.bannerInSospeso = false;
    if (!s.deep) return;
    if (partenzaPeriodoMs > 0) tra(partenzaPeriodoMs, parti);
    else parti();
  }

  return {
    stato: s,
    now: () => t,
    sleep: async (ms) => { avanza(ms); },
    /** Le metriche del report che il pannello mostra ADESSO. */
    metricheMostrate: () => metriche(s.mostrato.periodo, s.mostrato.inputs, s.mostrato.timeframe),
    metricheDi: (p, i, tf = s.timeframe) => metriche(p, i, String(tf)),
    setPeriodo(p) { contesto(() => { s.periodo = { ...p }; s.deep = true; }); },
    setTimeframe(tf) { contesto(() => { s.timeframe = String(tf); }); },
    setInputs(nuovi) {
      const cambiati = Object.keys(nuovi).filter((k) => s.inputs[k] !== nuovi[k]);
      s.inputs = { ...s.inputs, ...nuovi };
      s.ultimoSetInputs = t;
      // Un input che TradingView non considera rilevante per il report non accende il banner.
      if (!cambiati.some((k) => !bannerMaiPerInput.includes(k))) return;
      if (s.inVolo) s.bannerInSospeso = true;
      else s.banner = true;
    },
    cliccaAggiorna() {
      if (!s.banner) return { obsoleto: false, cliccato: false };
      s.banner = false;
      s.click += 1;
      tra(partenzaMs, parti);
      return { obsoleto: true, cliccato: true };
    },
    reportObsoleto: () => s.banner,
    /** Il ricalcolo sul GRAFICO (non il report esteso): isLoading resta true fra 0,7 e 2,4 s dal set. */
    strategiaInCaricamento: () => t - s.ultimoSetInputs >= 700 && t - s.ultimoSetInputs < 2400,
    readDeepState: () => ({
      found: true, deep: s.deep, status: s.status,
      error: s.status === 3 ? s.errore : null, requestId: s.requestId, connected: !!s.inVolo,
    }),
    /** Da ora TradingView rifiuta ogni richiesta estesa con questo errore, finche' non si riavvia. */
    rifiuta(errore = 'not_allowed') { s.rifiuto = errore; },
    riavvia() { s.rifiuto = null; },
  };
}
