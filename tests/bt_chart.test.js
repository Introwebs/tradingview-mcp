import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  readInputsInfo, readInputValues, readbackMatches,
  readStrategyLoading, readReportFor, readCommissionFor, ensureVisibleFor, setStrategyVisibility,
} from '../src/core/btChart.js';

test('readInputsInfo proietta solo id/name/type/group e non trasporta mai il blob del source', async () => {
  let js = '';
  const evaluate = async (code) => {
    js = code;
    return JSON.stringify([{ id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Risk' }]);
  };
  const out = await readInputsInfo('ent1', { evaluate });
  assert.deepEqual(out, [{ id: 'in_0', name: 'Risk/Reward', type: 'float', group: 'Risk' }]);
  // La proiezione deve avvenire DENTRO la pagina: il JS non deve stringificare l'array grezzo.
  assert.match(js, /getInputsInfo\(\)/);
  assert.doesNotMatch(js, /JSON\.stringify\(\s*study\.getInputsInfo\(\)\s*\)/);
  // `group` serve a classificare logica vs Proprietà: deve essere nella proiezione.
  assert.match(js, /group:\s*x\.group/);
});

test('readInputValues ritorna una mappa id → valore', async () => {
  const evaluate = async () => ({ in_0: 2.5, in_1: 'x' });
  assert.deepEqual(await readInputValues('ent1', { evaluate }), { in_0: 2.5, in_1: 'x' });
});

test('readbackMatches confronta solo le chiavi richieste', () => {
  assert.equal(readbackMatches({ in_0: 3 }, { in_0: 3, in_1: 'x' }), true);
  assert.equal(readbackMatches({ in_0: 3 }, { in_0: 2, in_1: 'x' }), false);
});

test('readbackMatches tollera numeri equivalenti scritti come stringa', () => {
  assert.equal(readbackMatches({ in_0: 3 }, { in_0: '3' }), true);
});

// --- letture LEGATE A UN entity_id -------------------------------------------------
// Questi test esistono per un difetto reale: leggere "la prima strategia con un report"
// invece di quella richiesta faceva registrare le metriche di un'altra strategia del chart,
// con numeri plausibili e nessun errore. Il vincolo che conta è che l'id RICHIESTO compaia
// nel confronto dentro la pagina — non che la funzione ritorni qualcosa.

test('readStrategyLoading ritorna il booleano isLoading della strategia richiesta', async () => {
  let js = '';
  const evaluate = async (code) => { js = code; return true; };
  assert.equal(await readStrategyLoading('GoZBF3', { evaluate }), true);
  assert.match(js, /isLoading\(\)/);
  // la selezione deve avvenire per id, non "la prima che capita"
  assert.match(js, /"GoZBF3"/);
  assert.match(js, /sid === wantId/);
});

test('readStrategyLoading ritorna null se la strategia non è sul chart o isLoading non esiste', async () => {
  assert.equal(await readStrategyLoading('nope', { evaluate: async () => null }), null);
  assert.equal(await readStrategyLoading('nope', { evaluate: async () => undefined }), null);
});

test('readReportFor legge il report DELLA strategia richiesta, non del primo che ne ha uno', async () => {
  let js = '';
  const evaluate = async (code) => {
    js = code;
    return { success: true, metrics: { net_profit: 28309.058, total_trades: 288 }, currency: 'USD' };
  };
  const out = await readReportFor('GoZBF3', { evaluate });
  assert.equal(out.success, true);
  assert.equal(out.metrics.total_trades, 288);
  // il confronto sull'id è LA garanzia: senza, si rilegge la strategia sbagliata
  assert.match(js, /"GoZBF3"/);
  assert.match(js, /sid === wantId/);
  // e non deve MAI scoperchiare niente: l'unhide di massa è ciò che rubava il report
  assert.doesNotMatch(js, /setValue\(true\)/);
  assert.doesNotMatch(js, /setVisible\(true\)/);
});

test('readReportFor proietta le metriche DENTRO la pagina', async () => {
  let js = '';
  const evaluate = async (code) => { js = code; return { success: true, metrics: {} }; };
  await readReportFor('ent1', { evaluate });
  // le chiavi del payload devono essere costruite nel JS, non trasportando reportData() intero
  assert.match(js, /net_profit_percent/);
  assert.match(js, /numberOfWiningTrades/);
  assert.doesNotMatch(js, /JSON\.stringify\(\s*rd\s*\)/);
});

test('readReportFor degrada a success:false quando il report non è calcolato', async () => {
  const out = await readReportFor('ent1', { evaluate: async () => ({ success: false, metrics: {}, error: 'non calcolato' }) });
  assert.equal(out.success, false);
  assert.equal(out.metrics.total_trades, undefined);
  assert.match(out.error, /non calcolato/);
});

test('readReportFor non esplode se evaluate ritorna spazzatura', async () => {
  const out = await readReportFor('ent1', { evaluate: async () => null });
  assert.equal(out.success, false);
  assert.deepEqual(out.metrics, {});
});

test('ensureVisibleFor tocca SOLO la strategia richiesta', async () => {
  let js = '';
  const evaluate = async (code) => { js = code; return { found: true, wasHidden: true, visible: true }; };
  const out = await ensureVisibleFor('GoZBF3', { evaluate });
  assert.deepEqual(out, { found: true, wasHidden: true, visible: true });
  assert.match(js, /"GoZBF3"/);
  assert.match(js, /sid === wantId/);
  // nessun ciclo che rende visibili tutte le strategie
  assert.doesNotMatch(js, /for\s*\([^)]*\)\s*\{[^}]*setVisible\(true\)/);
});

test('setStrategyVisibility riporta indietro la visibilità di una sola strategia', async () => {
  let js = '';
  const evaluate = async (code) => { js = code; return true; };
  assert.equal(await setStrategyVisibility('w3zjt7', false, { evaluate }), true);
  assert.match(js, /"w3zjt7"/);
  assert.match(js, /setValue\(false\)/);
});

test('readCommissionFor legge commissionPaid e la somma delle qty dei fill, senza trasportare il report intero', async () => {
  let js = '';
  const evaluate = async (code) => { js = code; return { success: true, commission_paid: 40, filled_qty_sum: 20, fills: 4, entity_id: 'ent1' }; };
  const out = await readCommissionFor('ent1', { evaluate });
  assert.deepEqual(out, { success: true, commission_paid: 40, filled_qty_sum: 20, fills: 4, entity_id: 'ent1' });
  assert.match(js, /filledOrders/);
  assert.match(js, /commissionPaid/);
  // marginUsage e' ~270k caratteri: il JS non deve mai ritornare `rd` intero
  assert.doesNotMatch(js, /return\s+rd\s*;/);
});

test('readCommissionFor: reportData null non e un crash ma un esito leggibile', async () => {
  const evaluate = async () => ({ success: false, error: 'reportData null' });
  const out = await readCommissionFor('ent1', { evaluate });
  assert.equal(out.success, false);
  assert.match(out.error, /reportData/);
});

/**
 * Costruisce il sandbox `window.TradingViewApi...dataSources()` minimo che soddisfa
 * `_paSourceById`/CHART_API, con UNA sola data source (id 'ent1') il cui reportData()
 * ritorna `rd` cosi' com'e' (o wrappato in `{ value: () => rd }`, a scelta del chiamante).
 */
function makeSandbox(rd) {
  const source = { id: () => 'ent1', reportData: () => rd };
  return vm.createContext({
    window: {
      TradingViewApi: {
        _activeChartWidgetWV: { value: () => ({
          _chartWidget: { model: () => ({ model: () => ({ dataSources: () => [source] }) }) },
        }) },
      },
    },
  });
}

/** evaluate() vero: esegue davvero il JS iniettato da readCommissionFor contro il sandbox. */
function vmEvaluate(rd) {
  return async (code) => vm.runInContext(code, makeSandbox(rd));
}

test('readCommissionFor (esecuzione reale): somma le qty assolute e legge commissionPaid', async () => {
  const rd = { performance: { all: { commissionPaid: 50 } }, filledOrders: [{ q: 10 }, { q: 10 }, { q: -5 }] };
  const out = await readCommissionFor('ent1', { evaluate: vmEvaluate(rd) });
  // Confronto per campo, non deepEqual: `out` viene dal realm del vm (Object.prototype diverso
  // da quello del test), e deepStrictEqual su node:assert/strict fallisce sul prototipo pur a
  // struttura identica.
  assert.equal(out.success, true);
  assert.equal(out.commission_paid, 50);
  assert.equal(out.filled_qty_sum, 25);
  assert.equal(out.fills, 3);
  assert.equal(out.entity_id, 'ent1');
});

test('readCommissionFor (esecuzione reale): report senza performance e success:false, non commissione 0', async () => {
  const out = await readCommissionFor('ent1', { evaluate: vmEvaluate({}) });
  assert.equal(out.success, false);
  assert.match(out.error, /non ancora calcolato/);
});

test('readCommissionFor (esecuzione reale): filledOrders wrappato in un accessor .value()', async () => {
  const rd = { performance: { all: { commissionPaid: 12 } }, filledOrders: { value: () => [{ q: 4 }] } };
  const out = await readCommissionFor('ent1', { evaluate: vmEvaluate(rd) });
  assert.equal(out.filled_qty_sum, 4);
});
