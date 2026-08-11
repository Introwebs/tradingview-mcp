import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFinalizePayload, fingerprint, detectAnomaly } from '../src/core/btMetrics.js';

// Valori REALI letti da TradingView il 2026-08-10 (Imbalance Strategy, TVC:NDQ 5m, un anno di
// storico). Sono presi dal vivo apposta: la versione precedente di questa fixture usava numeri
// inventati nella scala sbagliata (12.345 per il 12,345%) e i test passavano confermando una
// conversione /100 che sui dati veri sbagliava di 100×. Se cambi questi numeri, prendili da un
// reportData() reale, non a mente.
const TV = {
  net_profit: 14184.535, net_profit_percent: 0.14184535,
  max_drawdown: 8065.926, max_drawdown_percent: 0.0668039791187022,
  profit_factor: 1.1563842825920596, total_trades: 288,
  percent_profitable: 0.41156462585034015, sharpe_ratio: 1.2, sortino_ratio: 2.1,
  gross_profit: 5000, gross_loss: 3765.5, commission_paid: 88,
};

test('le percentuali TV passano invariate: sono GIA ratio 0-1, non vanno divise per 100', () => {
  const p = toFinalizePayload(TV, {});
  assert.equal(p.net_profit_pct, 0.14184535);          // 14,18%
  assert.equal(p.max_drawdown_pct, 0.0668039791187022); // 6,68%
  assert.equal(p.win_rate, 0.41156462585034015);        // 41,16%
});

test('win_rate resta nel range 0-1 che il server valida', () => {
  const p = toFinalizePayload(TV, {});
  assert.ok(p.win_rate >= 0 && p.win_rate <= 1, `win_rate fuori range: ${p.win_rate}`);
  assert.ok(p.max_drawdown_pct >= 0 && p.max_drawdown_pct <= 1);
});

test('toFinalizePayload tiene i valori assoluti come sono', () => {
  const p = toFinalizePayload(TV, {});
  assert.equal(p.net_profit, 14184.535);
  assert.equal(p.max_drawdown, 8065.926);
  assert.equal(p.profit_factor, 1.1563842825920596);
  assert.equal(p.total_trades, 288);
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

test('toFinalizePayload limita profit_factor Infinity a 100 quando ci sono trade e segnala il flag', () => {
  const p = toFinalizePayload({ ...TV, profit_factor: Infinity, total_trades: 42 }, {});
  assert.equal(p.profit_factor, 100);
  assert.equal(p.extra_metrics.profit_factor_capped, true);
});

test('toFinalizePayload limita profit_factor undefined a 100 quando ci sono trade (stessa semantica di Infinity)', () => {
  const p = toFinalizePayload({ ...TV, profit_factor: undefined, total_trades: 42 }, {});
  assert.equal(p.profit_factor, 100);
  assert.equal(p.extra_metrics.profit_factor_capped, true);
});

test('toFinalizePayload NON limita profit_factor Infinity se non ci sono trade: 0 resta corretto', () => {
  const p = toFinalizePayload({ ...TV, profit_factor: Infinity, total_trades: 0 }, {});
  assert.equal(p.profit_factor, 0);
  assert.equal(p.extra_metrics.profit_factor_capped, undefined);
});

test('toFinalizePayload NON tocca un profit_factor normale', () => {
  const p = toFinalizePayload({ ...TV, profit_factor: 1.8, total_trades: 42 }, {});
  assert.equal(p.profit_factor, 1.8);
  assert.equal(p.extra_metrics.profit_factor_capped, undefined);
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
