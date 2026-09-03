/**
 * Config + client HTTP per l'API Pine Algos, usato dal grind dei backtest.
 * Base/token si risolvono come nel runner: prima le env, poi ~/.pinealgos/config.json
 * (scritto dall'installer). Il processo MCP non eredita sempre le env User di Windows,
 * quindi il file è la sorgente che funziona in ogni caso.
 */
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export function readFileConfig(p = join(homedir(), '.pinealgos', 'config.json')) {
  try {
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function resolveConfig({ env = process.env, fileConfig = readFileConfig() } = {}) {
  const base = String(env.PINEALGOS_BASE || fileConfig.base || '').replace(/\/+$/, '');
  const token = String(env.PINEALGOS_TOKEN || fileConfig.token || '');
  if (!base || !token) {
    throw new Error('PINEALGOS_BASE/PINEALGOS_TOKEN mancanti (né env né ~/.pinealgos/config.json)');
  }
  return { base, token };
}

/**
 * Quanto aspettare prima di ritentare una richiesta respinta col 429.
 *
 * Si preferisce SEMPRE il `Retry-After` del server: e' l'unico che sa quando la finestra si
 * riapre davvero. Il backoff esponenziale e' solo la rete di sicurezza per quando non c'e'.
 * Cap a 75 s perche' la finestra di Laravel e' al minuto: oltre, si sta aspettando per niente.
 */
export function attesaDopo429(res, tentativo) {
  const raw = res?.headers?.get?.('retry-after');
  const secondi = Number(raw);
  if (Number.isFinite(secondi) && secondi > 0) return Math.min(secondi, 75) * 1000;
  return Math.min(1000 * 2 ** tentativo, 30000);
}

export function makeApi({
  base, token, fetchImpl = globalThis.fetch, timeoutMs = 30000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries429 = 4,
} = {}) {
  const headers = (extra = {}) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra });

  async function req(method, path, { body, raw } = {}) {
    for (let tentativo = 0; ; tentativo++) {
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method,
          headers: raw ? headers() : headers(body ? { 'Content-Type': 'application/json' } : {}),
          body: raw ? raw : body ? JSON.stringify(body) : undefined,
          // Il grind gira dentro un processo MCP di lunga durata su decine di run: senza timeout,
          // un server bloccato o una rete impallata appende la chiamata per sempre e ferma tutto.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // fetch stessa può rigettare (DNS, ECONNREFUSED, abort per timeout) senza passare dal ramo
        // !res.ok: senza questo try/catch il messaggio arriva come "TypeError: fetch failed" nudo,
        // impossibile da diagnosticare quando il grind fa decine di chiamate simili.
        throw new Error(`${method} ${path} → ${err.message}`);
      }

      // ⛔ 429 = RESPINTA, non fallita. Ritentare e' sicuro su OGNI verbo, `finalize` compreso:
      // il throttle rifiuta la richiesta PRIMA che il server la esegua, quindi non c'e' niente da
      // duplicare. E' la differenza con un 422, che invece e' stato eseguito e respinto nel merito:
      // quello non si ritenta mai, si ripeterebbe solo lo stesso errore rallentando la diagnosi.
      //
      // Perche' serve: Pine Algos throttla /api/v1 a 60 req/min per UTENTE, e il grind ne fa 5 per
      // run — a ~7,7 s per run sono ~39 req/min, piu' ~9 del runner (heartbeat + long-poll) sullo
      // stesso utente. Il 2026-08-12 il tetto e' stato superato: il grind e' morto a meta' run e la
      // sessione 52 si e' fermata a 11 run su 34, con l'operatore che ha scambiato quel 429 per un
      // rate limit di Anthropic.
      //
      // NB sul body `raw`: e' una FormData, cioe' un oggetto strutturato che fetch riserializza a
      // ogni tentativo — non uno stream gia' consumato. Ritentarla e' sicuro.
      if (res.status === 429 && tentativo < maxRetries429) {
        await sleep(attesaDopo429(res, tentativo));
        continue;
      }

      if (!res.ok) {
        const text = typeof res.text === 'function' ? await res.text() : '';
        throw new Error(`${method} ${path} → HTTP ${res.status}: ${text}`);
      }
      return await leggiCorpo(res);
    }
  }

  async function leggiCorpo(res) {
    if (typeof res.json !== 'function') return null;
    try {
      return await res.json();
    } catch {
      // Risposta ok ma corpo vuoto/non-JSON (204, pagina HTML da un proxy, body troncato): non è
      // un errore della chiamata, quindi degradiamo a null invece di far esplodere "Unexpected
      // end of JSON input" — i chiamanti (es. nextRun con `out?.data ?? null`) lo gestiscono già.
      return null;
    }
  }

  return {
    async nextRun(sessionId) {
      const out = await req('GET', `/api/v1/backtest-sessions/${sessionId}/runs?next=1`);
      return out?.data ?? null;
    },
    /**
     * Una run per id. Serve alle varianti di costo: `nextRun` (?next=1) le filtra apposta,
     * quindi si leggono per id dal payload del comando `simulate_commission`.
     */
    async getRun(runId) {
      const out = await req('GET', `/api/v1/backtest-runs/${runId}`);
      return out?.data ?? null;
    },
    /** Un backtest per id: il padre di una variante (identita' + metriche di controllo), o il backtest da replicare (bt_apply). */
    async getBacktest(backtestId) {
      const out = await req('GET', `/api/v1/backtests/${backtestId}`);
      return out?.data ?? null;
    },
    markRunning(runId) {
      return req('PATCH', `/api/v1/backtest-runs/${runId}`, { body: { status: 'running', increment_attempts: true } });
    },
    markFailed(runId, error) {
      return req('PATCH', `/api/v1/backtest-runs/${runId}`, { body: { status: 'failed', error: String(error).slice(0, 2000) } });
    },
    /** Le run in un dato stato. Serve al recupero delle `running` orfane e al conteggio finale. */
    async listRuns(sessionId, status = null) {
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      const out = await req('GET', `/api/v1/backtest-sessions/${sessionId}/runs${q}`);
      const data = out?.data;
      return Array.isArray(data) ? data : [];
    },
    /**
     * Rimette `pending` una run rimasta appesa in `running`.
     *
     * Serve perche' `nextRun` serve SOLO le pending: una run marcata `running` da un grind poi
     * morto e' persa per sempre, e la matrice non puo' piu' completarsi. Successo il 2026-08-11
     * sulla run 1140: bt_grind e' uscito per un'eccezione dopo `markRunning`, e le 10 run M15 non
     * sono mai state eseguite mentre la sessione risultava chiusa.
     */
    reclaimRun(runId) {
      return req('PATCH', `/api/v1/backtest-runs/${runId}`, {
        body: { status: 'pending', error: 'ripresa: era rimasta running da un grind interrotto' },
      });
    },
    /**
     * Lo stato compatto della sessione: cosa e' gia' stato provato, cosa e' rimasto fermo, qual e'
     * il migliore per gruppo e come ci si e' arrivati.
     *
     * Si allega al ritorno di OGNI grind, invece di lasciare all'operatore il compito di chiederlo.
     * Il passo "rileggi lo stato dal DB prima di ogni mossa" era un'istruzione scritta nello skill,
     * e il difetto C1 l'ha aggirata: sessione chiusa con 10 run su 20 fidandosi di `executed`.
     * Un passo che il modello deve ricordarsi di fare, prima o poi non lo fa.
     *
     * `?compact=1` perche' qui si paga a ogni chiamata: niente `fixed_inputs` (costante dentro la
     * sessione) e solo le ultime mosse. Misurato in produzione sulla sessione 37 (20 backtest):
     * GET completo 68.593 byte, digest pieno 7.438, compatto 3.628.
     */
    async sessionDigest(sessionId) {
      return req('GET', `/api/v1/backtest-sessions/${sessionId}/digest?compact=1`);
    },
    async stageEquity(runId, filePath) {
      const form = new FormData();
      const buf = readFileSync(filePath);
      form.append('equity', new Blob([buf], { type: 'image/png' }), basename(filePath));
      return req('POST', `/api/v1/backtest-runs/${runId}/equity-screenshot`, { raw: form });
    },
    finalize(runId, payload) {
      return req('POST', `/api/v1/backtest-runs/${runId}/finalize`, { body: payload });
    },
    progress(commandId, message) {
      if (!commandId) return Promise.resolve(null);
      return req('POST', `/api/v1/operator/commands/${commandId}/progress`, { body: { message } })
        .catch(() => null); // un progress perso non deve fermare il grind
    },
  };
}
