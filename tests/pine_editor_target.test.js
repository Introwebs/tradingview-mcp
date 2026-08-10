/**
 * Regression tests for the Pine editor targeting logic.
 *
 * TradingView keeps previously-opened Monaco instances alive but detached.
 * getEditors()[0] is frequently one of those ghosts, and the old finder took it
 * blindly: reads returned another script's code, writes vanished, and Ctrl+S
 * saved the VISIBLE buffer under the VISIBLE identity — which is how unrelated
 * scripts got overwritten. These tests run the injected snippets against a fake
 * DOM so that behaviour can never come back.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { FIND_MONACO, FIND_IDENTITY } from '../src/core/pine.js';

const FIBER_KEY = '__reactFiber$fake123';

/** A Monaco editor stub whose DOM node has the given visibility/geometry. */
function makeEditor(id, { visible, width = 800, height = 600 } = {}) {
  const node = {
    offsetParent: visible ? {} : null,
    offsetWidth: visible ? width : 0,
    offsetHeight: visible ? height : 0,
  };
  return { id, getDomNode: () => node, getValue: () => `source of ${id}` };
}

/**
 * Builds a sandbox with `count` `.monaco-editor.pine-editor-monaco` containers,
 * a React fiber carrying monacoEnv, and optionally a hook chain holding the
 * script identity.
 */
function makeSandbox({ editors, identity = null, containerVisibility = [true] }) {
  const env = { editor: { getEditors: () => editors } };

  const identityHook = identity
    ? { memoizedState: { current: { value: identity } }, next: null }
    : { memoizedState: { some: 'unrelated hook' }, next: null };

  // The fiber the container resolves to; its parent carries the identity hook.
  const parentFiber = { memoizedProps: null, memoizedState: identityHook, return: null };
  const fiber = {
    memoizedProps: { value: { monacoEnv: env } },
    memoizedState: null,
    return: parentFiber,
  };

  const containers = containerVisibility.map((visible) => {
    const el = {
      offsetParent: visible ? {} : null,
      offsetWidth: visible ? 900 : 0,
      offsetHeight: visible ? 700 : 0,
      parentElement: null,
    };
    el[FIBER_KEY] = fiber;
    return el;
  });

  return vm.createContext({
    document: {
      querySelectorAll: (sel) =>
        sel === '.monaco-editor.pine-editor-monaco' ? containers : [],
      querySelector: () => null,
    },
    Object,
  });
}

describe('FIND_MONACO — never targets a hidden ghost editor', () => {
  test('picks the visible editor even when the ghost comes first', () => {
    const ghost = makeEditor('ghost', { visible: false });
    const real = makeEditor('real', { visible: true });
    const sandbox = makeSandbox({ editors: [ghost, real] });

    const result = vm.runInContext(FIND_MONACO, sandbox);

    assert.ok(result, 'expected an editor to be resolved');
    assert.strictEqual(result.editor.id, 'real');
  });

  test('returns null when every editor is detached, instead of guessing', () => {
    const sandbox = makeSandbox({
      editors: [makeEditor('ghost1', { visible: false }), makeEditor('ghost2', { visible: false })],
    });

    assert.strictEqual(vm.runInContext(FIND_MONACO, sandbox), null);
  });

  test('picks the largest when several editors are visible (split view)', () => {
    const small = makeEditor('small', { visible: true, width: 300, height: 200 });
    const large = makeEditor('large', { visible: true, width: 1200, height: 800 });
    const sandbox = makeSandbox({ editors: [small, large] });

    assert.strictEqual(vm.runInContext(FIND_MONACO, sandbox).editor.id, 'large');
  });

  test('returns null when the Pine editor is not on the page at all', () => {
    const sandbox = vm.createContext({
      document: { querySelectorAll: () => [], querySelector: () => null },
      Object,
    });

    assert.strictEqual(vm.runInContext(FIND_MONACO, sandbox), null);
  });
});

describe('FIND_IDENTITY — reports where a write would land', () => {
  test('reads the identity of the script behind the visible editor', () => {
    const sandbox = makeSandbox({
      editors: [makeEditor('real', { visible: true })],
      identity: {
        scriptIdPart: 'USER;abc123',
        scriptName: '[NEW]_Forex_Sessions_v1',
        scriptTitle: 'Forex Sessions',
        version: '2.0',
        pineVersion: 6,
      },
    });

    // Round-trip through JSON: the snippet builds its object inside the vm
    // context, so it does not share this realm's Object.prototype.
    const identity = JSON.parse(JSON.stringify(vm.runInContext(FIND_IDENTITY, sandbox)));

    assert.deepStrictEqual(identity, {
      script_id: 'USER;abc123',
      name: '[NEW]_Forex_Sessions_v1',
      title: 'Forex Sessions',
      version: '2.0',
      pine_version: 6,
    });
  });

  test('returns null for a brand-new unsaved script — the state that cannot overwrite', () => {
    const sandbox = makeSandbox({
      editors: [makeEditor('real', { visible: true })],
      identity: null,
    });

    assert.strictEqual(vm.runInContext(FIND_IDENTITY, sandbox), null);
  });

  test('ignores hidden containers when resolving the identity', () => {
    const sandbox = makeSandbox({
      editors: [makeEditor('real', { visible: true })],
      identity: { scriptIdPart: 'USER;xyz', scriptName: 'Visible One', scriptTitle: 'Visible One', version: '1.0', pineVersion: 6 },
      containerVisibility: [false, true],
    });

    assert.strictEqual(vm.runInContext(FIND_IDENTITY, sandbox).script_id, 'USER;xyz');
  });
});
