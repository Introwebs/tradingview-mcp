import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { misuraProva } from '../src/core/btProva.js';
import { creaCronometro } from '../src/core/cronometro.js';
import { creaTradingViewFinto, INFO_FINTO, M } from './helpers/tradingviewFinto.js';

// Il banco: le dipendenze TradingView finte condivise (tests/helpers/tradingviewFinto.js) e l'ambiente
// della misura. Mancano apposta `api`, `captureScreenshot` e `setPanelMaximized`: il nucleo non deve
// averne bisogno.
function banco({ metricsSeq, metricheFerme = false }) {
  const { deps, chart } = creaTradingViewFinto({ metricsSeq, metricheFerme });
  const amb = {
    entity_id: 'ent-1',
    info: INFO_FINTO,
    idsCommissione: null,
    stato: { prevFp: null, snapshotCommissione: null },
    deps,
    opzioni: { recalc_timeout_ms: 50, recalc_stable_checks: 1, recalc_step_ms: 1, recalc_start_grace_ms: 5 },
    cron: creaCronometro(deps.now),
    nota: async () => {},
    leggiPadre: async () => null,
  };
  return { amb, chart };
}

test('una prova misurata torna coi numeri e gli input riletti, senza toccare nessuna API', async () => {
  const { amb } = banco({ metricsSeq: [M(), M({ net_profit: 200 })] });
  const out = await misuraProva({ id: 't1', symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } }, amb);
  assert.equal(out.uscita, 'misurata');
  assert.equal(out.metricheFinali.net_profit, 200);
  assert.equal(out.actual.in_0, 2);
});

test('zero trade e contesto non applicato sono esiti, non eccezioni', async () => {
  const z = banco({ metricsSeq: [M(), M({ total_trades: 0, net_profit: 0 })] });
  assert.equal((await misuraProva({ id: 't1', symbol: 'EURUSD', timeframe: '15', input_set: { in_0: 2 } }, z.amb)).uscita, 'zero_trade');

  const c = banco({ metricsSeq: [M()] });
  c.amb.deps.setSymbol = async () => ({ success: true });   // il chart non cambia simbolo
  const out = await misuraProva({ id: 't2', symbol: 'GBPUSD', timeframe: '15', input_set: {} }, c.amb);
  assert.deepEqual([out.uscita, out.problema.kind], ['contesto', 'symbol_not_applied']);
});

test('il nucleo non conosce ne la piattaforma ne i salvataggi', () => {
  const src = readFileSync(new URL('../src/core/btProva.js', import.meta.url), 'utf8');
  for (const vietato of [/\bapi\./, /captureScreenshot/, /setPanelMaximized/, /stageEquity/, /finalize\(/, /pinealgos\.js/]) {
    assert.equal(vietato.test(src), false, `btProva.js non deve contenere ${vietato}`);
  }
});
