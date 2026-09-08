// tests/freemotion-engine-config.test.mjs — the browser-engine swap seam.
//
// The assertion that matters most is the negative one: a misspelled `browser:`
// THROWS rather than falling back to the default. A silent fallback launches
// stock Chromium against exactly the WAF-protected site the user swapped to
// Camoufox to get past, and the run then reads as "Camoufox did not help"
// instead of "the config had a typo".
//
// The second is that syncMcpConfig owns exactly one key. A user with a second
// MCP server configured, or a non-npx launcher, must still have both after an
// engine swap — this file is the CLI's own config, not ours to rewrite.
//
// Run: node test-all.mjs --only freemotion-engine-config

import { pass, fail, run, rmSync, NODE, ROOT } from './helpers.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-engine-config — browser-engine swap seam');

const {
  readEngineConfig, buildPlaywrightMcpArgs, syncMcpConfig,
  DEFAULT_ENGINE_CONFIG, VALID_BROWSERS, MCP_ARGS_PREFIX, FreemotionEngineConfigError,
} = await import(pathToFileURL(join(ROOT, 'lib/freemotion-engine-config.mjs')).href);

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};
const throws = (label, fn, ErrorType) => {
  try { fn(); fail(`${label} => did not throw`); } catch (err) {
    if (err instanceof ErrorType) pass(label);
    else fail(`${label} => threw ${err?.name}: ${err?.message}`);
  }
};

const tmp = mkdtempSync(join(tmpdir(), 'fm-engine-'));
const profile = (name, body) => {
  const path = join(tmp, `${name}.yml`);
  writeFileSync(path, body);
  return path;
};

// ── The Camoufox swap, end to end ─────────────────────────────────────────
const camoufox = profile('camoufox', `candidate:
  full_name: Jane Q Doe
freemotion:
  browser_engine:
    name: camoufox
    browser: firefox
    executable_path: /opt/camoufox/camoufox
    headless: true
`);
const camoufoxConfig = readEngineConfig(camoufox);
check('a camoufox profile reads back as firefox + its binary', camoufoxConfig,
  { name: 'camoufox', browser: 'firefox', executablePath: '/opt/camoufox/camoufox', headless: true });
check('  ...and builds the engine args in order',
  buildPlaywrightMcpArgs(camoufoxConfig),
  ['--browser', 'firefox', '--executable-path', '/opt/camoufox/camoufox', '--headless']);

// ── Fail fast on a typo ───────────────────────────────────────────────────
const typo = profile('typo', `freemotion:
  browser_engine:
    browser: netscape
`);
throws('an unrecognized browser throws instead of falling back',
  () => readEngineConfig(typo), FreemotionEngineConfigError);
throws('  ...and so does a non-boolean headless',
  () => readEngineConfig(profile('badheadless', 'freemotion:\n  browser_engine:\n    headless: sometimes\n')),
  FreemotionEngineConfigError);
throws('  ...and unparseable YAML',
  () => readEngineConfig(profile('broken', 'freemotion:\n  browser_engine:\n   - [unclosed\n')),
  FreemotionEngineConfigError);
check('the valid set is exactly what @playwright/mcp can drive',
  VALID_BROWSERS, ['chromium', 'firefox', 'webkit']);

// ── Defaults: the common case is a profile with no freemotion block ───────
check('a profile with no freemotion block yields the defaults',
  readEngineConfig(profile('bare', 'candidate:\n  full_name: Jane Q Doe\n')), DEFAULT_ENGINE_CONFIG);
check('a profile that does not exist yields the defaults too',
  readEngineConfig(join(tmp, 'nope.yml')), DEFAULT_ENGINE_CONFIG);
check('  ...which build to plain headless chromium',
  buildPlaywrightMcpArgs(DEFAULT_ENGINE_CONFIG), ['--browser', 'chromium', '--headless']);

// A partial block keeps the defaults for whatever it does not name.
check('a partial block only overrides what it names',
  readEngineConfig(profile('partial', 'freemotion:\n  browser_engine:\n    browser: webkit\n')),
  { ...DEFAULT_ENGINE_CONFIG, browser: 'webkit' });

// The shipped example carries `executable_path: ""`. Passing that through as
// an empty `--executable-path` argument would break every default launch.
check('an empty executable_path means "engine default binary", not an empty flag',
  buildPlaywrightMcpArgs(readEngineConfig(profile('emptypath',
    'freemotion:\n  browser_engine:\n    executable_path: ""\n'))),
  ['--browser', 'chromium', '--headless']);

// headless is a flag to ADD, never one to negate — @playwright/mcp runs headed
// by default, so `--headless false` is not a thing.
check('headless: false omits the flag rather than negating it',
  buildPlaywrightMcpArgs(readEngineConfig(profile('headed',
    'freemotion:\n  browser_engine:\n    headless: false\n'))),
  ['--browser', 'chromium']);
check('  ...and the quoted string "false" is read as false, not as truthy',
  readEngineConfig(profile('quoted', 'freemotion:\n  browser_engine:\n    headless: "false"\n')).headless,
  false);

// ── syncMcpConfig owns exactly one key ────────────────────────────────────
const mcpPath = join(tmp, '.mcp.json');
writeFileSync(mcpPath, `${JSON.stringify({
  mcpServers: {
    playwright: { command: 'bunx', args: ['-y', '@playwright/mcp@latest', '--browser', 'chromium'] },
    'some-other-server': { command: 'node', args: ['server.mjs'] },
  },
  someTopLevelKey: 'preserved',
}, null, 2)}\n`);

let result = syncMcpConfig({ profilePath: camoufox, mcpConfigPath: mcpPath });
let written = JSON.parse(readFileSync(mcpPath, 'utf-8'));
check('a swap rewrites playwright args', written.mcpServers.playwright.args,
  [...MCP_ARGS_PREFIX, '--browser', 'firefox', '--executable-path', '/opt/camoufox/camoufox', '--headless']);
check('  ...and reports what it wrote', [result.written, result.args], [true, written.mcpServers.playwright.args]);
check('  ...leaves the user\'s own launcher alone', written.mcpServers.playwright.command, 'bunx');
check('  ...leaves other MCP servers alone', written.mcpServers['some-other-server'], { command: 'node', args: ['server.mjs'] });
check('  ...and leaves unrelated top-level keys alone', written.someTopLevelKey, 'preserved');

// Re-applying the same engine must not churn the file.
result = syncMcpConfig({ profilePath: camoufox, mcpConfigPath: mcpPath });
check('re-applying an unchanged engine writes nothing', result.written, false);

// --show previews without touching disk.
const beforeShow = readFileSync(mcpPath, 'utf-8');
result = syncMcpConfig({ profilePath: profile('back', 'freemotion:\n  browser_engine:\n    browser: chromium\n'),
  mcpConfigPath: mcpPath, dryRun: true });
check('dryRun computes the new args', result.args, [...MCP_ARGS_PREFIX, '--browser', 'chromium', '--headless']);
check('  ...without writing them', [result.written, readFileSync(mcpPath, 'utf-8')], [false, beforeShow]);

// A checkout with no .mcp.json starts from the shipped template.
const freshPath = join(tmp, 'fresh.mcp.json');
result = syncMcpConfig({ profilePath: camoufox, mcpConfigPath: freshPath });
written = JSON.parse(readFileSync(freshPath, 'utf-8'));
check('an absent .mcp.json is created from config/mcp.example.json',
  [result.written, written.mcpServers.playwright.command], [true, 'npx']);
check('  ...carrying the requested engine', written.mcpServers.playwright.args.slice(2),
  ['--browser', 'firefox', '--executable-path', '/opt/camoufox/camoufox', '--headless']);

// A config that has other servers but no playwright entry gains one.
const noPw = join(tmp, 'nopw.mcp.json');
writeFileSync(noPw, `${JSON.stringify({ mcpServers: { other: { command: 'node' } } }, null, 2)}\n`);
syncMcpConfig({ profilePath: camoufox, mcpConfigPath: noPw });
written = JSON.parse(readFileSync(noPw, 'utf-8'));
check('a config with no playwright entry gains one, keeping the rest',
  [written.mcpServers.playwright.command, Object.keys(written.mcpServers)], ['npx', ['other', 'playwright']]);

throws('a .mcp.json that is not JSON throws rather than being overwritten',
  () => {
    const bad = join(tmp, 'bad.mcp.json');
    writeFileSync(bad, '{ not json');
    syncMcpConfig({ profilePath: camoufox, mcpConfigPath: bad });
  }, FreemotionEngineConfigError);

// ── The shipped template is what this module expects to read ──────────────
const template = JSON.parse(readFileSync(join(ROOT, 'config/mcp.example.json'), 'utf-8'));
check('config/mcp.example.json declares a playwright server',
  [template.mcpServers.playwright.command, template.mcpServers.playwright.args.slice(0, 2)],
  ['npx', MCP_ARGS_PREFIX]);

// ── CLI: --show must work on the repo's real profile, block or not ────────
const showOut = JSON.parse(run(NODE, ['lib/freemotion-engine-config.mjs', '--show']));
check('--show runs against the real config/profile.yml',
  [VALID_BROWSERS.includes(showOut.engine.browser), showOut.written], [true, false]);
check('  ...and its args start with the fixed package prefix',
  showOut.args.slice(0, 2), MCP_ARGS_PREFIX);

// Neither flag, or both, is a usage error rather than a guess about intent.
// run() returns null on a non-zero exit rather than throwing.
check('the CLI refuses to guess with neither --show nor --apply',
  run(NODE, ['lib/freemotion-engine-config.mjs']), null);
check('  ...and refuses both at once',
  run(NODE, ['lib/freemotion-engine-config.mjs', '--show', '--apply']), null);

rmSync(tmp, { recursive: true, force: true });
