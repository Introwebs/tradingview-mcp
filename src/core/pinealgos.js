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
    const raw = readFileSync(p, 'utf8').replace(/^﻿/, '');
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

export function makeApi({ base, token, fetchImpl = globalThis.fetch } = {}) {
  const headers = (extra = {}) => ({ Authorization: `Bearer ${token}`, Accept: 'application/json', ...extra });

  async function req(method, path, { body, raw } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: raw ? headers() : headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: raw ? raw : body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = typeof res.text === 'function' ? await res.text() : '';
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${text}`);
    }
    return typeof res.json === 'function' ? res.json() : null;
  }

  return {
    async nextRun(sessionId) {
      const out = await req('GET', `/api/v1/backtest-sessions/${sessionId}/runs?next=1`);
      return out?.data ?? null;
    },
    markRunning(runId) {
      return req('PATCH', `/api/v1/backtest-runs/${runId}`, { body: { status: 'running', increment_attempts: true } });
    },
    markFailed(runId, error) {
      return req('PATCH', `/api/v1/backtest-runs/${runId}`, { body: { status: 'failed', error: String(error).slice(0, 2000) } });
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
