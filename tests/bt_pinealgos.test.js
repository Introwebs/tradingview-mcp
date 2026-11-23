import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, makeApi } from '../src/core/pinealgos.js';

test('resolveConfig preferisce le env, poi il file config', () => {
  const c = resolveConfig({ env: { PINEALGOS_BASE: 'https://a.test/', PINEALGOS_TOKEN: 'T1' }, fileConfig: {} });
  assert.equal(c.base, 'https://a.test');   // slash finale rimosso
  assert.equal(c.token, 'T1');
});

test('resolveConfig cade sul file config quando le env mancano', () => {
  const c = resolveConfig({ env: {}, fileConfig: { base: 'https://b.test', token: 'T2' } });
  assert.equal(c.base, 'https://b.test');
  assert.equal(c.token, 'T2');
});

test('resolveConfig lancia un errore chiaro se manca tutto', () => {
  assert.throws(
    () => resolveConfig({ env: {}, fileConfig: {} }),
    /PINEALGOS_BASE\/PINEALGOS_TOKEN mancanti/
  );
});

test('nextRun ritorna null quando la matrice è finita', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET' });
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  };
  const api = makeApi({ base: 'https://a.test', token: 'T', fetchImpl: fakeFetch });
  assert.equal(await api.nextRun(42), null);
  assert.equal(calls[0].url, 'https://a.test/api/v1/backtest-sessions/42/runs?next=1');
});

test('finalize solleva un errore che include il corpo 422', async () => {
  const fakeFetch = async () => ({
    ok: false, status: 422,
    text: async () => '{"message":"Incomplete inputs: got 3, expected 12"}',
  });
  const api = makeApi({ base: 'https://a.test', token: 'T', fetchImpl: fakeFetch });
  await assert.rejects(() => api.finalize(7, {}), /422.*Incomplete inputs: got 3, expected 12/s);
});

// ── 429: respinta, non fallita ───────────────────────────────────────────────────────────────────
// Pine Algos throttla /api/v1 a 60 req/min per UTENTE. `bt_grind` fa 5 chiamate per run e a ~7,7 s
// per run sono ~39 req/min; il runner ne aggiunge ~9 (heartbeat + long-poll) sullo STESSO utente.
// Il 2026-08-12 il tetto e' stato superato: 429 "Too Many Attempts.", il client l'ha trattato come
// fatale, il grind e' morto a meta' run e la sessione 52 si e' fermata a 11 run su 34.
//
// Un 429 e' l'unico stato in cui ritentare e' sicuro anche su POST — finalize compreso — perche'
// dice "respinta PRIMA di essere eseguita": il server non l'ha mai vista.

test('un 429 viene ritentato invece di uccidere la chiamata', async () => {
  let n = 0;
  const attese = [];
  const fakeFetch = async () => {
    n += 1;
    if (n <= 2) return { ok: false, status: 429, headers: new Map([['retry-after', '2']]), text: async () => 'Too Many Attempts.' };
    return { ok: true, status: 200, json: async () => ({ data: { id: 9 } }) };
  };
  const api = makeApi({
    base: 'https://a.test', token: 'T', fetchImpl: fakeFetch,
    sleep: async (ms) => { attese.push(ms); },
  });

  const out = await api.finalize(7, { a: 1 });
  assert.equal(out.data.id, 9);
  assert.equal(n, 3, 'due 429 poi il successo');
  assert.deepEqual(attese, [2000, 2000], 'rispetta Retry-After invece di indovinare');
});

test('senza Retry-After il backoff cresce', async () => {
  let n = 0;
  const attese = [];
  const fakeFetch = async () => {
    n += 1;
    if (n <= 2) return { ok: false, status: 429, text: async () => 'Too Many Attempts.' };
    return { ok: true, status: 200, json: async () => ({ data: null }) };
  };
  const api = makeApi({ base: 'https://a.test', token: 'T', fetchImpl: fakeFetch, sleep: async (ms) => { attese.push(ms); } });

  await api.nextRun(1);
  assert.equal(attese.length, 2);
  assert.ok(attese[1] > attese[0], `backoff crescente, non fisso: ${attese}`);
});

test('un 429 che non passa mai finisce per fallire, dicendo che era un 429', async () => {
  // Ritentare all'infinito bloccherebbe il grind in silenzio: meglio fermarsi con un motivo vero.
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => 'Too Many Attempts.' });
  const api = makeApi({ base: 'https://a.test', token: 'T', fetchImpl: fakeFetch, sleep: async () => {} });

  await assert.rejects(() => api.nextRun(1), /429/);
});

test('un 422 NON viene ritentato: il server lo ha eseguito e rifiutato', async () => {
  // Differenza che conta: 429 = mai vista, 422 = vista e respinta nel merito. Ritentare un 422
  // significherebbe solo ripetere lo stesso errore N volte, rallentando la diagnosi.
  let n = 0;
  const fakeFetch = async () => { n += 1; return { ok: false, status: 422, text: async () => 'nope' }; };
  const api = makeApi({ base: 'https://a.test', token: 'T', fetchImpl: fakeFetch, sleep: async () => {} });

  await assert.rejects(() => api.finalize(7, {}), /422/);
  assert.equal(n, 1);
});

test('getRun legge una run per id e ritorna data', async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ data: { id: 1704, status: 'pending', cost_params: { commission_per_lot: 2 } } }) }; };
  const api = makeApi({ base: 'https://a.test', token: 'T', fetchImpl: fakeFetch });
  const run = await api.getRun(1704);
  assert.equal(run.id, 1704);
  assert.equal(calls[0], 'https://a.test/api/v1/backtest-runs/1704');
});

test('getBacktest legge un backtest per id e ritorna data', async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ data: { id: 1056, total_trades: 10, strategy_name: 'Index Grow Test Claude' } }) }; };
  const api = makeApi({ base: 'https://a.test', token: 'T', fetchImpl: fakeFetch });
  const bt = await api.getBacktest(1056);
  assert.equal(bt.strategy_name, 'Index Grow Test Claude');
  assert.equal(calls[0], 'https://a.test/api/v1/backtests/1056');
});

test('openPhase restituisce il rifiuto del server invece di lanciare', async () => {
  const api = makeApi({ base: 'http://x', token: 't', fetchImpl: async () => ({
    ok: false, status: 422, headers: new Map(),
    json: async () => ({ message: 'La prova no tocca il periodo riservato.', reason_code: 'outside_search_interval', data: { trial: 'no' } }),
    text: async () => '',
  }) });
  const out = await api.openPhase(3, { type: 'entry', trials: [] });
  assert.deepEqual([out.ok, out.status, out.reason_code, out.data.trial], [false, 422, 'outside_search_interval', 'no']);
});

test('sendTrials lancia su un 500 e ritenta su un 429', async () => {
  let n = 0;
  const api = makeApi({ base: 'http://x', token: 't', sleep: async () => {}, fetchImpl: async (url, init) => {
    n += 1;
    if (n === 1) return { ok: false, status: 429, headers: new Map([['retry-after', '1']]), text: async () => '' };
    assert.equal(url, 'http://x/api/v1/campaign-phases/9/trials');
    assert.equal(JSON.parse(init.body).rows.length, 1);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ data: { table: { phase: { position: 2 } } } }) };
  } });
  assert.equal((await api.sendTrials(9, { rows: [{ key: 't1' }] })).data.table.phase.position, 2);

  const giu = makeApi({ base: 'http://x', token: 't', fetchImpl: async () => ({ ok: false, status: 500, headers: new Map(), text: async () => 'boom' }) });
  await assert.rejects(() => giu.sendTrials(9, { rows: [] }), /HTTP 500/);
});

test('campaignState chiede anche la mappa', async () => {
  const api = makeApi({ base: 'http://x', token: 't', fetchImpl: async (url) => {
    assert.equal(url, 'http://x/api/v1/campaigns/3?with=map');
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ data: { id: 3, map: { inputs: [] } } }) };
  } });
  assert.equal((await api.campaignState(3)).id, 3);
});

test('un 4xx col corpo non JSON torna ok:false con un testo breve, senza lanciare', async () => {
  const api = makeApi({ base: 'http://x', token: 't', fetchImpl: async () => ({
    ok: false, status: 404, headers: new Map(),
    json: async () => { throw new Error('not json'); },
    text: async () => '<html>non trovato</html>',
  }) });
  const out = await api.openPhase(3, {});
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.reason_code, undefined);
  assert.equal(out.data, undefined);
  assert.match(out.message, /HTTP 404/);
});

test('getPhase legge il campo data', async () => {
  const api = makeApi({ base: 'http://x', token: 't', fetchImpl: async (url) => {
    assert.equal(url, 'http://x/api/v1/campaign-phases/7');
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ data: { id: 7 } }) };
  } });
  assert.equal((await api.getPhase(7)).id, 7);
});
