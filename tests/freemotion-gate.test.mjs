// tests/freemotion-gate.test.mjs — the watched run's browser gate: which actions wait for the person,
// and the plain words the watch window shows for them.
//
// What matters most is the split: every action that puts input into the page must be held, and only
// reads may pass on their own. A read wrongly held costs the person a click; an input wrongly passed
// is an action nobody approved. The words matter next: the person decides from them, so the value
// typed or chosen, and the field it goes to, must be there, and a blind pick must be flagged.
//
// Run: node test-all.mjs --only freemotion-gate

import { pass, fail, run, lastRunFailure, NODE } from './helpers.mjs';
import { describe, needsApproval, readsOnly } from '../freemotion-night/gate-describe.mjs';

console.log('\nfreemotion-gate — what waits for the person, in plain words');

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label} => ${a}, expected ${e}`);
};
const has = (label, text, part) => (String(text).includes(part) ? pass(label) : fail(`${label} => ${JSON.stringify(text)} lacks ${JSON.stringify(part)}`));

// ── held or passed ──────────────────────────────────────────────────────
for (const [tool, args] of [
  ['browser_click', { element: 'Postuler', target: 'e1' }],
  ['browser_type', { element: 'E-mail', target: 'e2', text: 'a@b.c' }],
  ['browser_select_option', { element: 'Pays', target: 'e3', values: ['France'] }],
  ['browser_file_upload', { paths: ['output/cv.pdf'] }],
  ['browser_navigate', { url: 'https://example.com' }],
  ['browser_press_key', { key: 'Enter' }],
  ['browser_tabs', { action: 'select', index: 1 }],
  ['browser_run_code_unsafe', { filename: 'lib/freemotion-browser/submit.js' }],
  ['browser_run_code_unsafe', { code: "await page.getByLabel('Ville').fill('Toulouse');" }],
  ['browser_run_code_unsafe', { code: "await page.evaluate(() => document.querySelector('#x').remove());" }],
  ['browser_evaluate', { function: "() => { document.getElementById('c').checked = true; }" }],
]) check(`held: ${tool} ${JSON.stringify(args).slice(0, 60)}`, needsApproval(tool, args), true);

for (const [tool, args] of [
  ['browser_snapshot', {}],
  ['browser_take_screenshot', {}],
  ['browser_tabs', { action: 'list' }],
  ['browser_run_code_unsafe', { filename: 'lib/freemotion-browser/check.js' }],
  ['browser_run_code_unsafe', { filename: 'lib/freemotion-browser/read-form.js' }],
  ['browser_evaluate', { function: '() => window.__fmInv.inventory' }],
  ['browser_run_code_unsafe', { code: 'return await page.evaluate(() => document.body.innerHTML);' }],
]) check(`passes: ${tool} ${JSON.stringify(args).slice(0, 60)}`, needsApproval(tool, args), false);

check('readsOnly: a keyboard press is not a read', readsOnly("await page.keyboard.press('Enter')"), false);
check('readsOnly: setting .value is not a read', readsOnly("el.value = 'x'"), false);
check('readsOnly: comparing .value is a read', readsOnly("return el.value === 'x'"), true);

// ── plain words ─────────────────────────────────────────────────────────
has('type shows the value and the field', describe('browser_type', { element: 'E-mail', text: 'me@x.fr' }).text, 'Type "me@x.fr" into "E-mail"');
has('select shows the option', describe('browser_select_option', { element: 'Pays', values: ['France'] }).text, 'Choose "France" in "Pays"');
has('upload shows the file name only', describe('browser_file_upload', { paths: ['C:/x/output/cv-me.pdf'] }).text, 'Upload the file cv-me.pdf');
{
  const d = describe('browser_run_code_unsafe', { filename: 'lib/freemotion-browser/submit.js' });
  has('submit.js reads as sending the application', d.text, 'SEND THE APPLICATION');
  check('  ...with a warning', d.warn.length > 0, true);
}
{
  const d = describe('browser_run_code_unsafe', { code: "const rqth = page.getByRole('combobox', { name: /Souhaitez-vous/i });\nawait rqth.fill('Non');\nawait page.keyboard.press('Enter');" });
  has('page code: a value typed into a field kept in a variable', d.text, 'type "Non" into "Souhaitez-vous"');
  has('  ...then the key', d.text, 'press Enter');
}
has('page code: an escaped apostrophe stays in the text',
  describe('browser_run_code_unsafe', { code: "await page.getByText('Non, je ne souhaite pas m\\'exprimer sur ce sujet').click();" }).text,
  "click \"Non, je ne souhaite pas m'exprimer sur ce sujet\"");
{
  const d = describe('browser_run_code_unsafe', { code: "await page.keyboard.press('ArrowDown');\nawait page.keyboard.press('ArrowDown');\nawait page.keyboard.press('Enter');" });
  has('arrow keys merge into one step', d.text, 'press ArrowDown, ArrowDown, Enter');
  check('  ...and are flagged as a blind pick', d.warn.some((w) => /position/.test(w)), true);
}
check('a click done with code is flagged',
  describe('browser_run_code_unsafe', { code: "await page.locator('#c').dispatchEvent('click');" }).warn.some((w) => /code instead of a real click/.test(w)), true);
check('clicking every checkbox is flagged',
  describe('browser_run_code_unsafe', { code: "const cb = page.locator('input[type=\"checkbox\"]');\nawait cb.click({ force: true });" }).warn.some((w) => /every checkbox/.test(w)), true);
{
  const d = describe('browser_click', { element_id: 'e6' });
  has('a click that names nothing says the browser will refuse it', d.text, 'the browser will refuse this request');
  check('  ...with a warning', d.warn.some((w) => /Malformed/.test(w)), true);
}

// ── record.mjs refuses what it must ─────────────────────────────────────
{
  // Refusals exit 4, which run() reports as a failure: read what it printed from lastRunFailure().
  const out = run(NODE, ['freemotion-night/record.mjs', 'fm-test', '1', 's', 'C', 'R', 'https://not-on-the-list.example/', 'Merci']);
  const f = lastRunFailure();
  has('record.mjs refuses a URL that is not on the run list', out ?? f?.stdout, 'REFUSED');
  check('  ...with exit code 4', f?.status, 4);
}
