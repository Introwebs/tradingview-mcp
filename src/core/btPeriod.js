/**
 * Il controllo "Periodo di test" dello Strategy Tester (il Backtester esteso).
 *
 * PERCHE' ESISTE QUESTO FILE. La matrice di run di Pine Algos ha un asse "periodo", e fino al
 * 2026-08-11 bt_grind lo IGNORAVA: applicava solo gli input, leggeva quello che il tester aveva
 * davanti, e scriveva nel database il periodo *richiesto dalla run* come se l'avesse imposto.
 * Dieci run con dieci periodi diversi hanno prodotto dieci volte lo stesso identico backtest,
 * ognuno etichettato con un periodo che non gli apparteneva.
 *
 * TRE FATTI MISURATI DAL VIVO (2026-08-11), tutti controintuitivi:
 *
 *  1. Le voci del menu NON rispondono a `.click()` del DOM. L'etichetta del pulsante cambia --
 *     quindi sembra riuscito -- ma il ricalcolo non parte e le metriche restano quelle di prima.
 *     Servono eventi mouse VERI (CDP Input.dispatchMouseEvent), cioe' `mouseClick`. Aprire il menu
 *     invece funziona anche col click del DOM.
 *  2. I preset coprono solo 7/30/90/365 giorni, storico completo e intervallo grafico. Qualunque
 *     altro periodo passa da "Intervallo date personalizzato", che accetta due campi
 *     `input[placeholder="YYYY-MM-DD"]` in ISO -- nessuna data localizzata da comporre, per
 *     fortuna. Il pulsante di conferma e' `[data-name="submit-button"]`.
 *  3. L'etichetta del pulsante, invece, e' localizzata: "4 ago 2026 - 11 ago 2026". E' l'unica
 *     fonte del range REALMENTE applicato, quindi va parsata (mesi italiani) e registrata al posto
 *     di quello richiesto -- regola gia' scritta in api.md e che bt_grind violava.
 */
import { evaluate as realEvaluate } from '../connection.js';
import { mouseClick as realMouseClick } from './ui.js';

const MESI = { gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12 };

/** "4 ago 2026" -> "2026-08-04". null se non riconosciuto. */
export function parseDataItaliana(s) {
  const m = /(\d{1,2})\s+([a-z]{3})[a-z.]*\s+(\d{4})/i.exec(String(s || ''));
  if (!m) return null;
  const mese = MESI[m[2].toLowerCase()];
  if (!mese) return null;
  return `${m[3]}-${String(mese).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

/** "4 ago 2026 — 11 ago 2026Esteso" -> {from, to}. Regge sia l'em-dash sia il trattino. */
export function parseEtichettaPeriodo(label) {
  const testo = String(label || '').replace(/Esteso/gi, '').trim();
  const parti = testo.split(/[—–-]/).map((x) => x.trim()).filter(Boolean);
  if (parti.length < 2) return { from: null, to: null, label: testo };
  return { from: parseDataItaliana(parti[0]), to: parseDataItaliana(parti[parti.length - 1]), label: testo };
}

/** JS iniettato: trova il pulsante del periodo di test (quello col badge "Esteso"). */
const BTN_JS = `
  function _paPeriodBtn() {
    var bs = document.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].textContent || '').trim();
      if (/Esteso/i.test(t) && t.length < 80) return bs[i];
    }
    return null;
  }
`;

/** L'etichetta corrente del pulsante, cioe' il periodo realmente in vigore. */
export async function readTestPeriod({ evaluate = realEvaluate } = {}) {
  const label = await evaluate(`
    (function() {
      ${BTN_JS}
      var b = _paPeriodBtn();
      return b ? (b.textContent || '').trim() : null;
    })()
  `);
  if (!label) return { label: null, from: null, to: null };
  return parseEtichettaPeriodo(label);
}

/**
 * Apre il menu e misura la posizione delle voci. Le coordinate si misurano SEMPRE a runtime:
 * dipendono dal layout del pannello (massimizzato o no) e l'operatore, usando coordinate fisse
 * copiate da una sessione precedente, ha gia' cliccato la voce sbagliata.
 */
export async function openTestPeriodMenu({ evaluate = realEvaluate } = {}) {
  const out = await evaluate(`
    (function() {
      ${BTN_JS}
      var b = _paPeriodBtn();
      // Bottone assente = pannello chiuso/minimizzato, NON menu senza la voce giusta. Distinguerli
      // e' l'unica ragione per cui questa funzione non torna piu' un array secco: il 2026-08-11 il
      // grind si e' fermato due volte su "voce non trovata" mentre la voce c'era eccome, e il vero
      // problema era il pannello che ensureTesterPanel aveva appena richiuso da solo.
      if (!b) return { bottoneTrovato: false, voci: [] };
      b.click();
      var out = [];
      var all = document.querySelectorAll('div[class*="title-"]');
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].textContent || '').trim();
        if (!/^(Ultimi \\d+ giorni|Storico completo|Intervallo date personalizzato|Intervallo grafico.*)$/.test(t)) continue;
        var node = all[i];
        for (var up = 0; up < 4 && node; up++) {
          var rr = node.getBoundingClientRect();
          if (rr.width > 150) break;
          node = node.parentElement;
        }
        var r = (node || all[i]).getBoundingClientRect();
        out.push({ testo: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
      return { bottoneTrovato: true, voci: out };
    })()
  `);
  if (Array.isArray(out)) return { bottoneTrovato: true, voci: out }; // compat con stub vecchi
  return { bottoneTrovato: !!out?.bottoneTrovato, voci: Array.isArray(out?.voci) ? out.voci : [] };
}

/** Chiude il menu se e' rimasto aperto (Escape), per non lasciare overlay sul chart. */
export async function closeTestPeriodMenu({ evaluate = realEvaluate } = {}) {
  await evaluate(`
    (function() {
      try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
      return true;
    })()
  `);
}

/**
 * Imposta un periodo arbitrario via "Intervallo date personalizzato".
 *
 * @param {string} from  data ISO YYYY-MM-DD
 * @param {string} to    data ISO YYYY-MM-DD
 * @returns {Promise<{applied: boolean, label: string|null, from: string|null, to: string|null, error?: string}>}
 *          `from`/`to` di ritorno sono quelli che TradingView ha REALMENTE applicato, riletti
 *          dall'etichetta -- non quelli richiesti. Se non coincidono, e' il chiamante a decidere.
 */
export async function setCustomPeriod(from, to, {
  evaluate = realEvaluate, mouseClick = realMouseClick, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    return { applied: false, label: null, from: null, to: null, error: `date non ISO: ${from} / ${to}` };
  }

  const { bottoneTrovato, voci } = await openTestPeriodMenu({ evaluate });
  if (!bottoneTrovato) {
    return {
      applied: false, label: null, from: null, to: null, retryable: true,
      error: 'pulsante del periodo di test non presente: il pannello Strategy Tester e\' chiuso o minimizzato',
    };
  }
  const custom = voci.find((v) => /personalizzat/i.test(v.testo));
  if (!custom) {
    await closeTestPeriodMenu({ evaluate });
    const elenco = voci.length ? voci.map((v) => v.testo).join(' | ') : '(menu vuoto)';
    return {
      applied: false, label: null, from: null, to: null,
      error: `voce "Intervallo date personalizzato" non trovata nel menu del periodo di test. Voci lette: ${elenco}`,
    };
  }

  // Click VERO: col .click() del DOM il dialog non si apre.
  await mouseClick({ x: custom.x, y: custom.y });
  await sleep(600);

  const riempito = await evaluate(`
    (function() {
      var ins = document.querySelectorAll('input[placeholder="YYYY-MM-DD"]');
      if (ins.length < 2) return { ok: false, campi: ins.length };
      // I campi sono controllati da React: assegnare .value non fa scattare gli handler.
      // Va usato il setter nativo del prototype e poi emesso l'evento input.
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      function put(el, v) {
        el.focus();
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      put(ins[0], ${JSON.stringify(from)});
      put(ins[1], ${JSON.stringify(to)});
      var btn = document.querySelector('[data-name="submit-button"]');
      if (!btn) return { ok: false, campi: ins.length, submit: false };
      var r = btn.getBoundingClientRect();
      return { ok: true, valori: [ins[0].value, ins[1].value],
               submit: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: !!btn.disabled } };
    })()
  `);

  if (!riempito || !riempito.ok || !riempito.submit) {
    await closeTestPeriodMenu({ evaluate });
    return { applied: false, label: null, from: null, to: null, error: `dialog delle date non compilabile (campi: ${riempito?.campi ?? 0})` };
  }
  if (riempito.valori[0] !== from || riempito.valori[1] !== to) {
    await closeTestPeriodMenu({ evaluate });
    return { applied: false, label: null, from: null, to: null, error: `i campi data non hanno accettato i valori: ${riempito.valori.join(' / ')}` };
  }

  await mouseClick({ x: riempito.submit.x, y: riempito.submit.y });
  await sleep(800);

  const letto = await readTestPeriod({ evaluate });
  return {
    applied: letto.from === from && letto.to === to,
    label: letto.label, from: letto.from, to: letto.to,
  };
}
