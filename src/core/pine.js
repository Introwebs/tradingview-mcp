/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
//
// TradingView keeps previously-opened Pine editor instances alive but detached
// (0x0, offsetParent null). The old finder returned env.editor.getEditors()[0],
// which after the first script switch is one of those ghosts. Every read then
// returned another script's code and every write landed where nobody could see
// it — while Ctrl+S kept saving the VISIBLE buffer under the VISIBLE identity.
// That mismatch is how unrelated scripts got overwritten. Always resolve the
// visible instance.
export const FIND_MONACO = `
  (function findMonacoEditor() {
    var containers = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    var env = null;
    for (var ci = 0; ci < containers.length && !env; ci++) {
      var el = containers[ci];
      var fiberKey;
      for (var i = 0; i < 20; i++) {
        if (!el) break;
        fiberKey = Object.keys(el).find(function(k) { return k.indexOf('__reactFiber$') === 0; });
        if (fiberKey) break;
        el = el.parentElement;
      }
      if (!fiberKey) continue;
      var current = el[fiberKey];
      for (var d = 0; d < 15; d++) {
        if (!current) break;
        if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
          var candidate = current.memoizedProps.value.monacoEnv;
          if (candidate.editor && typeof candidate.editor.getEditors === 'function') { env = candidate; break; }
        }
        current = current.return;
      }
    }
    if (!env) return null;
    var editors = env.editor.getEditors();
    var best = null, bestArea = 0;
    for (var e = 0; e < editors.length; e++) {
      var node = editors[e].getDomNode();
      if (!node || node.offsetParent === null) continue;
      var area = node.offsetWidth * node.offsetHeight;
      if (area > bestArea) { best = editors[e]; bestArea = area; }
    }
    if (!best) return null;
    return { editor: best, env: env };
  })()
`;

// ── Script identity (injected into TV page) ──
//
// The editor buffer alone says nothing about WHICH saved script a write will
// land on. TradingView keeps that identity in the Pine editor's React state;
// this reads it, scoped to the visible editor. Returns null when the buffer is
// a brand-new unsaved script (no identity yet) — which is precisely the state
// in which a save cannot overwrite anything.
export const FIND_IDENTITY = `
  (function findScriptIdentity() {
    var containers = document.querySelectorAll('.monaco-editor.pine-editor-monaco');
    var target = null;
    for (var i = 0; i < containers.length; i++) {
      var n = containers[i];
      if (n.offsetParent !== null && n.offsetWidth > 0 && n.offsetHeight > 0) { target = n; break; }
    }
    if (!target) return null;
    var el = target, fiberKey;
    for (var j = 0; j < 20; j++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.indexOf('__reactFiber$') === 0; });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey], level = 0;
    while (current && level < 80) {
      var hook = current.memoizedState, guard = 0;
      while (hook && guard < 60) {
        try {
          var v = hook.memoizedState;
          if (v && v.current && v.current.value && typeof v.current.value.scriptIdPart === 'string') {
            var s = v.current.value;
            return {
              script_id: s.scriptIdPart,
              name: s.scriptName || null,
              title: s.scriptTitle || null,
              version: s.version || null,
              pine_version: s.pineVersion || null,
            };
          }
        } catch (e) {}
        hook = hook.next; guard++;
      }
      current = current.return; level++;
    }
    return null;
  })()
`;

// Save button state doubles as the dirty flag: TradingView tags it `saved-…`
// when the buffer matches the cloud copy and `unsaved-…` when it does not.
const FIND_DIRTY = `
  (function() {
    var b = document.querySelector('[data-qa-id="pine-script-save-button"]');
    if (!b) return null;
    return b.className.indexOf('saved-') === -1;
  })()
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Polls an injected expression until `ok` accepts the value, or the deadline passes. */
async function waitFor(expression, ok, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await evaluate(expression);
    if (ok(last)) return last;
    if (Date.now() >= deadline) return last;
    await sleep(intervalMs);
  }
}

/** Reads the identity of the script the visible editor currently points at. */
export async function getIdentity() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const identity = await evaluate(FIND_IDENTITY);
  const dirty = await evaluate(FIND_DIRTY);

  return {
    success: true,
    // null identity = brand-new unsaved script; a save here creates, never overwrites.
    identity: identity || null,
    is_new_unsaved: identity === null,
    has_unsaved_changes: dirty,
  };
}

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  // Every read carries the identity it came from, so callers can never mistake
  // one script's code for another's.
  const identity = await evaluate(FIND_IDENTITY);

  return {
    success: true,
    source,
    line_count: source.split('\n').length,
    char_count: source.length,
    identity: identity || null,
    is_new_unsaved: identity === null,
  };
}

export async function setSource({ source, expect_script_id, expect_name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const identity = await evaluate(FIND_IDENTITY);

  // Optional guard: refuse the write unless the buffer points where the caller
  // believes it does. Pass expect_script_id from pine_new/pine_open and a
  // silently-switched editor can no longer take the write.
  if (expect_script_id && (!identity || identity.script_id !== expect_script_id)) {
    throw new Error(
      `Identity mismatch: editor holds ${identity ? `"${identity.name}" (${identity.script_id})` : 'a new unsaved script'}, ` +
      `expected ${expect_script_id}. Refusing to write. Re-open the target script.`
    );
  }
  if (expect_name && (!identity || identity.name !== expect_name)) {
    throw new Error(
      `Identity mismatch: editor holds ${identity ? `"${identity.name}"` : 'a new unsaved script'}, ` +
      `expected "${expect_name}". Refusing to write.`
    );
  }

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');

  // Read the buffer back: setValue() reporting true is not proof the visible
  // editor took the text.
  const written = await evaluate(`
    (function() { var m = ${FIND_MONACO}; return m ? m.editor.getValue().length : -1; })()
  `);
  if (written !== source.length) {
    throw new Error(`Write did not land: editor holds ${written} chars, expected ${source.length}.`);
  }

  return {
    success: true,
    lines_set: source.split('\n').length,
    chars_set: written,
    identity: identity || null,
    is_new_unsaved: identity === null,
  };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // data-qa-id is stable across UI languages. The old code matched English
  // button labels, so on a localized UI (it/de/fr/…) nothing matched at all.
  // Still no Save-button fallback: a compile must never turn into a cloud save
  // of whatever identity the buffer happens to hold.
  const clicked = await evaluate(`
    (function() {
      var b = document.querySelector('[data-qa-id="add-script-to-chart"]');
      if (b && !b.disabled) { b.click(); return b.getAttribute('title') || 'add-script-to-chart'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save({ name, expect_script_id } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await evaluate(FIND_IDENTITY);

  if (expect_script_id && (!before || before.script_id !== expect_script_id)) {
    throw new Error(
      `Identity mismatch: editor holds ${before ? `"${before.name}" (${before.script_id})` : 'a new unsaved script'}, ` +
      `expected ${expect_script_id}. Refusing to save.`
    );
  }

  // The Pine editor's own Save button carries a stable data-qa-id, so this
  // works on any UI language. Ctrl+S stays as the fallback.
  const clicked = await evaluate(`
    (function() {
      var b = document.querySelector('[data-qa-id="pine-script-save-button"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  }

  // A brand-new script opens the "Save script" name dialog. Its input and
  // buttons are addressed by data-qa-id, not by English labels — the old
  // `text === 'Save'` match never fired on a localized UI.
  const dialogAppeared = await waitFor(
    `(function() { return !!document.querySelector('[class*="popupDialog-"] [data-qa-id="save-btn"]'); })()`,
    (v) => v === true,
    { timeoutMs: 2500, intervalMs: 150 }
  );

  let namedAs = null;
  if (dialogAppeared) {
    const escapedName = JSON.stringify(name || '');
    const dialogResult = await evaluate(`
      (function() {
        var dlg = document.querySelector('[class*="popupDialog-"]');
        if (!dlg) return { ok: false, reason: 'dialog vanished' };
        var input = dlg.querySelector('[data-qa-id="ui-lib-Input-input"]');
        var btn = dlg.querySelector('[data-qa-id="save-btn"]');
        if (!btn) return { ok: false, reason: 'save button not found in dialog' };
        var wanted = ${escapedName};
        if (wanted && input) {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, wanted);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        var finalName = input ? input.value : null;
        if (btn.disabled) return { ok: false, reason: 'save button disabled (invalid name?)', name: finalName };
        btn.click();
        return { ok: true, name: finalName };
      })()
    `);
    if (!dialogResult?.ok) {
      throw new Error(`Save dialog could not be completed: ${dialogResult?.reason || 'unknown'}`);
    }
    namedAs = dialogResult.name;
  }

  // Verify instead of asserting. Saved state = the Save button flips back to
  // `saved-…`; on top of that the identity must exist and, for a re-save, its
  // version must have moved.
  const stillDirty = await waitFor(FIND_DIRTY, (v) => v === false, { timeoutMs: 8000 });
  const after = await evaluate(FIND_IDENTITY);

  if (!after) {
    throw new Error('Save did not complete: the editor still holds an unsaved script with no identity.');
  }
  if (stillDirty !== false) {
    throw new Error(`Save did not complete: the editor still reports unsaved changes for "${after.name}".`);
  }
  if (before && before.script_id !== after.script_id) {
    throw new Error(
      `Save landed on the wrong script: started on "${before.name}" (${before.script_id}), ` +
      `ended on "${after.name}" (${after.script_id}).`
    );
  }

  return {
    success: true,
    saved: true,
    script_id: after.script_id,
    name: after.name,
    version_before: before ? before.version : null,
    version_after: after.version,
    created: !before,
    named_via_dialog: namedAs,
  };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  // Same locale-independent selector as compile(); no Save-button fallback.
  const buttonClicked = await evaluate(`
    (function() {
      var b = document.querySelector('[data-qa-id="add-script-to-chart"]');
      if (b && !b.disabled) { b.click(); return b.getAttribute('title') || 'add-script-to-chart'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

/**
 * Creates a genuinely new script through TradingView's own "Create new" menu.
 *
 * The previous implementation just pasted a template into the current buffer.
 * It created nothing and, crucially, left the editor's identity pointing at
 * whatever script was open — so the next save wrote a blank template over an
 * existing script. This drives the real UI instead, and the proof it worked is
 * that the editor ends up with NO identity (a brand-new unsaved script, which
 * by construction cannot overwrite anything). Pass `name` to save it right away
 * and get back the freshly minted script_id.
 */
export async function newScript({ type, name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await evaluate(FIND_IDENTITY);
  const dirtyBefore = await evaluate(FIND_DIRTY);
  if (dirtyBefore === true) {
    throw new Error(
      `The editor has unsaved changes${before ? ` on "${before.name}"` : ''}. ` +
      'Save or discard them before creating a new script — switching away can lose them.'
    );
  }

  const opened = await evaluate(`
    (function() {
      var b = document.querySelector('[data-qa-id="pine-script-title-button"]');
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
  if (!opened) throw new Error('Pine editor script menu button not found.');

  // "Create new" is the only entry in that menu with a submenu — a structural
  // match, so it survives every UI language.
  const submenuId = await waitFor(
    `(function() {
       var items = document.querySelectorAll('[role="menuitem"]');
       for (var i = 0; i < items.length; i++) {
         if (items[i].getAttribute('aria-haspopup') === 'menu') {
           items[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
           items[i].click();
           return items[i].getAttribute('aria-controls') || '';
         }
       }
       return null;
     })()`,
    (v) => typeof v === 'string',
    { timeoutMs: 4000, intervalMs: 150 }
  );
  if (typeof submenuId !== 'string') {
    await evaluate(`(function(){ document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); })()`);
    throw new Error('"Create new" submenu not found in the Pine editor script menu.');
  }

  // Submenu order is fixed: indicator, strategy, library, built-in.
  const typeIndex = { indicator: 0, strategy: 1, library: 2 };
  const index = typeIndex[type];
  if (index === undefined) throw new Error(`Unknown script type "${type}".`);

  const picked = await waitFor(
    `(function() {
       var menu = ${JSON.stringify(submenuId)} ? document.getElementById(${JSON.stringify(submenuId)}) : null;
       if (!menu) return { ok: false, reason: 'submenu container not rendered yet' };
       var items = menu.querySelectorAll('[role="menuitem"]');
       if (items.length < 3) return { ok: false, reason: 'submenu has ' + items.length + ' entries, expected at least 3' };
       items[${index}].click();
       return { ok: true, label: items[${index}].textContent.trim() };
     })()`,
    (v) => v && v.ok === true,
    { timeoutMs: 4000, intervalMs: 150 }
  );
  if (!picked?.ok) throw new Error(`Could not pick "${type}" from the Create-new submenu: ${picked?.reason || 'unknown'}`);

  // A real new script has no identity yet. That is the anchor: not the template
  // text (which is localized — "Il mio script" on an Italian UI, so matching
  // `indicator("My script")` never worked).
  const identityAfter = await waitFor(FIND_IDENTITY, (v) => v === null, { timeoutMs: 6000 });
  if (identityAfter !== null) {
    throw new Error(
      `Create-new did not take: the editor still points at "${identityAfter.name}" (${identityAfter.script_id}). ` +
      'Aborting before anything can be written over it.'
    );
  }

  const template = await evaluate(`(function() { var m = ${FIND_MONACO}; return m ? m.editor.getValue() : null; })()`);

  if (!name) {
    return {
      success: true,
      type,
      created: true,
      saved: false,
      identity: null,
      is_new_unsaved: true,
      template,
      note: 'New unsaved script. Call pine_save with a name to persist it; it cannot overwrite anything in this state.',
    };
  }

  const saved = await save({ name });
  return {
    success: true,
    type,
    created: true,
    saved: true,
    script_id: saved.script_id,
    name: saved.name,
    version: saved.version_after,
    template,
  };
}

/**
 * Opens a saved script through TradingView's own "Open script" dialog.
 *
 * The old implementation fetched the source over pine-facade and pasted it into
 * the buffer. That reads like an open but is not one: the editor's identity
 * stayed on the previously-open script, so open → edit → save wrote the new
 * code over the OLD script. It also matched names by substring, so a prefix
 * could silently select the wrong one. This drives the real dialog, matches the
 * title exactly, and verifies the identity actually switched.
 */
export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await evaluate(FIND_IDENTITY);
  const dirtyBefore = await evaluate(FIND_DIRTY);
  if (dirtyBefore === true) {
    throw new Error(
      `The editor has unsaved changes${before ? ` on "${before.name}"` : ''}. ` +
      'Save or discard them before opening another script.'
    );
  }

  const menuOpened = await evaluate(`
    (function() {
      var b = document.querySelector('[data-qa-id="pine-script-title-button"]');
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
  if (!menuOpened) throw new Error('Pine editor script menu button not found.');

  // "Open script…" is the last plain entry of that menu (the only submenu entry
  // is "Create new"), so no English label is involved.
  const dialogOpened = await waitFor(
    `(function() {
       var items = document.querySelectorAll('[role="menuitem"]');
       var plain = [];
       for (var i = 0; i < items.length; i++) {
         if (items[i].getAttribute('aria-haspopup') !== 'menu') plain.push(items[i]);
       }
       if (!plain.length) return false;
       plain[plain.length - 1].click();
       return true;
     })()`,
    (v) => v === true,
    { timeoutMs: 4000, intervalMs: 150 }
  );
  if (dialogOpened !== true) throw new Error('"Open script" entry not found in the Pine editor script menu.');

  const escapedExact = JSON.stringify(name);
  const picked = await waitFor(
    `(function() {
       var rows = document.querySelectorAll('[class*="itemRow-"]');
       if (!rows.length) return { ok: false, reason: 'script list not rendered yet' };
       var wanted = ${escapedExact};
       var names = [], exact = [];
       for (var i = 0; i < rows.length; i++) {
         var t = rows[i].querySelector('[class*="titleText-"]');
         var n = t ? t.textContent.trim() : '';
         names.push(n);
         if (n === wanted) exact.push(rows[i]);
       }
       if (exact.length === 1) {
         var hit = exact[0].querySelector('[class*="itemInfo-"]') || exact[0];
         hit.click();
         return { ok: true };
       }
       if (exact.length > 1) return { ok: false, reason: exact.length + ' scripts share the name "' + wanted + '"', names: names };
       return { ok: false, reason: 'no script titled exactly "' + wanted + '"', names: names };
     })()`,
    (v) => v && v.ok === true,
    { timeoutMs: 8000, intervalMs: 250 }
  );

  if (!picked?.ok) {
    await evaluate(`
      (function() {
        var c = document.querySelector('[data-qa-id="close"]');
        if (c) c.click();
      })()
    `);
    const available = Array.isArray(picked?.names) ? ` Available: ${picked.names.slice(0, 40).join(', ')}` : '';
    throw new Error(`Could not open "${name}": ${picked?.reason || 'unknown'}.${available}`);
  }

  // The identity must actually be the requested script — this is the check the
  // whole anti-overwrite protocol rests on.
  const after = await waitFor(FIND_IDENTITY, (v) => v && v.name === name, { timeoutMs: 10000, intervalMs: 250 });
  if (!after || after.name !== name) {
    throw new Error(
      `Open did not take: the editor points at ${after ? `"${after.name}"` : 'a new unsaved script'}, expected "${name}".`
    );
  }

  const source = await evaluate(`(function() { var m = ${FIND_MONACO}; return m ? m.editor.getValue() : null; })()`);

  return {
    success: true,
    opened: true,
    name: after.name,
    script_id: after.script_id,
    version: after.version,
    lines: typeof source === 'string' ? source.split('\n').length : null,
    previous: before ? { name: before.name, script_id: before.script_id } : null,
    source: 'editor_ui',
  };
}

/** Legacy pine-facade read: fetches a saved script's source WITHOUT touching the editor buffer. */
export async function readScriptSource({ name }) {
  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          // No substring fallback: a prefix match used to silently return a
          // different script than the one asked for.
          if (!match) return {error: 'No script titled exactly "' + target + '". Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              return {success: true, name: match.scriptName || match.scriptTitle, id: id, version: ver, source: source};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return {
    success: true,
    name: result.name,
    script_id: result.id,
    version: result.version,
    source: result.source,
    lines: result.source.split('\n').length,
    read_via: 'pine_facade',
    editor_untouched: true,
  };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
