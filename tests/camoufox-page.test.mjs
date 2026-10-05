// tests/camoufox-page.test.mjs — the hidden Camoufox page scripts open on a site.
//
// Offline: no browser is started. What is pinned is the decision around it:
// a machine without the (gitignored) driver config, or whose config names a
// missing program, gets null, so callers keep their plain-HTTP path; a config
// left visible by a HEADFUL=1 run still opens hidden; DataDome's page is
// recognised so callers stop instead of parsing it.
//
// Run: node test-all.mjs --only camoufox-page

import { pass, fail, rmSync, ROOT } from './helpers.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\ncamoufox-page — hidden Camoufox page for site JSON services');

const dir = mkdtempSync(join(tmpdir(), 'camoufox-page-'));
try {
  const { camoufoxLaunchOptions, isCaptchaPage } = await import(pathToFileURL(join(ROOT, 'lib/camoufox-page.mjs')).href);

  if (camoufoxLaunchOptions({ root: dir }) === null) pass('no config file: null (callers keep the plain request)');
  else fail('a missing config should give null');

  mkdirSync(join(dir, 'config'));
  const cfg = join(dir, 'config/playwright-mcp-camoufox.json');
  const write = (launchOptions) => writeFileSync(cfg, JSON.stringify({ browser: { browserName: 'firefox', launchOptions } }));

  write({ executablePath: join(dir, 'no-such-camoufox.exe'), headless: true });
  if (camoufoxLaunchOptions({ root: dir }) === null) pass('config naming a missing program: null');
  else fail('a missing executable should give null');

  writeFileSync(cfg, '{ not json');
  if (camoufoxLaunchOptions({ root: dir }) === null) pass('unreadable config: null');
  else fail('broken JSON should give null');

  // Any existing file stands in for the program; nothing is launched.
  write({ executablePath: process.execPath, headless: false, env: { CAMOU_CONFIG_1: '{}' }, firefoxUserPrefs: { a: 1 } });
  const opts = camoufoxLaunchOptions({ root: dir });
  if (opts && opts.headless === true) pass('a config left visible (HEADFUL=1) still opens hidden');
  else fail(`headless = ${opts?.headless}`);
  if (opts && opts.env?.CAMOU_CONFIG_1 === '{}' && opts.firefoxUserPrefs?.a === 1 && opts.executablePath === process.execPath) {
    pass('the disguise (env, prefs, program) is passed through unchanged');
  } else {
    fail(`launch options = ${JSON.stringify(opts)}`);
  }

  const dd = '<html lang="en"><head><title>apec.fr</title></head><body><p id="cmsg">Please enable JS and disable any ad blocker</p><script data-cfasync="false">var dd={\'rt\':\'c\',\'cid\':\'x\'}</script></body></html>';
  if (isCaptchaPage(dd)) pass('isCaptchaPage() recognises DataDome\'s bot-check page');
  else fail('the DataDome page should be recognised');
  if (!isCaptchaPage('{"resultats":[]}') && !isCaptchaPage('') && !isCaptchaPage(undefined)) pass('isCaptchaPage() leaves JSON and empty answers alone');
  else fail('JSON or empty answers flagged as CAPTCHA');
} catch (err) {
  fail(`camoufox-page suite crashed: ${err.message}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
