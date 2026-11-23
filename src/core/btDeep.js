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
 *     _requestId                         contatore, +1 a ogni richiesta (non riparte da zero quando
 *                                        cambia il timeframe e il pannello viene riaperto)
 *     _statusDeepBacktesting.value()     { type: 1 in calcolo | 2 pronto | 3 errore, errorDescription }
 *
 * Sequenze misurate:
 *  - click su "Aggiorna report": banner sparito a 0,0 s; `type` 1 a +0,2 s; `_requestId` +1 a +0,4 s;
 *    `type` 2 e numeri nuovi nello stesso istante, a +2,6 s (1 anno) o +4,9..6,6 s (4 anni);
 *  - cambio di periodo o di timeframe: la richiesta parte da sola, senza banner;
 *  - cambio di input a tester fermo: banner subito, nessuna richiesta finche' non si preme.
 *
 * Il modello si raggiunge dalla fiber React del contenitore del pannello: e' un dettaglio interno di
 * TradingView e puo' cambiare. Per questo ogni funzione qui dichiara quando NON riesce a leggerlo o a
 * interpretarlo (`found: false` / `disponibile: false`) e il chiamante torna alle attese di prima.
 */
import { evaluate as realEvaluate } from '../connection.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1 in calcolo, 2 pronto, 3 errore; null = nessuna richiesta estesa ancora fatta. Un numero diverso
// vuol dire che TradingView ha cambiato il modello: non si interpreta, si torna alle attese di prima.
const STATI_NOTI = [null, 1, 2, 3];

/**
 * @returns {Promise<{found: boolean, motivo?: string, deep?: boolean, status?: number|null,
 *   error?: string|null, requestId?: number, connected?: boolean}>}
 *   `status` e' null quando il tester non ha ancora fatto richieste estese.
 *   `found: false` ogni volta che un pezzo del modello manca: uno stato letto a meta' e' peggio di
 *   uno stato non letto, perche' farebbe dichiarare attuale un report che non lo e'.
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
          if (typeof m._isDeepBacktesting !== 'boolean') return { found: false, motivo: '_isDeepBacktesting non booleano' };
          if (!g._statusDeepBacktesting || typeof g._statusDeepBacktesting.value !== 'function') {
            return { found: false, motivo: '_statusDeepBacktesting assente' };
          }
          if (typeof g._requestId !== 'number' || !isFinite(g._requestId)) return { found: false, motivo: '_requestId non numerico' };
          var sd = g._statusDeepBacktesting.value();
          var tipo = (sd && typeof sd.type === 'number') ? sd.type : null;
          if (sd && tipo === null) return { found: false, motivo: 'stato del backtest esteso senza type numerico' };
          return {
            found: true,
            deep: m._isDeepBacktesting,
            status: tipo,
            error: sd && sd.errorDescription ? String(sd.errorDescription.error || '') : null,
            requestId: g._requestId,
            connected: g._isConnected === true,
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
  // Gli stessi controlli della pagina, ripetuti qui: e' il confine su cui poggia tutto.
  if (typeof out.requestId !== 'number' || !Number.isFinite(out.requestId)) return { found: false, motivo: 'requestId non numerico' };
  if (typeof out.deep !== 'boolean') return { found: false, motivo: 'deep non booleano' };
  if (!STATI_NOTI.includes(out.status)) return { found: false, motivo: `stato del backtest esteso sconosciuto: ${out.status}` };
  return out;
}

/**
 * Porta il tester nello stato «il report che si vede e' quello degli input e del periodo correnti»,
 * e — quando chi chiama sa che un ricalcolo DEVE avvenire — lo dimostra con una prova positiva.
 *
 * ⛔ IL SILENZIO NON E' UNA PROVA ⛔
 * «Nessuna richiesta in volo e nessun banner» e' vero anche un istante prima che il banner compaia
 * o che la richiesta parta. Per questo chi ha appena cambiato qualcosa passa `richiestaDopo`: il
 * `requestId` letto PRIMA del cambio. Il report e' dichiarato attuale solo quando una richiesta PIU'
 * RECENTE di quella e' atterrata (`attuale: 'provato'`). Dopo un click il riferimento diventa il
 * `requestId` al momento del click: conta solo la richiesta partita da li'.
 *
 * @param {object} o
 * @param {number|null} [o.richiestaDopo] requestId letto prima dell'azione (cambio di contesto o di
 *        input) che deve far ricalcolare. null = niente e' cambiato, non ci si aspetta una richiesta.
 * @returns {Promise<object>} una di queste forme:
 *   - `{disponibile: false, motivo?}`  il modello non e' leggibile o interpretabile: il chiamante usa
 *                                      le attese di prima;
 *   - `{disponibile: true, deep: false, ok: true}`  il tester non e' in modalita' esteso: TradingView
 *                                      ricalcola da solo;
 *   - `{disponibile: true, deep: true, ok: true, attuale, click, richieste, requestId, durataMs}` con
 *       `attuale: 'provato'`          una richiesta piu' recente del riferimento e' atterrata;
 *       `attuale: 'quieto'`           niente era atteso e il tester e' fermo, senza banner;
 *       `attuale: 'senza_richiesta'`  un ricalcolo era atteso ma TradingView non l'ha chiesto ne'
 *                                     fatto: NON e' una prova, il chiamante tiene le sue reti;
 *   - `{disponibile: true, deep: true, ok: false, motivo, errore?}` con `motivo` =
 *       'errore_tradingview' (con `errore`, es. "not_allowed") | 'timeout' |
 *       'richiesta_non_partita' | 'banner_persistente'.
 */
export async function sincronizzaReport({
  readDeepState: leggi, reportObsoleto, cliccaAggiorna,
  sleep = realSleep, now = () => performance.now(),
  richiestaDopo = null,
  timeoutMs = 60000, passoMs = 150, confermaMs = 600, confermaDopoVoloMs = 1500,
  attesaSenzaRichiestaMs = 8000, attesaPartenzaMs = 3000, attesaClickMs = 5000, maxClick = 3,
} = {}) {
  const t0 = now();
  const valido = (s) => !!s && s.found === true && typeof s.requestId === 'number' && STATI_NOTI.includes(s.status);
  const illeggibile = (s) => ({ disponibile: false, ...(s?.motivo && { motivo: s.motivo }) });

  const primo = await leggi();
  if (!valido(primo)) return illeggibile(primo);
  if (!primo.deep) return { disponibile: true, deep: false, ok: true, click: 0, richieste: 0 };

  const reqIniziale = primo.requestId;
  // Il requestId che la richiesta buona deve SUPERARE. null = nessuna richiesta attesa.
  let daSuperare = (typeof richiestaDopo === 'number' && Number.isFinite(richiestaDopo)) ? richiestaDopo : null;
  let click = 0;
  let fermoDa = null;
  let voloVisto = false;
  let bannerSenzaClickDa = null;
  const nuova = (s) => daSuperare !== null && s.requestId > daSuperare;
  const esito = (s, extra) => ({
    disponibile: true, deep: true, click,
    richieste: Math.max(0, s.requestId - reqIniziale), requestId: s.requestId,
    durataMs: Math.round(now() - t0),
    ...extra,
  });
  const errore = (s) => esito(s, { ok: false, motivo: 'errore_tradingview', errore: s.error || 'errore sconosciuto' });

  for (;;) {
    const s = await leggi();
    if (!valido(s)) return illeggibile(s);
    if (!s.deep) return { disponibile: true, deep: false, ok: true, click, richieste: 0 };

    if (s.status === 1) {
      // Richiesta in volo: qualunque cosa mostri il pannello adesso, e' il report di prima.
      fermoDa = null;
      voloVisto = true;
    } else if (s.status === 3 && nuova(s)) {
      // La richiesta che aspettavamo e' stata rifiutata. Un banner eventualmente rimasto non cambia
      // la diagnosi: ripremerlo otterrebbe solo un altro rifiuto.
      return errore(s);
    } else if (await reportObsoleto()) {
      fermoDa = null;
      if (click >= maxClick) return esito(s, { ok: false, motivo: 'banner_persistente' });
      const c = await cliccaAggiorna();
      if (c && c.cliccato) {
        click += 1;
        bannerSenzaClickDa = null;
        // Da qui conta solo la richiesta partita da QUESTO click.
        daSuperare = daSuperare === null ? s.requestId : Math.max(daSuperare, s.requestId);
        // ⛔ LA FINESTRA CHE INGANNAVA IL GRIND ⛔ Dopo il click il banner sparisce subito ma la
        // richiesta parte 0,2-0,4 s dopo: nel mezzo il tester sembra fermo e attuale. Si aspetta di
        // vederla partire; se non parte, sotto non risultera' mai «nuova» e non verra' creduta.
        const scadenza = now() + attesaPartenzaMs;
        for (;;) {
          const d = await leggi();
          if (!valido(d)) return illeggibile(d);
          if (d.status === 1 || d.requestId > s.requestId) break;
          if (now() >= scadenza) break;
          await sleep(passoMs);
        }
        continue;
      }
      // Il banner risulta presente ma non c'e' un pulsante da premere (pannello minimizzato, testo
      // rimasto in un nodo nascosto): qui non si puo' concludere niente. Si restituisce il controllo
      // alle attese di prima invece di fermare una run sana.
      if (bannerSenzaClickDa === null) bannerSenzaClickDa = now();
      else if (now() - bannerSenzaClickDa >= attesaClickMs) return { disponibile: false, motivo: 'banner presente ma non premibile' };
    } else {
      bannerSenzaClickDa = null;
      if (fermoDa === null) fermoDa = now();
      const fermo = now() - fermoDa;

      if (daSuperare === null) {
        // Niente doveva ricalcolare: basta che il tester sia fermo, senza banner.
        if (s.status === 3) return errore(s);
        // Nessuna richiesta estesa mai fatta: non c'e' un report esteso di cui garantire.
        if (s.status === null) return { disponibile: false, motivo: 'nessuna richiesta estesa ancora fatta' };
        // Se si e' appena vista atterrare una richiesta non nostra, un banner in sospeso puo'
        // comparire con un attimo di ritardo: si aspetta di piu'.
        if (fermo >= (voloVisto ? confermaDopoVoloMs : confermaMs)) return esito(s, { ok: true, attuale: 'quieto' });
      } else if (nuova(s) && s.status === 2) {
        // LA PROVA: una richiesta piu' recente del riferimento e' atterrata. La conferma breve copre
        // solo il ridisegno del pannello.
        if (fermo >= confermaMs) return esito(s, { ok: true, attuale: 'provato' });
      } else if (fermo >= attesaSenzaRichiestaMs) {
        // Era attesa una richiesta e non e' partita, ne' TradingView ha mostrato il banner.
        if (s.status === 3) return errore(s);
        if (click > 0) return esito(s, { ok: false, motivo: 'richiesta_non_partita' });
        return esito(s, { ok: true, attuale: 'senza_richiesta' });
      }
    }

    if (now() - t0 >= timeoutMs) return esito(s, { ok: false, motivo: 'timeout' });
    await sleep(passoMs);
  }
}
