import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_identity', 'Which saved script the editor currently points at (script_id, name, version) and whether it has unsaved changes. identity=null means a brand-new unsaved script — a save in that state creates and cannot overwrite anything. Call this before any write to know where the write will land.', {}, async () => {
    try { return jsonResult(await core.getIdentity()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_source', 'Get the current Pine Script source from the editor, together with the identity of the script it belongs to', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor. Pass expect_script_id (as returned by pine_new / pine_open) to make the write fail loudly instead of landing on a script that got switched underneath you.', {
    source: z.string().describe('Pine Script source code to inject'),
    expect_script_id: z.string().optional().describe('Refuse the write unless the editor points at this script_id'),
    expect_name: z.string().optional().describe('Refuse the write unless the editor points at a script with exactly this name'),
  }, async ({ source, expect_script_id, expect_name }) => {
    try { return jsonResult(await core.setSource({ source, expect_script_id, expect_name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script and VERIFY it landed (returns script_id, name, version before/after). Throws instead of reporting success when the save did not complete or landed on a different script. Pass name to title a brand-new unsaved script, expect_script_id to refuse saving onto anything else.', {
    name: z.string().optional().describe('Name for a brand-new unsaved script (fills the Save dialog)'),
    expect_script_id: z.string().optional().describe('Refuse the save unless the editor points at this script_id'),
  }, async ({ name, expect_script_id }) => {
    try { return jsonResult(await core.save({ name, expect_script_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a REAL new Pine Script via TradingView\'s "Create new" menu — a fresh script with no identity, so nothing existing can be overwritten. Pass name to save it immediately and get back its new script_id. Verified: fails loudly if the editor still points at the previously open script.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
    name: z.string().optional().describe('Save the new script under this name right away and return its script_id'),
  }, async ({ type, name }) => {
    try { return jsonResult(await core.newScript({ type, name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open', 'Really open a saved Pine Script in the editor (via TradingView\'s Open dialog), matching the title EXACTLY, and verify the editor identity switched. Returns script_id — pass it to pine_set_source/pine_save as expect_script_id.', {
    name: z.string().describe('Exact name of the saved script to open'),
  }, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_read_script', 'Read a saved script\'s source WITHOUT touching the editor buffer (fetched from pine-facade). Use this to look at another script during a write session — pine_open would move the editor and put the pending write at risk.', {
    name: z.string().describe('Exact name of the saved script to read'),
  }, async ({ name }) => {
    try { return jsonResult(await core.readScriptSource({ name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
