/**
 * Lo stato della richiesta di backtest ESTESO, letto dal modello di TradingView invece che dedotto.
 *
 * ⛔ PERCHE' ESISTE — leggere prima di toccare le attese del grind ⛔
 *
 * Con un periodo di test personalizzato il tester e' in modalita' ESTESO: ogni report e' una richiesta
 * al server, che impiega secondi (2-3 s su un anno, 5-7 s su quattro anni di M5, misurato). Fino al
 * 2026-11-23 il grind decideva che il report era arrivato da due indizi, entrambi sbagliati:
 *
 *  1. «il banner "Il report e' obsoleto" non c'e'» — ma il banner sparisce NEL MOMENTO DEL CLICK su
 *     "Aggiorna report", non quando il risultato arriva. E se l'input cambia mentre un'altra richiesta
 *     e' in volo, il banner non compare affatto finche' quella non atterra.
 *  2. «i numeri sono cambiati rispetto a prima» — ma il primo numero nuovo che compare puo' essere il
 *     risultato di una richiesta PRECEDENTE (tipicamente quella partita col cambio di periodo).
 *
 * Risultato, sessione 36 (2026-11-23): dopo un cambio di periodo le prime due run hanno registrato i
 * numeri della configurazione precedente con gli input giusti accanto — backtest 263 (etichetta RR 1,
 * numeri di RR 2) e 264 (etichetta RR 1,5, numeri di RR 1). Verificato rieseguendo RR 1 a contesto
 * fermo, e riprodotto passo per passo campionando il tester ogni 200 ms.
 *
 * Il segnale vero sta nel modello del tester (`_deepBacktestingManager`):
 *
 *     _requestId                         contatore, +1 a ogni richiesta
 *     _statusDeepBacktesting.value()     { type: 1 in calcolo | 2 pronto | 3 errore, errorDescription }
 *
 * Sequenza misurata dopo un click: banner sparito a 0,0 s; `type` 1 a +0,2 s; `_requestId` +1 a
 * +0,4 s; `type` 2 e numeri nuovi nello stesso istante, a +2,6 s (1 anno) o +4,9..6,6 s (4 anni).
 *
 * Il modello si raggiunge dalla fiber React del contenitore del pannello: e' un dettaglio interno di
 * TradingView e puo' cambiare. Per questo ogni funzione qui dichiara quando NON riesce a leggerlo
 * (`found: false` / `disponibile: false`) e il chiamante torna al comportamento precedente.
 */
import { evaluate as realEvaluate } from '../connection.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{found: boolean, deep?: boolean, status?: number|null, error?: string|null,
 *   requestId?: number, connected?: boolean, from?: number|null, to?: number|null}>}
 *   `status` e' null quando il tester non e' in modalita' esteso o non ha ancora fatto richieste.
 */
export async function readDeepState({ evaluate = realEvaluate } = {}) {
  let out;
  try {
    out = await evaluate(`
      (function() {
        var pan = document.querySelector('[class*="backtesting"]');
        if (!pan) return { found: false, motivo: 'pannello del tester assente' };
        var m = null;
        var cands = [pan].concat([].slice.call(pan.querySelectorAll('div')).slice(0, 60));
        for (var c = 0; c < cands.length && !m; c++) {
          var key = Object.keys(cands[c]).find(function(k) { return k.indexOf('__reactFiber') === 0; });
          var f = key ? cands[c][key] : null;
          for (var lvl = 0; f && lvl < 90 && !m; lvl++, f = f.return) {
            var h = f.memoizedState;
            for (var hi = 0; h && hi < 40 && !m; hi++, h = h.next) {
              var st = h.memoizedState;
              if (st && typeof st === 'object' && st._deepBacktestingManager) m = st;
            }
          }
        }
        if (!m) return { found: false, motivo: 'modello del tester non trovato' };
        try {
          var g = m._deepBacktestingManager;
          var sd = g._statusDeepBacktesting && typeof g._statusDeepBacktesting.value === 'function' ? g._statusDeepBacktesting.value() : null;
          var num = function(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; };
          return {
            found: true,
            deep: m._isDeepBacktesting === true,
            status: sd ? num(sd.type) : null,
            error: sd && sd.errorDescription ? String(sd.errorDescription.error || '') : null,
            requestId: num(g._requestId) || 0,
            connected: g._isConnected === true,
            from: num(g._fromDate), to: num(g._toDate),
          };
        } catch (e) {
          return { found: false, motivo: 'modello illeggibile: ' + e.message };
        }
      })()
    `);
  } catch (e) {
    return { found: false, motivo: e.message };
  }
  if (!out || typeof out !== 'object' || out.found !== true) {
    return { found: false, ...(out && out.motivo && { motivo: out.motivo }) };
  }
  // Senza un requestId numerico non si puo' sapere se una richiesta e' partita: e' come non averlo letto.
  if (typeof out.requestId !== 'number') return { found: false, motivo: 'requestId non numerico' };
  return out;
}

/**
 * Porta il tester nello stato «il report che si vede e' quello degli input e del periodo correnti»,
 * e lo dimostra: nessuna richiesta in volo, nessun banner, e se un banner c'era la richiesta partita
 * dal click e' ATTERRATA.
 *
 * @param {object} o
 * @param {number} [o.graziaInizialeMs] dopo un cambio di input il banner compare entro ~0,2 s; per
 *        questo tempo l'assenza di banner non viene creduta, a meno che una richiesta sia gia' atterrata.
 * @returns {Promise<{disponibile: false} | {disponibile: true, deep: boolean, ok: boolean, click: number,
 *   richieste: number, durataMs?: number, motivo?: string, errore?: string}>}
 *   - `disponibile: false` il modello non e' leggibile: il chiamante usa le attese di prima;
 *   - `deep: false`       il tester non e' in modalita' esteso: TradingView ricalcola da solo;
 *   - `ok: false`         `motivo` = 'errore_tradingview' (con `errore`, es. "not_allowed") |
 *                         'timeout' | 'richiesta_non_partita' | 'banner_persistente'.
 */
export async function sincronizzaReport({
  readDeepState: leggi, reportObsoleto, cliccaAggiorna,
  sleep = realSleep, now = () => performance.now(),
  timeoutMs = 60000, passoMs = 150, confermaMs = 600, graziaInizialeMs = 0,
  attesaPartenzaMs = 3000, maxClick = 3,
} = {}) {
  const t0 = now();
  const primo = await leggi();
  if (!primo || primo.found !== true) return { disponibile: false };
  if (!primo.deep) return { disponibile: true, deep: false, ok: true, click: 0, richieste: 0 };

  const reqIniziale = primo.requestId;
  let click = 0;
  let fermoDa = null;
  const esito = (s, extra) => ({
    disponibile: true, deep: true, click,
    richieste: Math.max(0, (s?.requestId ?? reqIniziale) - reqIniziale),
    durataMs: Math.round(now() - t0),
    ...extra,
  });

  for (;;) {
    const s = await leggi();
    if (!s || s.found !== true) return { disponibile: false };

    if (s.status === 1) {
      // Richiesta in volo: qualunque cosa mostri il pannello adesso, e' il report di prima.
      fermoDa = null;
    } else if (await reportObsoleto()) {
      fermoDa = null;
      if (click >= maxClick) return esito(s, { ok: false, motivo: 'banner_persistente' });
      const c = await cliccaAggiorna();
      if (c && c.cliccato) {
        click += 1;
        // ⛔ LA FINESTRA CHE INGANNAVA IL GRIND ⛔ Dopo il click il banner sparisce subito ma la
        // richiesta parte 0,2-0,4 s dopo: nel mezzo il tester sembra fermo e attuale. Non si prosegue
        // finche' non si e' VISTA partire.
        const scadenza = now() + attesaPartenzaMs;
        for (;;) {
          const d = await leggi();
          if (!d || d.found !== true) return { disponibile: false };
          if (d.status === 1 || d.requestId > s.requestId) break;
          if (now() >= scadenza) break;
          await sleep(passoMs);
        }
        continue;
      }
    } else if (s.status === 3) {
      // Errore e nessun banner da premere: TradingView ha rifiutato e non c'e' un report da leggere.
      return esito(s, { ok: false, motivo: 'errore_tradingview', errore: s.error || 'errore sconosciuto' });
    } else {
      const richieste = s.requestId - reqIniziale;
      if (fermoDa === null) fermoDa = now();
      const graziaPassata = richieste > 0 || now() - t0 >= graziaInizialeMs;
      if (graziaPassata && now() - fermoDa >= confermaMs) {
        // Un click senza nessuna richiesta partita non ha aggiornato niente: non e' un report attuale.
        if (click > 0 && richieste === 0) return esito(s, { ok: false, motivo: 'richiesta_non_partita' });
        return esito(s, { ok: true });
      }
    }

    if (now() - t0 >= timeoutMs) return esito(s, { ok: false, motivo: 'timeout' });
    await sleep(passoMs);
  }
}
