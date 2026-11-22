// Cronometro a giri: scompone il tempo di una prova di bt_grind in fasi con nome fisso.
// Ogni fase e' il tempo dal segno precedente al proprio, sommato se la fase ricorre.

export const FASI = [
  'coda', 'pre_contesto', 'contesto', 'baseline', 'input', 'report', 'ricalcolo',
  'rilettura', 'verifica', 'periodo', 'screenshot', 'salvataggio', 'altro',
];

// Cio' che lo strumento di fase non fara' (design §6.2). Nucleo = totale - salvataggio.
export const FASI_SALVATAGGIO = ['coda', 'screenshot', 'salvataggio'];

const azzera = () => Object.fromEntries(FASI.map((f) => [f, 0]));

export function creaCronometro(now = () => performance.now()) {
  const chiusi = [];
  let aperto = null; // { run_id, fasi, ultimo }

  function chiudi() {
    if (!aperto) return null;
    const ora = now();
    aperto.fasi.altro += ora - aperto.ultimo;
    // Arrotonda ogni fase, poi il totale e' la somma delle arrotondate: il controllo e' esatto.
    const fasi = {};
    let totale_ms = 0;
    for (const f of FASI) {
      fasi[f] = Math.round(aperto.fasi[f]);
      totale_ms += fasi[f];
    }
    const record = { run_id: aperto.run_id, totale_ms, fasi };
    chiusi.push(record);
    aperto = null;
    return record;
  }

  return {
    apri() {
      chiudi();
      aperto = { run_id: null, fasi: azzera(), ultimo: now() };
    },
    assegna(runId) {
      if (aperto) aperto.run_id = runId;
    },
    segna(fase) {
      if (!FASI.includes(fase)) throw new Error(`Fase sconosciuta: ${fase}`);
      if (!aperto) return;
      const ora = now();
      aperto.fasi[fase] += ora - aperto.ultimo;
      aperto.ultimo = ora;
    },
    chiudi,
    scarta() {
      aperto = null;
    },
    records() {
      return chiusi.slice();
    },
  };
}

function mediana(valori) {
  const v = [...valori].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

const salvataggioDi = (r) => FASI_SALVATAGGIO.reduce((s, f) => s + r.fasi[f], 0);

export function riassumi(records, rows) {
  const stato = new Map();
  for (const riga of rows) stato.set(riga.run_id, riga.status); // l'ultima riga vince
  const run = records.map((r) => ({ ...r, esito: stato.get(r.run_id) ?? 'failed' }));
  const done = run.filter((r) => r.esito === 'done');
  if (!done.length) return { run, mediane_done: null, max_done: null };

  const nucleo = (r) => r.totale_ms - salvataggioDi(r);
  const fasi = {};
  for (const f of FASI) fasi[f] = mediana(done.map((r) => r.fasi[f]));
  return {
    run,
    mediane_done: {
      totale: mediana(done.map((r) => r.totale_ms)),
      nucleo: mediana(done.map(nucleo)),
      salvataggio: mediana(done.map(salvataggioDi)),
      fasi,
    },
    max_done: {
      totale: Math.max(...done.map((r) => r.totale_ms)),
      nucleo: Math.max(...done.map(nucleo)),
    },
  };
}
