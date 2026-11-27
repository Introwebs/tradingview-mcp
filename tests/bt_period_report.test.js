import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rischioDalReportDelPeriodo, readPeriodReport } from '../src/core/btPanel.js';

// Il report React vero, letto dal vivo il 2026-11-03 (Imbalance Strategy, TVC:NDQ 30m), proiettato:
// date in ms UTC, P&L e trade come li porta `performance.all`.
const REPORT = {
  found: true, ambiguous: false,
  backtest_from: 1609770600000, // 2021-01-04 14:30 UTC, la prima barra
  backtest_to: 1793653200000, // 2026-11-02
  total_trades: 438, net_profit: -10219.735000000277, total_profit: -10219.735000000277,
  sharpe: -0.08610987689412221, sortino: -0.11744264718751704,
};
const PANNELLO = { total_trades: 438, net_profit: -10219.74 };
const PERIODO = { from: '2021-01-04', to: '2026-11-02', label: '4 gen 2021 — 2 nov 2026' };

test('report coerente col pannello e col periodo: Sharpe e Sortino passano com\'erano', () => {
  const r = rischioDalReportDelPeriodo(REPORT, { panel: PANNELLO, periodo: PERIODO });
  assert.equal(r.ok, true);
  assert.equal(r.sharpe, REPORT.sharpe);
  assert.equal(r.sortino, REPORT.sortino);
});

test('un numero di trade diverso dal pannello: e\' il report di un altro periodo, si scarta', () => {
  // Il caso da cui nasce tutto: reportData() dello storico intero accanto al P&L del periodo.
  const r = rischioDalReportDelPeriodo({ ...REPORT, total_trades: 288 }, { panel: { ...PANNELLO, total_trades: 24 }, periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.match(r.reason, /trade/);
});

test('stessi trade ma P&L diverso: si scarta', () => {
  const r = rischioDalReportDelPeriodo({ ...REPORT, net_profit: -9000, total_profit: -9000 }, { panel: PANNELLO, periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.match(r.reason, /P&L/);
});

test('trade aperto a fine periodo: il pannello mostra il totalProfit, lo Sharpe passa', () => {
  // Il collaudo della campagna n. 2 (backtest 308, 27/11/2026): netProfit -868,92 (solo trade
  // chiusi), openPL +1.170,49, totalProfit +301,57 = "P&L totale" del pannello. Confrontare col
  // netProfit scartava uno Sharpe giusto e il collaudo usciva non conclusivo.
  const r = rischioDalReportDelPeriodo(
    { ...REPORT, net_profit: -868.92, total_profit: 301.5700000000002, sharpe: 0.043, sortino: 0.061 },
    { panel: { total_trades: 438, net_profit: 301.57 }, periodo: PERIODO },
  );
  assert.equal(r.ok, true);
  assert.equal(r.sharpe, 0.043);
  assert.equal(r.sortino, 0.061);
});

test('netProfit uguale al pannello ma totalProfit diverso: si scarta', () => {
  // Il confronto e' col totalProfit: un netProfit che coincide per caso non basta.
  const r = rischioDalReportDelPeriodo({ ...REPORT, total_profit: -9000 }, { panel: PANNELLO, periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.match(r.reason, /P&L/);
});

test('report senza totalProfit: il P&L non e\' verificabile, si scarta', () => {
  const { total_profit, ...senza } = REPORT;
  const r = rischioDalReportDelPeriodo(senza, { panel: PANNELLO, periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.match(r.reason, /P&L/);
});

test('il P&L del pannello e\' arrotondato al centesimo: mezzo centesimo di scarto non e\' una differenza', () => {
  const r = rischioDalReportDelPeriodo(REPORT, { panel: { ...PANNELLO, net_profit: -10219.73 }, periodo: PERIODO });
  assert.equal(r.ok, true);
});

test('date del report fuori dal periodo applicato: si scarta anche con trade e P&L uguali', () => {
  const r = rischioDalReportDelPeriodo(REPORT, { panel: PANNELLO, periodo: { from: '2023-11-06', to: '2026-10-01' } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /periodo/);
});

test('periodo che inizia di sabato: la prima barra il lunedi\' e\' ancora dentro', () => {
  const lun = Date.UTC(2023, 10, 6, 14, 30); // lunedi' 6 nov 2023
  const r = rischioDalReportDelPeriodo(
    { ...REPORT, backtest_from: lun, backtest_to: Date.UTC(2026, 9, 1, 20, 0) },
    { panel: PANNELLO, periodo: { from: '2023-11-04', to: '2026-10-01' } },
  );
  assert.equal(r.ok, true);
});

test('report assente o ambiguo: nessun numero, e il motivo detto', () => {
  assert.equal(rischioDalReportDelPeriodo(null, { panel: PANNELLO, periodo: PERIODO }).ok, false);
  assert.equal(rischioDalReportDelPeriodo({ found: false, error: 'x' }, { panel: PANNELLO, periodo: PERIODO }).ok, false);
  const amb = rischioDalReportDelPeriodo({ ...REPORT, ambiguous: true }, { panel: PANNELLO, periodo: PERIODO });
  assert.equal(amb.ok, false);
  assert.match(amb.reason, /ambiguo|diversi/);
});

test('Sharpe non numerico nel report (troppi pochi mesi): resta null, non zero', () => {
  const r = rischioDalReportDelPeriodo({ ...REPORT, sharpe: null, sortino: NaN }, { panel: PANNELLO, periodo: PERIODO });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Sharpe/);
});

test('Sortino mancante ma Sharpe presente: lo Sharpe passa, il Sortino resta null', () => {
  const r = rischioDalReportDelPeriodo({ ...REPORT, sortino: undefined }, { panel: PANNELLO, periodo: PERIODO });
  assert.equal(r.ok, true);
  assert.equal(r.sharpe, REPORT.sharpe);
  assert.equal(r.sortino, null);
});

test('readPeriodReport restituisce la proiezione cosi\' come la pagina la calcola', async () => {
  let codice = '';
  const out = await readPeriodReport({ evaluate: async (js) => { codice = js; return REPORT; } });
  assert.deepEqual(out, REPORT);
  // marginUsage (~270k caratteri) non deve mai uscire dalla pagina.
  assert.doesNotMatch(codice, /return\s+s\s*;/);
  assert.match(codice, /strategy-report-summary/);
  // Il pannello mostra il P&L coi trade aperti: la proiezione deve portarlo.
  assert.match(codice, /total_profit:\s*fin\(a\.totalProfit\)/);
});

test('readPeriodReport: una evaluate che lancia diventa found:false, mai un\'eccezione', async () => {
  const out = await readPeriodReport({ evaluate: async () => { throw new Error('CDP giu\''); } });
  assert.equal(out.found, false);
  assert.match(out.error, /CDP/);
});
