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
