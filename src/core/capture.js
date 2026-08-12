/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { waitForChartRender } from '../wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

export async function captureScreenshot({ region, filename, method, waitForRender = false } = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  if (waitForRender) await waitForChartRender();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region || 'full'}_${ts}`).replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api', waited_for_render: !!waitForRender,
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    // ⚠️ I DUE SELETTORI ORIGINALI SONO MORTI — misurato dal vivo il 2026-08-12:
    //   [data-name="backtesting"]   -> null (rimosso da TradingView; e' lo stesso selettore marcio
    //                                  ereditato da monte che aveva gia' rotto ensureTesterPanel)
    //   [class*="strategyReport"]   -> null
    // Con entrambi null `clip` restava undefined e Page.captureScreenshot fotografava l'INTERA
    // finestra: ecco perche' gli "screenshot dell'equity" contenevano il chart, le watchlist e la
    // barra degli strumenti, con la curva schiacciata in un angolo.
    //
    // Ordine di preferenza, dal piu' stabile al piu' generico:
    //   1. `.layout__area--bottom`  — classe STRUTTURALE, non un hash di build. Include la tab della
    //      strategia e la toolbar (periodo, capitale), che e' il contesto che rende leggibile lo
    //      scatto. Misurato: 56,0 1815x994 da massimizzato, 56,623 1815x371 da normale.
    //   2. `.bottom-widgetbar-content.backtesting` — stesso tier, ma senza tab e toolbar.
    //   3. geometria dal MODELLO (`bwb.height()`): nessun DOM di mezzo.
    // Un box degenere (0x0) va RIFIUTATO, non usato: a pannello minimizzato il selettore matcha
    // comunque un nodo collassato, e un clip 0x0 e' uno screenshot vuoto invece di uno brutto.
    const bounds = await evaluate(`
      (function() {
        function v(x) { try { return (x && typeof x.value === 'function') ? x.value() : x; } catch (e) { return null; } }
        function box(el) {
          if (!el) return null;
          var r = el.getBoundingClientRect();
          if (!(r.width > 1 && r.height > 1)) return null;
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        var b = box(document.querySelector('.layout__area--bottom'))
          || box(document.querySelector('.bottom-widgetbar-content.backtesting'));
        if (b) return b;
        try {
          var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
          var h = Number(v(bwb && bwb.height && bwb.height()));
          if (h > 1) return { x: 0, y: Math.max(0, window.innerHeight - h), width: window.innerWidth, height: h };
        } catch (e) { /* si scende al full page */ }
        return null;
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    waited_for_render: !!waitForRender,
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
