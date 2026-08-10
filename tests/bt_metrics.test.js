import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFinalizePayload, fingerprint, detectAnomaly } from '../src/core/btMetrics.js';

const TV = {
  net_profit: 1234.5, net_profit_percent: 12.345,
  max_drawdown: 300, max_drawdown_percent: 6.1,
  profit_factor: 1.8, total_trades: 42,
  percent_profitable: 55.5, sharpe_ratio: 1.2, sortino_ratio: 2.1,
  gross_profit: 5000, gross_loss: 3765.5, commission_paid: 88,
};

test('toFinalizePayload converte le percentuali TV in ratio 0-1', () => {
  const p = toFinalizePayload(TV, {});
  assert.equal(p.net_profit_pct, 0.12345);
  assert.equal(p.max_drawdown_pct, 0.061);
  assert.equal(p.win_rate, 0.555);
});

test('toFinalizePayload tiene i valori assoluti come sono', () => {
  const p = toFinalizePayload(TV, {});
  assert.equal(p.net_profit, 1234.5);
  assert.equal(p.max_drawdown, 300);
  assert.equal(p.profit_factor, 1.8);
  assert.equal(p.total_trades, 42);
  assert.equal(p.sharpe, 1.2);
  assert.equal(p.sortino, 2.1);
});

test('toFinalizePayload mette le metriche non-core in extra_metrics', () => {
  const p = toFinalizePayload(TV, { properties: { 'Margin Long': 100 } });
  assert.equal(p.extra_metrics.gross_profit, 5000);
  assert.equal(p.extra_metrics.commission_paid, 88);
  assert.equal(p.extra_metrics.properties['Margin Long'], 100);
  assert.equal(p.extra_metrics.net_profit, undefined); // i core non si duplicano
});

test('toFinalizePayload normalizza total_trades a intero', () => {
  const p = toFinalizePayload({ ...TV, total_trades: 42.0 }, {});
  assert.equal(Number.isInteger(p.total_trades), true);
});

test('fingerprint è stabile e distingue metriche diverse', () => {
  assert.equal(fingerprint(TV), fingerprint({ ...TV }));
  assert.notEqual(fingerprint(TV), fingerprint({ ...TV, net_profit: 1234.6 }));
});

test('detectAnomaly segnala gli id non applicati', () => {
  const a = detectAnomaly({ setResult: { missing: ['in_9'] }, results: { success: true, metrics: TV }, readbackOk: true });
  assert.equal(a?.kind, 'inputs_not_applied');
  assert.match(a.detail, /in_9/);
});

test('detectAnomaly segnala l errore di runtime dal report', () => {
  const a = detectAnomaly({ setResult: { missing: [] }, results: { success: false, error: "Can't parse pine" }, readbackOk: true });
  assert.equal(a?.kind, 'runtime_error');
});

test('detectAnomaly segnala 0 trade', () => {
  const a = detectAnomaly({ setResult: { missing: [] }, results: { success: true, metrics: { ...TV, total_trades: 0 } }, readbackOk: true });
  assert.equal(a?.kind, 'zero_trades');
});

test('detectAnomaly NON segnala metriche identiche se il readback conferma il set', () => {
  const a = detectAnomaly({
    setResult: { missing: [] }, results: { success: true, metrics: TV },
    readbackOk: true, sameAsPrevious: true,
  });
  assert.equal(a, null);
});

test('detectAnomaly segnala il no-op silenzioso: metriche identiche E readback fallito', () => {
  const a = detectAnomaly({
    setResult: { missing: [] }, results: { success: true, metrics: TV },
    readbackOk: false, sameAsPrevious: true,
  });
  assert.equal(a?.kind, 'silent_noop');
});
