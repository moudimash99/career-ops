// tests/freemotion-browser-mode.test.mjs — hidden or visible Camoufox window.
//
// The assertion that matters most is preservation: switching the window must
// change the one `headless` token and leave every other byte of the config
// alone. That file carries Camoufox's disguise; a switch that re-serialized it,
// dropped a CRLF or touched an env value would change what sites see, and the
// trial would then measure a different browser than the one it set out to.
//
// The second is restore: after any sequence of switches, restore returns to
// the mode that was there before the first one, never to a mode in between.
//
// Run: node test-all.mjs --only freemotion-browser-mode

import { pass, fail, run, rmSync, NODE, ROOT } from './helpers.mjs';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-browser-mode — hidden or visible Camoufox window');

const {
  readHeadless, withHeadless, showMode, setMode, restoreMode, modeName, FreemotionBrowserModeError,
} = await import(pathToFileURL(join(ROOT, 'lib/freemotion-browser-mode.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};
const throws = (label, fn) => {
  try { fn(); fail(`${label} => did not throw`); } catch (err) {
    if (err instanceof FreemotionBrowserModeError) pass(label);
    else fail(`${label} => threw ${err?.name}: ${err?.message}`);
  }
};

// Shaped like the real config: one-space indent, CRLF, no final newline, the
// disguise split across CAMOU_CONFIG_* values full of escaped quotes, and the
// word "headless" inside an env value where a careless edit could reach it.
const CONFIG = [
  '{',
  ' "browser": {',
  '  "browserName": "firefox",',
  '  "launchOptions": {',
  '   "executablePath": "C:\\\\camoufox\\\\camoufox.exe",',
  '   "headless": true,',
  '   "args": [],',
  '   "env": {',
  '    "CAMOU_CONFIG_1": "{\\"navigator.userAgent\\":\\"Mozilla/5.0 (Macintosh)\\",\\"note\\":\\"headless: true\\"}",',
  '    "CAMOU_CONFIG_2": "\\"fonts\\":[\\"Arial\\",\\"Menlo\\"]}"',
  '   }',
  '  },',
  '  "firefoxUserPrefs": {',
  '   "webgl.enable-webgl2": true',
  '  }',
  ' }',
  '}',
].join('\r\n');

const tmp = mkdtempSync(join(tmpdir(), 'fm-browser-mode-'));
let fixture = 0;
const paths = (body = CONFIG) => {
  fixture += 1;
  const configPath = join(tmp, `config-${fixture}.json`);
  writeFileSync(configPath, body);
  return { configPath, statePath: join(tmp, `state-${fixture}`, 'browser-mode.json') };
};

try {
  // ── Reading and the pure edit ───────────────────────────────────────────
  check('readHeadless reads browser.launchOptions.headless', readHeadless(CONFIG), true);
  check('modeName names both modes', [modeName(true), modeName(false)], ['headless', 'headful']);

  const headful = withHeadless(CONFIG, false);
  check('withHeadless changes exactly one token',
    headful, CONFIG.replace('"headless": true,', '"headless": false,'));
  check('  ...the escaped "headless: true" inside an env value is untouched',
    headful.includes('\\"note\\":\\"headless: true\\"'), true);
  check('  ...CRLF line ends and the missing final newline survive',
    [headful.split('\r\n').length, headful.endsWith('}')], [CONFIG.split('\r\n').length, true]);
  check('  ...and switching back gives the original bytes', withHeadless(headful, true), CONFIG);
  check('setting the value it already has returns the same text', withHeadless(CONFIG, true), CONFIG);

  throws('a config without launchOptions.headless throws',
    () => readHeadless('{"browser":{"launchOptions":{}}}'));
  throws('  ...and so does a non-boolean headless',
    () => readHeadless('{"browser":{"launchOptions":{"headless":"false"}}}'));
  throws('  ...and text that is not JSON', () => readHeadless('{"browser": '));
  throws('two literal "headless" keys refuse to guess which one is the launch option',
    () => withHeadless('{"browser":{"launchOptions":{"headless":true}},"other":{"headless":true}}', false));

  // ── Switch and restore, on files ────────────────────────────────────────
  {
    const p = paths();
    const r = setMode({ mode: 'headful', run: 'fm-test-1', now: new Date('2026-10-02T10:00:00Z'), ...p });
    check('headful switches and leaves a switch to restore', r,
      { changed: true, from: 'headless', to: 'headful', pending: true });
    check('  ...the file now reads headful', readHeadless(readFileSync(p.configPath, 'utf-8')), false);
    check('  ...and the state remembers what it replaced, and for which run',
      JSON.parse(readFileSync(p.statePath, 'utf-8')),
      { previous_headless: true, mode: 'headful', run: 'fm-test-1', set_at: '2026-10-02T10:00:00.000Z' });
    const shown = showMode({ ...p, env: {} });
    check('show reports the mode and the pending switch',
      [shown.mode, shown.pending?.run, shown.envOverride], ['headful', 'fm-test-1', null]);

    check('a second headful changes nothing',
      setMode({ mode: 'headful', run: 'fm-test-2', ...p }),
      { changed: false, from: 'headful', to: 'headful', pending: true });
    check('  ...and keeps the first remembered mode and run',
      JSON.parse(readFileSync(p.statePath, 'utf-8')).run, 'fm-test-1');

    check('restore goes back', restoreMode(p), { restored: true, to: 'headless', run: 'fm-test-1' });
    check('  ...to the original bytes', readFileSync(p.configPath, 'utf-8'), CONFIG);
    check('  ...and removes the state', existsSync(p.statePath), false);
    check('restore with nothing pending is a no-op that says so',
      restoreMode(p), { restored: false, to: 'headless', run: null });
    check('  ...and still leaves the original bytes', readFileSync(p.configPath, 'utf-8'), CONFIG);
  }

  {
    const p = paths();
    setMode({ mode: 'headful', ...p });
    check('an explicit headless after headful clears the pending switch',
      setMode({ mode: 'headless', ...p }), { changed: true, from: 'headful', to: 'headless', pending: false });
    check('  ...back to the original bytes', readFileSync(p.configPath, 'utf-8'), CONFIG);
  }

  {
    // A user who made headful the default: headless for one run, restore
    // returns to headful. The module has no opinion on which mode is default.
    const p = paths(withHeadless(CONFIG, false));
    setMode({ mode: 'headless', ...p });
    check('restore returns to whatever was there, headful included',
      restoreMode(p).to, 'headful');
  }

  {
    const p = paths();
    check('switching to the mode already set leaves nothing to restore',
      setMode({ mode: 'headless', ...p }), { changed: false, from: 'headless', to: 'headless', pending: false });
    check('  ...and writes no state', existsSync(p.statePath), false);
  }

  {
    const p = paths();
    throws('an unknown mode throws', () => setMode({ mode: 'visible', ...p }));
    throws('a missing config throws', () => setMode({ mode: 'headful', configPath: join(tmp, 'nope.json') }));
    setMode({ mode: 'headful', ...p });
    writeFileSync(p.statePath, 'not json');
    throws('an unreadable state file throws instead of restoring a guess', () => restoreMode(p));
    check('  ...and the config is left as it was', readHeadless(readFileSync(p.configPath, 'utf-8')), false);
  }

  {
    const p = paths();
    check('show reports a PLAYWRIGHT_MCP_HEADLESS override',
      showMode({ ...p, env: { PLAYWRIGHT_MCP_HEADLESS: 'false' } }).envOverride, 'false');
  }

  // ── run.sh wiring ───────────────────────────────────────────────────────
  // Without these lines a HEADFUL=1 run leaves every later run (and every new
  // Claude/agy session) with a visible window. Checked as text: running run.sh
  // here would start real agents.
  {
    const sh = readFileSync(join(ROOT, 'freemotion-night/run.sh'), 'utf-8');
    const loop = sh.indexOf('for n in "$@"; do');
    const startRestore = sh.indexOf('[ -f tmp/fm/browser-mode.json ] && node lib/freemotion-browser-mode.mjs restore');
    check('run.sh restores a left-over switch before the first job',
      startRestore !== -1 && startRestore < loop, true);
    check('  ...and a HEADFUL=1 run restores on exit and on Ctrl+C',
      [sh.includes("trap 'node lib/freemotion-browser-mode.mjs restore' EXIT"), sh.includes("trap 'exit 130' INT TERM HUP")],
      [true, true]);
    check('  ...and every night-runs.tsv row records the mode',
      (sh.match(/"\$d" "\$BROWSER_MODE" >> tmp\/fm\/usage\/night-runs\.tsv/g) ?? []).length, 2);
  }

  // ── CLI ─────────────────────────────────────────────────────────────────
  {
    const p = paths();
    const cli = (...args) => run(NODE, ['lib/freemotion-browser-mode.mjs', ...args, '--config', p.configPath, '--state', p.statePath]);
    check('CLI show --mode-only prints the bare mode', cli('show', '--mode-only').trim(), 'headless');
    cli('headful', '--run', 'fm-cli');
    check('CLI headful switches the file', cli('show', '--mode-only').trim(), 'headful');
    check('CLI restore --json reports what it did',
      JSON.parse(cli('restore', '--json')), { restored: true, to: 'headless', run: 'fm-cli' });
    check('  ...and the file is the original again', readFileSync(p.configPath, 'utf-8'), CONFIG);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
