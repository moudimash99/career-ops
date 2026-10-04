#!/usr/bin/env node

/**
 * freemotion-browser-mode.mjs — hidden or visible Camoufox window, one run at a time.
 *
 * Every Free Motion driver gets its browser from ONE file: agy, `claude -p` and
 * Copilot through `.mcp.json`, codex through `.codex/config.toml`, and all of
 * them pass `--config config/playwright-mcp-camoufox.json` to the pinned
 * `@playwright/mcp`. That file carries Camoufox's disguise (the `CAMOU_CONFIG_*`
 * environment), the executable and the Firefox preferences. Switching the
 * window is therefore one value in that file, `browser.launchOptions.headless`,
 * and this module changes that value and nothing else.
 *
 * ── WHY NOT freemotion-engine-config.mjs --apply ─────────────────────────
 * `--apply` rebuilds `.mcp.json` from `config/profile.yml` as a bare
 * `--executable-path` launch, which drops the `--config` file and with it the
 * disguise (the browser then announces itself as "Camoufox"). This module never
 * touches `.mcp.json`, `.codex/config.toml` or the MCP version.
 *
 * ── WHY A TEXT EDIT AND NOT JSON.stringify ───────────────────────────────
 * The config is ~40 KB of escaped JSON with CRLF line ends. Re-serializing it
 * would rewrite every byte for a one-word change, and any formatting drift would
 * look like a disguise change in a diff. So the `true`/`false` token is swapped
 * in place, and the result is parsed and compared against the original with
 * only that key changed before anything is written.
 *
 * ── RESTORE ──────────────────────────────────────────────────────────────
 * A switch remembers the mode it replaced in a small state file
 * (`tmp/fm/browser-mode.json`). `restore` puts that mode back and deletes the
 * state. A second switch while one is pending keeps the FIRST remembered mode,
 * so restore always returns to the real default, not to the mode in between.
 * `freemotion-night/run.sh` restores at the end of a HEADFUL=1 run, on Ctrl+C,
 * and at the start of every run (a run that was killed outright left the
 * window visible).
 *
 * Each MCP server reads the file once, when it starts. A driver session starts
 * its own server per job, so a switch takes effect from the next job. A Claude
 * or agy session that is already open keeps the mode it started with; a new
 * one started during a HEADFUL=1 run opens a visible window too.
 *
 * `PLAYWRIGHT_MCP_HEADLESS` in the environment overrides the file inside
 * `@playwright/mcp` (config file < env < CLI flags), so `show` reports it.
 *
 * Usage:
 *   node lib/freemotion-browser-mode.mjs show     [--mode-only] [--json]
 *   node lib/freemotion-browser-mode.mjs headful  [--run ID] [--json]
 *   node lib/freemotion-browser-mode.mjs headless [--json]
 *   node lib/freemotion-browser-mode.mjs restore  [--json]
 *   (all take --config path and --state path, for tests)
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { isDeepStrictEqual } from 'util';

import { flagValue, hasFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { writeFileAtomic } from '../tracker-utils.mjs';

/** Raised when the config cannot be read or switched safely. */
export class FreemotionBrowserModeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FreemotionBrowserModeError';
  }
}

/** The Playwright MCP config every driver passes with `--config`. */
export const DEFAULT_CONFIG_PATH = 'config/playwright-mcp-camoufox.json';

/** What a pending switch remembers, so restore knows the mode it replaced. */
export const DEFAULT_STATE_PATH = 'tmp/fm/browser-mode.json';

export const MODES = ['headless', 'headful'];

/** Repo root: this file lives in `lib/`, one level down. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(REPO_ROOT, path);
}

/** @param {boolean} headless */
export function modeName(headless) {
  return headless ? 'headless' : 'headful';
}

function parseConfig(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new FreemotionBrowserModeError(`could not parse ${label}: ${err.message}`);
  }
}

/**
 * The `headless` value of a Playwright MCP config text.
 *
 * @param {string} raw - the config file's text.
 * @param {string} [label] - file name for error messages.
 * @returns {boolean}
 * @throws {FreemotionBrowserModeError} when the text is not JSON or
 *   `browser.launchOptions.headless` is not a boolean.
 */
export function readHeadless(raw, label = DEFAULT_CONFIG_PATH) {
  const config = parseConfig(raw, label);
  const value = config?.browser?.launchOptions?.headless;
  if (typeof value !== 'boolean') {
    throw new FreemotionBrowserModeError(
      `${label} has no boolean browser.launchOptions.headless (found ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * The same config text with only `browser.launchOptions.headless` changed.
 *
 * @param {string} raw - the config file's text.
 * @param {boolean} headless - the value to set.
 * @param {string} [label] - file name for error messages.
 * @returns {string} `raw` itself when the value is already `headless`.
 * @throws {FreemotionBrowserModeError} when the key is missing, appears more
 *   than once in the text, or the edit would change anything else.
 */
export function withHeadless(raw, headless, label = DEFAULT_CONFIG_PATH) {
  const current = readHeadless(raw, label);
  if (current === headless) return raw;

  const matches = raw.match(/"headless"\s*:\s*(true|false)/g) ?? [];
  if (matches.length !== 1) {
    // Several "headless" keys (one could sit in an env value or a nested
    // block): which one is the launch option is no longer obvious from the
    // text, and guessing wrong would change something else.
    throw new FreemotionBrowserModeError(
      `${label} has ${matches.length} "headless" keys; expected exactly one, under browser.launchOptions`,
    );
  }
  const next = raw.replace(/("headless"\s*:\s*)(true|false)/, `$1${headless}`);

  const expected = parseConfig(raw, label);
  expected.browser.launchOptions.headless = headless;
  if (!isDeepStrictEqual(parseConfig(next, label), expected)) {
    throw new FreemotionBrowserModeError(`switching ${label} would change more than headless; nothing written`);
  }
  return next;
}

function readState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (typeof state?.previous_headless === 'boolean') return state;
  } catch { /* unreadable: treated as absent below */ }
  throw new FreemotionBrowserModeError(
    `${statePath} is unreadable; check ${DEFAULT_CONFIG_PATH} by hand and delete it`,
  );
}

function readConfigText(configPath) {
  if (!existsSync(configPath)) {
    throw new FreemotionBrowserModeError(`${configPath} not found`);
  }
  return readFileSync(configPath, 'utf-8');
}

/**
 * The current mode, plus anything that would make it not what a run gets.
 *
 * @param {{configPath?: string, statePath?: string, env?: object}} [options]
 * @returns {{mode: string, headless: boolean, configPath: string,
 *   pending: object|null, envOverride: string|null}}
 */
export function showMode({ configPath = DEFAULT_CONFIG_PATH, statePath = DEFAULT_STATE_PATH, env = process.env } = {}) {
  const config = resolveFromRoot(configPath);
  const headless = readHeadless(readConfigText(config), config);
  const envOverride = env.PLAYWRIGHT_MCP_HEADLESS ?? null;
  return {
    mode: modeName(headless),
    headless,
    configPath: config,
    pending: readState(resolveFromRoot(statePath)),
    envOverride: envOverride === '' ? null : envOverride,
  };
}

/**
 * Switch the window to `mode`, remembering the mode it replaced.
 *
 * @param {{mode: 'headless'|'headful', run?: string, configPath?: string,
 *   statePath?: string, now?: Date}} options
 * @returns {{changed: boolean, from: string, to: string, pending: boolean}}
 *   `pending` is true while a remembered mode is waiting for `restore`.
 * @throws {FreemotionBrowserModeError}
 */
export function setMode({
  mode, run = null, configPath = DEFAULT_CONFIG_PATH, statePath = DEFAULT_STATE_PATH, now = new Date(),
}) {
  if (!MODES.includes(mode)) {
    throw new FreemotionBrowserModeError(`mode must be one of ${MODES.join(', ')}, got "${mode}"`);
  }
  const config = resolveFromRoot(configPath);
  const state = resolveFromRoot(statePath);
  const raw = readConfigText(config);
  const current = readHeadless(raw, config);
  const target = mode === 'headless';
  const pending = readState(state);

  if (current !== target) writeFileAtomic(config, withHeadless(raw, target, config));

  if (pending && pending.previous_headless === target) {
    // Back at the remembered mode: nothing left to restore.
    rmSync(state, { force: true });
  } else if (!pending && current !== target) {
    mkdirSync(dirname(state), { recursive: true });
    writeFileAtomic(state, `${JSON.stringify({
      previous_headless: current,
      mode,
      run,
      set_at: now.toISOString(),
    }, null, 2)}\n`);
  }

  return {
    changed: current !== target,
    from: modeName(current),
    to: mode,
    pending: existsSync(state),
  };
}

/**
 * Put back the mode a switch replaced, if a switch is pending.
 *
 * @param {{configPath?: string, statePath?: string}} [options]
 * @returns {{restored: boolean, to: string, run: string|null}}
 * @throws {FreemotionBrowserModeError}
 */
export function restoreMode({ configPath = DEFAULT_CONFIG_PATH, statePath = DEFAULT_STATE_PATH } = {}) {
  const config = resolveFromRoot(configPath);
  const state = resolveFromRoot(statePath);
  const pending = readState(state);
  if (!pending) {
    return { restored: false, to: modeName(readHeadless(readConfigText(config), config)), run: null };
  }
  const raw = readConfigText(config);
  const next = withHeadless(raw, pending.previous_headless, config);
  if (next !== raw) writeFileAtomic(config, next);
  rmSync(state, { force: true });
  return { restored: true, to: modeName(pending.previous_headless), run: pending.run ?? null };
}

const USAGE = `Usage:
  node lib/freemotion-browser-mode.mjs show     [--mode-only] [--json]
  node lib/freemotion-browser-mode.mjs headful  [--run ID] [--json]
  node lib/freemotion-browser-mode.mjs headless [--json]
  node lib/freemotion-browser-mode.mjs restore  [--json]

Hidden (headless) or visible (headful) Camoufox window for Free Motion. Changes
only "headless" in config/playwright-mcp-camoufox.json, the file every driver's
browser reads; the disguise, executable and MCP version stay as they are.

show       the current mode, a switch waiting to be restored, and an
           environment override (--mode-only prints just headless|headful)
headful    visible window from the next job on, until restore
headless   hidden window
restore    back to the mode the last switch replaced (nothing to do: says so)

For one run: HEADFUL=1 bash freemotion-night/run.sh <numbers> switches and
restores on its own.`;

const VALUE_FLAGS = ['--run', '--config', '--state'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--mode-only', '--json', '--help', '-h'];
const COMMANDS = ['show', 'headful', 'headless', 'restore'];

function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const operands = argv.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(argv[i - 1]));
  if (operands.length !== 1 || !COMMANDS.includes(operands[0])) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const command = operands[0];
  const paths = {
    ...(flagValue(argv, '--config') ? { configPath: flagValue(argv, '--config') } : {}),
    ...(flagValue(argv, '--state') ? { statePath: flagValue(argv, '--state') } : {}),
  };
  const json = hasFlag(argv, '--json');

  if (command === 'show') {
    const result = showMode(paths);
    if (hasFlag(argv, '--mode-only')) { console.log(result.mode); return; }
    if (json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`browser window: ${result.mode === 'headful' ? 'visible (headful)' : 'hidden (headless)'}`);
    if (result.pending) {
      console.log(`  switched from ${modeName(result.pending.previous_headless)} at ${result.pending.set_at}`
        + `${result.pending.run ? ` for run ${result.pending.run}` : ''}; \`restore\` puts it back`);
    }
    if (result.envOverride !== null) {
      console.log(`  PLAYWRIGHT_MCP_HEADLESS=${result.envOverride} is set and overrides the file`);
    }
    return;
  }

  if (command === 'restore') {
    const result = restoreMode(paths);
    if (json) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(result.restored
      ? `browser window: back to ${result.to}${result.run ? ` (switched for run ${result.run})` : ''}`
      : `browser window: ${result.to}, no switch to restore`);
    return;
  }

  const result = setMode({ mode: command, run: flagValue(argv, '--run') ?? null, ...paths });
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(result.changed
    ? `browser window: ${result.from} -> ${result.to}${result.pending ? ' (restore puts it back)' : ''}`
    : `browser window: already ${result.to}`);
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
