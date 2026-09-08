#!/usr/bin/env node

/**
 * freemotion-engine-config.mjs — the browser-engine swap seam (§1.6/§4.7).
 *
 * ── WHY THIS IS ONE SMALL FILE AND NOT AN ABSTRACTION LAYER ───────────────
 * Every other module in this plan is browser-agnostic by construction (§1.5):
 * they parse text and return plans, and `agy` owns the only browser. So the
 * entire engine choice lives in exactly one place — the `args` array of the
 * `playwright` MCP server entry. Swapping Playwright's bundled Chromium for a
 * Camoufox build (a hardened Firefox) is therefore a config edit, not a code
 * change:
 *
 *   freemotion:
 *     browser_engine:
 *       browser: firefox
 *       executable_path: /opt/camoufox/camoufox
 *
 * then `node lib/freemotion-engine-config.mjs --apply`. Nothing else in the
 * system references the engine.
 *
 * ── FAIL FAST ON A TYPO ───────────────────────────────────────────────────
 * A misspelled `browser:` that fell back to the default would launch stock
 * Chromium against exactly the WAF-protected site the user swapped engines to
 * get past, and the run would look like Camoufox simply did not help. So an
 * unrecognized value throws instead: a config error is cheap, a silently wrong
 * engine costs a posting and misattributes the failure.
 *
 * PURE except for {@link syncMcpConfig}, which reads and atomically rewrites
 * `.mcp.json`. No browser, no network.
 *
 * Usage:
 *   node lib/freemotion-engine-config.mjs --show   [--profile path] [--mcp-config path]
 *   node lib/freemotion-engine-config.mjs --apply  [--profile path] [--mcp-config path]
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

import { flagValue, hasFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { writeFileAtomic } from '../tracker-utils.mjs';

/** Raised when the engine block is present but unusable. */
export class FreemotionEngineConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FreemotionEngineConfigError';
  }
}

/** What an absent (or partial) `freemotion.browser_engine` block resolves to. */
export const DEFAULT_ENGINE_CONFIG = {
  name: 'playwright-default',
  browser: 'chromium',
  executablePath: null,
  headless: true,
};

/** The engines `@playwright/mcp` can drive. Camoufox is a `firefox` build. */
export const VALID_BROWSERS = ['chromium', 'firefox', 'webkit'];

/**
 * The fixed head of the MCP server's argv. Never derived from config — it
 * names the package to run, which no engine swap changes.
 */
export const MCP_ARGS_PREFIX = ['-y', '@playwright/mcp@latest'];

/** Repo root: this file lives in `lib/`, one level down. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve a possibly-relative path. `config/profile.yml` is user-layer data
 * and resolves against the data root; `.mcp.json` and `config/mcp.example.json`
 * are project files read by the CLI itself and resolve against the repo root.
 * In a default checkout the two are the same directory.
 *
 * @param {string} path
 * @param {string} base
 * @returns {string}
 */
function resolveAgainst(path, base) {
  return isAbsolute(path) ? path : join(base, path);
}

/**
 * Coerce a YAML `headless:` value. Booleans pass through; the quoted strings
 * `"true"`/`"false"` are accepted because they are an easy thing to type and
 * silently reading `"false"` as truthy would launch a headed browser on a
 * headless machine. Anything else throws, for the same fail-fast reason the
 * browser name does.
 *
 * @param {unknown} raw
 * @returns {boolean}
 * @throws {FreemotionEngineConfigError}
 */
function coerceHeadless(raw) {
  if (typeof raw === 'boolean') return raw;
  const text = String(raw).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new FreemotionEngineConfigError(
    `freemotion.browser_engine.headless must be true or false, got "${raw}"`,
  );
}

/**
 * Read `config/profile.yml -> freemotion.browser_engine`, applying
 * {@link DEFAULT_ENGINE_CONFIG} for any missing key.
 *
 * A missing profile file yields the defaults rather than an error: `--show`
 * has to work on a checkout where the user has not written a `freemotion:`
 * block yet, which is the common case.
 *
 * @param {string} [profilePath] - relative paths resolve against the data root.
 * @returns {{name: string, browser: string, executablePath: string|null, headless: boolean}}
 * @throws {FreemotionEngineConfigError} on unparseable YAML, or a `browser`
 *   outside {@link VALID_BROWSERS}.
 */
export function readEngineConfig(profilePath = 'config/profile.yml') {
  const path = resolveAgainst(String(profilePath), getCareerOpsRoot());
  if (!existsSync(path)) return { ...DEFAULT_ENGINE_CONFIG };

  let parsed;
  try {
    parsed = yaml.load(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new FreemotionEngineConfigError(`could not parse ${path}: ${err.message}`);
  }

  const block = parsed?.freemotion?.browser_engine;
  if (!block || typeof block !== 'object') return { ...DEFAULT_ENGINE_CONFIG };

  const config = { ...DEFAULT_ENGINE_CONFIG };

  if (block.name !== undefined && block.name !== null && String(block.name).trim() !== '') {
    // Informational label only — never validated, never passed to the engine.
    config.name = String(block.name).trim();
  }

  if (block.browser !== undefined && block.browser !== null && String(block.browser).trim() !== '') {
    const browser = String(block.browser).trim().toLowerCase();
    if (!VALID_BROWSERS.includes(browser)) {
      throw new FreemotionEngineConfigError(
        `freemotion.browser_engine.browser must be one of ${VALID_BROWSERS.join(', ')}, got "${block.browser}"`,
      );
    }
    config.browser = browser;
  }

  // An empty string means "engine default binary" — the shipped example uses
  // it, so it must not become an `--executable-path ''` on the command line.
  if (block.executable_path !== undefined && block.executable_path !== null) {
    const executablePath = String(block.executable_path).trim();
    config.executablePath = executablePath === '' ? null : executablePath;
  }

  if (block.headless !== undefined && block.headless !== null) {
    config.headless = coerceHeadless(block.headless);
  }

  return config;
}

/**
 * The engine-dependent tail of the MCP server's argv, appended after
 * {@link MCP_ARGS_PREFIX}.
 *
 * @param {ReturnType<typeof readEngineConfig>} engineConfig
 * @returns {string[]} e.g. firefox + executablePath set →
 *   `['--browser','firefox','--executable-path','/opt/camoufox/camoufox','--headless']`
 */
export function buildPlaywrightMcpArgs(engineConfig) {
  const config = { ...DEFAULT_ENGINE_CONFIG, ...(engineConfig ?? {}) };
  const args = ['--browser', String(config.browser)];
  if (config.executablePath) args.push('--executable-path', String(config.executablePath));
  // `@playwright/mcp` runs headed by default, so headless is a flag to add,
  // never one to negate.
  if (config.headless) args.push('--headless');
  return args;
}

/**
 * Read-modify-write `.mcp.json`, starting from `config/mcp.example.json` when
 * the target does not exist yet.
 *
 * Only `mcpServers.playwright.args` is replaced. `mcpServers.playwright.command`
 * and every other server entry are left exactly as found — a user who added a
 * second MCP server, or who runs Playwright through something other than
 * `npx`, keeps both after an engine swap.
 *
 * @param {{profilePath?: string, mcpConfigPath?: string, templatePath?: string,
 *          dryRun?: boolean}} [options]
 * @returns {{written: boolean, path: string, args: string[]}} `args` is the
 *   full argv written to the server entry, prefix included.
 * @throws {FreemotionEngineConfigError}
 */
export function syncMcpConfig({
  profilePath = 'config/profile.yml',
  mcpConfigPath = '.mcp.json',
  templatePath = 'config/mcp.example.json',
  dryRun = false,
} = {}) {
  const target = resolveAgainst(String(mcpConfigPath), REPO_ROOT);
  const template = resolveAgainst(String(templatePath), REPO_ROOT);

  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (err) {
      throw new FreemotionEngineConfigError(`could not parse ${path}: ${err.message}`);
    }
  };

  let config;
  if (existsSync(target)) config = readJson(target);
  else if (existsSync(template)) config = readJson(template);
  else config = { mcpServers: { playwright: { command: 'npx', args: [...MCP_ARGS_PREFIX] } } };

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new FreemotionEngineConfigError(`${target} is not a JSON object`);
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object') config.mcpServers = {};

  const existing = config.mcpServers.playwright;
  const server = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : { command: 'npx' };
  if (!server.command) server.command = 'npx';

  const args = [...MCP_ARGS_PREFIX, ...buildPlaywrightMcpArgs(readEngineConfig(profilePath))];
  server.args = args;
  config.mcpServers.playwright = server;

  const content = `${JSON.stringify(config, null, 2)}\n`;
  // Idempotent: re-applying an unchanged engine choice must not churn the file
  // (and must not report a write that changed nothing).
  const unchanged = existsSync(target) && readFileSync(target, 'utf-8') === content;
  const written = !dryRun && !unchanged;
  if (written) writeFileAtomic(target, content);

  return { written, path: target, args };
}

const USAGE = `Usage:
  node lib/freemotion-engine-config.mjs --show  [--profile path] [--mcp-config path] [--template path]
  node lib/freemotion-engine-config.mjs --apply [--profile path] [--mcp-config path] [--template path]

--show   compute the engine args and print them without writing — safe to run
         to preview a swap before applying it.
--apply  write mcpServers.playwright.args into .mcp.json (creating it from
         config/mcp.example.json when absent), preserving every other key.

The engine itself is chosen in config/profile.yml:

  freemotion:
    browser_engine:
      name: playwright-default   # or "camoufox" — a label only, informational
      browser: chromium          # chromium | firefox | webkit
      executable_path: ""        # empty = engine default binary
      headless: true`;

const VALUE_FLAGS = ['--profile', '--mcp-config', '--template'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--show', '--apply', '--help', '-h'];

/**
 * CLI entry.
 *
 * @returns {void}
 */
function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const show = hasFlag(argv, '--show');
  const apply = hasFlag(argv, '--apply');
  if (show === apply) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const options = {
    dryRun: show,
    ...(flagValue(argv, '--profile') ? { profilePath: flagValue(argv, '--profile') } : {}),
    ...(flagValue(argv, '--mcp-config') ? { mcpConfigPath: flagValue(argv, '--mcp-config') } : {}),
    ...(flagValue(argv, '--template') ? { templatePath: flagValue(argv, '--template') } : {}),
  };

  const engine = readEngineConfig(options.profilePath ?? 'config/profile.yml');
  const result = syncMcpConfig(options);
  console.log(JSON.stringify({ engine, ...result }, null, 2));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
