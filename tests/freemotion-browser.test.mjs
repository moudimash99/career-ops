// tests/freemotion-browser.test.mjs — the file-based browser helpers and the
// overnight runner stay in step with lib/ and stay free of personal data.
//
// Two ways this folder rots, both silent:
//   - the page scripts are GENERATED from lib/freemotion-inventory.mjs and
//     lib/freemotion-validate.mjs; a fix made in lib/ without a rebuild never
//     reaches a live run (this is how the old tmp/ copies worked);
//   - the repo is public, and the overnight sheet template once carried the
//     candidate's phone, address and email inline.
//
// Run: node test-all.mjs --only freemotion-browser

import { pass, fail, ROOT } from './helpers.mjs';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nfreemotion-browser — generated page scripts and overnight runner');

const { staleFiles, GENERATED, render } =
  await import(pathToFileURL(join(ROOT, 'lib/freemotion-browser/build.mjs')).href);

// ------------------------------------------------ generated files match lib/

const stale = staleFiles();
if (stale.length === 0) pass('generated page scripts match lib/');
else fail(`out of date: ${stale.join(', ')} — run node lib/freemotion-browser/build.mjs`);

for (const entry of GENERATED) {
  const text = render(entry);
  if (text.includes(`window.${entry.global} = () => {`)) pass(`${entry.file} assigns window.${entry.global}`);
  else fail(`${entry.file} does not assign window.${entry.global} to a function`);
}

// ------------------------------------------------ helpers use repo-relative paths

const BROWSER_DIR = join(ROOT, 'lib/freemotion-browser');
const helpers = readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('-global.js'));
for (const file of helpers) {
  const text = readFileSync(join(BROWSER_DIR, file), 'utf-8');
  if (/[A-Za-z]:[\\/]|\btmp\//.test(text)) fail(`${file} points at an absolute path or tmp/`);
  else pass(`${file} uses repo-relative paths only`);
}

// ------------------------------------------------ no personal data in public files

const NIGHT_DIR = join(ROOT, 'freemotion-night');
const EMAIL = /[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/;
const PHONE = /\+\d{2}[\s\d]{8,}/;
// One level of sub-folders too (freemotion-night/sites/: the per-site scripts).
const nightFiles = readdirSync(NIGHT_DIR, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
  ? readdirSync(join(NIGHT_DIR, e.name), { withFileTypes: true }).filter((s) => s.isFile()).map((s) => `${e.name}/${s.name}`)
  : [e.name]));
for (const file of nightFiles) {
  const text = readFileSync(join(NIGHT_DIR, file), 'utf-8');
  const hit = text.match(EMAIL) || text.match(PHONE) || text.match(/[A-Za-z]:\/Users\//);
  if (hit) fail(`freemotion-night/${file} contains personal data or a machine path: ${hit[0]}`);
  else pass(`freemotion-night/${file} carries no personal data`);
}
