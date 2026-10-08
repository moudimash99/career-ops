#!/usr/bin/env node

/**
 * freemotion-night/sites/hellowork.mjs — the HelloWork part of ONE night job, without a model (issue #26).
 *
 *   node freemotion-night/sites/hellowork.mjs <num>              # run.sh calls this before the agent
 *   node freemotion-night/sites/hellowork.mjs <num> --dry-run    # rehearsal: fills everything, never claims, never clicks Postuler
 *   node freemotion-night/sites/hellowork.mjs --url <posting> --dry-run   # rehearsal on any posting, no sheet needed
 *   options: --root <career-ops folder> (data, browser config, node_modules; default this repo) · --headful
 *
 * WHY. HelloWork is most of the pool, and its own form is the same on every posting: name, email, a CV
 * dropdown with an upload, an optional message, "Postuler"; sometimes a second step asking for the phone.
 * An agent spends ~200k tokens a job working that page out again. This script does that part with plain
 * Playwright in the same disguised Camoufox, then hands the job to the agent through the sheet.
 *
 * WHAT IT DOES, in order: claims the job (freemotion-run.mjs, company-cap.mjs, as the sheet says),
 * opens the posting in its own signed-in profile (tmp/fm/browser-profile-hellowork; signs in with the saved
 * login when needed), fills the name, uploads THIS job's CV (the "CV:" line), pastes THIS job's letter
 * (between the LETTER markers) when there is one, checks the form, clicks "Postuler" once, answers the
 * phone step, and reads what HelloWork answers:
 *   - "Félicitations ! Votre candidature … va être transmise à …" → also checks "Mes candidatures" lists it.
 *   - "Postuler sur le site du recruteur" → the employer's own page opens; its address goes in the sheet.
 *   - "Vous avez déjà postulé à cette offre" → finalized already-applied.
 *   - "Cette offre … n'est plus disponible" → finalized errored (closed posting).
 *
 * HAND-OFF (user, 2026-10-06): ALWAYS to the agent unless 100% sure nothing is left. Not proven yet, so every
 * job that reached the form goes on to the agent, with what the script did written into the sheet between
 * the hw markers: a confirmed one only needs recording, a passed-on one continues on the employer's page, a
 * stopped one continues from where the script stopped. HW_SELF_RECORD=1 lets the script record a success
 * itself, ONLY when both the success page and "Mes candidatures" agree; off until a sample of real jobs shows
 * every such job was followed by HelloWork's "Votre candidature est arrivée" email (issue #26).
 * Anything it does not recognise (a new field, a question, an error, a CAPTCHA, a changed page) stops it
 * BEFORE "Postuler". It never submits when unsure and never clicks "Postuler" twice.
 *
 * Every attempt is a line in data/hellowork-script.tsv (for the sample above); screenshots go to
 * tmp/fm/night/hw-<num>-*.png.
 *
 * Exit codes (run.sh branches on them):
 *   0  the sheet says what the script did: the agent continues from there
 *   2  the claim was refused or the company cap is reached: nothing to do, no agent
 *   3  the script finalized the job itself (closed posting, already applied, CAPTCHA, or HW_SELF_RECORD): no agent
 *   1  could not start (no sheet, not a HelloWork link, no browser config): sheet untouched, the agent does the whole job
 */

import { execFileSync, spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { camoufoxLaunchOptions, isCaptchaPage } from '../../lib/camoufox-page.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HW_START = '<!-- hw:start -->';
export const HW_END = '<!-- hw:end -->';
const LOGIN_URL = 'https://www.hellowork.com/fr-fr/candidat/connexion-inscription.html#connexion';
const HISTORY_URL = 'https://www.hellowork.com/fr-fr/candidat/mes-candidatures.html';
const MAX_CV_BYTES = 2097152; // the upload box's own max-size
// The fields of HelloWork's own form (2026-10-07). Anything else visible in it stops the script.
const KNOWN_FIELDS = new Set(['Firstname', 'LastName', 'Email', 'JweHashResume', 'upload', 'MotivationLetter', 'cover-letter-collapse-funnel']);

// ── the sheet ─────────────────────────────────────────────────────────────

/** What the script needs from a job sheet written by make-jobs.mjs (and patched by prepare-docs.mjs). */
export function parseSheet(text) {
  const run = (text.match(/\(run (\S+), job number (\d+)\)/) ?? [])[1] ?? '';
  const num = (text.match(/\(run \S+, job number (\d+)\)/) ?? [])[1] ?? '';
  const head = text.match(/^\*\*(.+?) — (.+)\*\*,.*slug `([^`]+)`/m);
  const url = (text.match(/^ {3}(https?:\/\/\S+)/m) ?? [])[1] ?? '';
  const data = (text.split(/^## Data to use.*$/m)[1] ?? '').split(/\r?\n/).find((l) => l.includes('·')) ?? '';
  const [first = '', last = '', email = ''] = data.split('·').map((s) => s.trim());
  const intl = (data.match(/\+33[\d ]+/) ?? [''])[0].replace(/\D/g, '');
  const letter = text.match(/----- LETTER START -----\r?\n([\s\S]*?)\r?\n----- LETTER END -----/);
  return {
    run, num, url,
    company: head?.[1].trim() ?? '', role: head?.[2].trim() ?? '', slug: head?.[3] ?? '',
    first, last, email,
    phone: intl.startsWith('33') ? `0${intl.slice(2)}` : '', // HelloWork's phone box refuses "+" (sheet, "HelloWork phone step")
    cvPath: (text.match(/^CV: (.+)$/m) ?? [])[1]?.trim() ?? '',
    letter: letter ? letter[1].trim() : '',
  };
}

export const isHelloWork = (url) => /^https?:\/\/(www\.)?hellowork\.com\/fr-fr\/emplois\/\d+\.html/i.test(url);

/** The sheet with `block` between the hw markers, placed before the helper-scripts section (first thing the agent reads). */
export function withHandoff(sheet, block) {
  const body = `${HW_START}\n${block.trim()}\n${HW_END}\n\n`;
  const a = sheet.indexOf(HW_START);
  const b = sheet.indexOf(HW_END);
  if (a !== -1 && b > a) return sheet.slice(0, a) + body.trimEnd() + sheet.slice(b + HW_END.length);
  const at = sheet.search(/^## Helper scripts/m);
  return at === -1 ? `${sheet.trimEnd()}\n\n${body}` : sheet.slice(0, at) + body + sheet.slice(at);
}

export const hasHandoff = (sheet) => sheet.includes(HW_START);

const CLAIMED = '**The script already claimed this job: skip "Claim the job BEFORE opening the browser" and the company-cap check** (a second claim is refused as in-progress). Record or finalize with the posting URL below, as usual.';

/**
 * The sheet section for the agent. `r.kind`:
 *   confirmed   HelloWork showed its success message (r.text); r.history = 'listed' | 'not-listed' | 'unread'
 *   employer    passed on to the employer's site (r.employerUrl), HelloWork part sent
 *   stopped     stopped BEFORE "Postuler" (r.why); nothing sent
 *   step2       first step sent, HelloWork asks more (r.fields); application not yet saved
 *   unclear     "Postuler" was clicked and the result is not clear (r.why)
 */
export function handoffBlock(r, { num, run, url, company, role, slug }) {
  const rec = (note) => `\`node freemotion-night/record.mjs ${run} ${num} ${slug} "${company}" "${role}" "${url}" "${note}"\``;
  const lines = ['## HelloWork script: already done for this job (read this first)', CLAIMED, ''];
  const did = r.did?.length ? `What the script did: ${r.did.join('; ')}.` : '';
  switch (r.kind) {
    case 'confirmed':
      lines.push(
        `**The application was sent on HelloWork by the script.** HelloWork's page said, word for word:`,
        `> ${r.text}`,
        r.history === 'listed'
          ? `HelloWork's "Mes candidatures" page lists it as sent today.`
          : `HelloWork's "Mes candidatures" page did NOT show it (${r.history}). Open ${HISTORY_URL} (sign in with the saved hellowork.com login if asked) and look for "${r.title || role}" at ${r.employer || company}, sent today.`,
        '',
        'Your task is ONLY to record it. Do NOT open the form again and do NOT click "Postuler": that would send a second application.',
        r.history === 'listed'
          ? `Run: ${rec(r.text)}`
          : `If the page lists it, run: ${rec(r.text)}\nIf it does not, finalize \`errored\` with the note "HelloWork script saw a confirmation but Mes candidatures does not list it; check the inbox" and stop.`,
      );
      break;
    case 'employer':
      lines.push(
        '**HelloWork passes this posting on to the employer\'s own site.** The HelloWork part is done ("Postuler sur le site du recruteur" clicked). Nothing has been sent to the employer yet: the application is NOT finished until the employer\'s site confirms it.',
        `Start at the employer\'s page: ${r.employerUrl}`,
        'Do not open the HelloWork posting again. Do the rest of the task there (account, form, CV, letter, checks, submit), and record or finalize under the HelloWork posting URL below, as the sheet says.',
      );
      break;
    case 'step2':
      lines.push(
        `**HelloWork asked for more before saving the application** ("information complémentaire": ${r.fields.join(', ')}). The script does not know these questions, so the application is NOT saved yet.`,
        'Open the posting, click "Postuler" (the header button) and continue: HelloWork may show the same questions straight away. Answer them from the data below, then the usual checks and one click on "Postuler".',
      );
      break;
    case 'unclear':
      lines.push(
        `**The script clicked "Postuler" once, but the result is not clear** (${r.why}). The application MAY have been sent.`,
        `Before anything else, open ${HISTORY_URL} (sign in with the saved hellowork.com login if asked) and look for "${role}" at ${company}, sent today. Listed: record it with the page's wording. Not listed: do the task as usual. Never send it twice.`,
      );
      break;
    default: // stopped
      lines.push(
        `**The script stopped before sending anything** (${r.why}). Nothing was submitted.`,
        'Do the whole task as usual, from opening the posting.',
      );
  }
  if (did) lines.push('', did);
  return lines.join('\n');
}

/** Whole sentences dropped from the end until `text` fits `max` characters (the sheet's rule for a box with a limit). */
export function fitLetter(text, max) {
  if (!max || text.length <= max) return text;
  const parts = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text];
  while (parts.length && parts.join('').trimEnd().length > max) parts.pop();
  return parts.join('').trimEnd();
}

// ── HelloWork pages ───────────────────────────────────────────────────────

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The posting title and employer from HelloWork's success message. */
export function parseConfirmation(text) {
  const m = String(text).match(/au poste de (.+?) va être transmise à (.+?)\.(?=\s|$|['"»])/);
  return m ? { title: m[1].trim(), employer: m[2].trim() } : { title: '', employer: '' };
}

const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
export const frDay = (d) => `${String(d.getDate()).padStart(2, '0')} ${FR_MONTHS[d.getMonth()]}`;

/**
 * Is the application in the text of "Mes candidatures"? Entries end with "Voir le détail"; each holds its
 * status ("Envoyée", "En cours d'envoi", "A finaliser"), the title, the employer and "Envoyée le DD mois".
 * A native HelloWork application counts when its status is Envoyée / En cours d'envoi, sent today (or
 * yesterday, for a run across midnight).
 */
export function historyLists(pageText, { title, employer }, now = new Date()) {
  if (!title || !employer) return false;
  const days = [now, new Date(now.getTime() - 86400000)].map((d) => fold(`Envoyée le ${frDay(d)}`));
  return String(pageText).split(/Voir le détail/).some((block) => {
    const b = fold(block);
    return b.includes(fold(title)) && b.includes(fold(employer))
      && /(^| )(envoyee|en cours d'envoi)( |$)/.test(b.split(fold(title))[0])
      && days.some((d) => b.includes(d));
  });
}

/** What the page says after "Postuler", from its text and address. */
export function classifyResult({ text = '', url = '', popupUrl = '' }) {
  const t = String(text);
  const ok = t.match(/Félicitations ! Votre candidature[^\n]*/);
  if (ok) return { kind: 'confirmed', text: ok[0].trim() };
  const dup = t.match(/Vous avez déjà postulé à cette offre[^\n]*/);
  if (dup) return { kind: 'already-applied', text: dup[0].trim() };
  // HelloWork's after-application pages ("Devenez visible…", "Candidatures multiples"). The message is a
  // toast that can be gone by then (5 of ~240 agent jobs never saw it); this alone is never proof: runJob
  // also needs "Mes candidatures".
  if (/hellowork\.com\/fr-fr\/bounce\/[a-z]+\?origin=ResponseOffer/i.test(url)) return { kind: 'confirmed', text: '', bounce: url };
  if (popupUrl && !/hellowork\.com/i.test(new URL(popupUrl).hostname)) return { kind: 'employer', employerUrl: popupUrl };
  if (url && !/hellowork\.com/i.test(new URL(url).hostname)) return { kind: 'employer', employerUrl: url };
  if (/information complémentaire/i.test(t)) return { kind: 'step2' };
  if (isCaptchaPage(t) || /captcha/i.test(url)) return { kind: 'captcha' };
  return { kind: 'pending' };
}

// ── side effects (claims, records, the log) ───────────────────────────────

function nodeRun(root, args) {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const finalize = (root, job, outcome, notes) =>
  nodeRun(root, ['lib/freemotion-submissions.mjs', 'finalize', '--url', job.url, '--outcome', outcome, '--run-id', job.run, '--notes', notes]);

function logLine(root, job, r, startedAt) {
  const file = join(root, 'data/hellowork-script.tsv');
  if (!existsSync(file)) writeFileSync(file, 'num\tstarted\tseconds\trun\turl\tresult\thistory\tnote\n');
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const note = String(r.text || r.why || r.employerUrl || (r.fields || []).join(', ')).replace(/[\t\r\n]+/g, ' ').slice(0, 300);
  appendFileSync(file, [job.num || '-', new Date(startedAt).toISOString(), secs, job.run || '-', job.url, r.kind, r.history || '-', note].join('\t') + '\n');
}

// ── the browser part ──────────────────────────────────────────────────────

async function launch(root, headful) {
  const opts = camoufoxLaunchOptions({ root });
  if (!opts) throw Object.assign(new Error('no usable config/playwright-mcp-camoufox.json'), { start: true });
  const { firefox } = createRequire(join(root, 'package.json'))('playwright');
  const ctx = await firefox.launchPersistentContext(join(root, 'tmp/fm/browser-profile-hellowork'), { ...opts, headless: !headful });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(15000);
  return { ctx, page };
}

async function acceptCookies(page) {
  const b = page.getByRole('button', { name: /Tout accepter/i });
  if (await b.count()) { await b.first().click().catch(() => {}); await page.waitForTimeout(600); }
}

const headerText = (page) => page.evaluate(() => (document.querySelector('header')?.innerText || '').replace(/\s+/g, ' '));
const bodyText = (page) => page.evaluate(() => document.body?.innerText || '');

async function ensureSignedIn(root, page, back) {
  if (!/Se connecter/i.test(await headerText(page))) return true;
  const out = execFileSync(process.execPath, ['lib/freemotion-credentials.mjs', 'load', '--domain', 'hellowork.com'], { cwd: root, encoding: 'utf8' });
  let cred; try { cred = JSON.parse(out); } catch { return false; }
  if (!cred?.email || !cred?.password) return false;
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await acceptCookies(page);
  const email = page.locator('input[type="email"]:visible').first();
  const pass = page.locator('input[type="password"]:visible').first();
  if (!(await email.count()) || !(await pass.count())) return false;
  await email.fill(cred.email);
  await pass.fill(cred.password);
  await page.getByRole('button', { name: /Je me connecte/i }).locator('visible=true').first().click();
  await page.waitForTimeout(5000);
  await page.goto(back, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  return !/Se connecter/i.test(await headerText(page));
}

/** Visible fields of the apply form (#postuler), with what the script needs to judge them. */
const formFields = (page) => page.evaluate(() => {
  const root = document.querySelector('#postuler') || document;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  return [...root.querySelectorAll('input, select, textarea')]
    .filter((el) => el.type !== 'hidden' && (vis(el) || el.type === 'file' || el.type === 'checkbox'))
    .map((el) => ({
      name: el.name || el.id || '', type: el.type, required: !!el.required, visible: vis(el),
      value: el.type === 'checkbox' ? String(el.checked) : (el.value || ''),
      label: (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      readOnly: !!el.readOnly || !!el.disabled,
    }));
});

const formErrors = (page) => page.evaluate(() => {
  const root = document.querySelector('#postuler') || document;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // "_warningMessage" is a grey hint ("Maximum 2900 caractères…"), not an error: only "_error" boxes and the
  // browser's own validity count.
  const shown = [...root.querySelectorAll('[id$="_error"]')].filter(vis).map((e) => (e.innerText || '').trim()).filter(Boolean);
  const invalid = [...root.querySelectorAll('input, select, textarea')]
    .filter((el) => el.type !== 'hidden' && el.type !== 'file' && vis(el) && el.willValidate && !el.checkValidity())
    .map((el) => `${el.labels?.[0]?.innerText?.trim() || el.name}: ${el.validationMessage}`);
  return [...shown, ...invalid].slice(0, 5);
});

const cvOptions = (page) => page.evaluate(() => {
  const s = document.querySelector('#postuler select[name="JweHashResume"]');
  return s ? { values: [...s.options].map((o) => o.value), selected: s.value, text: s.selectedOptions[0]?.text?.trim() || '' } : null;
});

/** Fill the first step. Returns {did, stop?} — stop is the reason not to submit. */
async function fillForm(page, job, { external }) {
  const did = [];
  const fields = await formFields(page);
  const unknown = fields.filter((f) => f.visible && !KNOWN_FIELDS.has(f.name) && f.name !== 'emailReadonly');
  if (unknown.length) return { did, stop: `unknown field(s) in HelloWork's form: ${unknown.map((f) => f.label || f.name).join(', ')}` };
  const cgu = fields.find((f) => f.name === 'HasAcceptedCGU');
  if (cgu) return { did, stop: 'the form asks to create an account (not signed in)' };

  for (const [name, want] of [['Firstname', job.first], ['LastName', job.last]]) {
    const f = fields.find((x) => x.name === name);
    if (!f) return { did, stop: `no ${name} box` };
    if (f.value.trim() !== want) { await page.locator(`#postuler [name="${name}"]`).fill(want); did.push(`${name} set`); }
  }
  const mail = fields.find((x) => x.name === 'Email');
  if (!mail) return { did, stop: 'no Email box' };
  if (fold(mail.value) !== fold(job.email)) {
    if (mail.readOnly) return { did, stop: `the form's email is ${mail.value}, not the candidate's` };
    await page.locator('#postuler [name="Email"]').fill(job.email);
    did.push('email set');
  }

  // The CV: the real upload box, then the dropdown must select the file it just added.
  if (!job.cvPath || !existsSync(job.cvPath)) return { did, stop: `CV file not found: ${job.cvPath || '(no CV line)'}` };
  if (statSync(job.cvPath).size > MAX_CV_BYTES) return { did, stop: 'CV file over HelloWork\'s 2 MB limit' };
  const before = await cvOptions(page);
  await page.locator('#postuler input[type="file"][name="upload"]').setInputFiles(job.cvPath);
  let after = before;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    after = await cvOptions(page);
    if (after && (!before || after.values.length > before.values.length)) break;
  }
  const added = after && before ? after.values.filter((v) => !before.values.includes(v)) : after?.values ?? [];
  if (!after || !added.includes(after.selected)) return { did, stop: 'the CV upload did not show up as the selected CV' };
  did.push(`CV uploaded and selected (${after.text || basename(job.cvPath)})`);

  // The letter, word for word, only where HelloWork has its message box (not on a passed-on posting).
  if (job.letter && !external) {
    const box = page.locator('#postuler textarea[name="MotivationLetter"]');
    if (!(await box.count())) did.push('no message box on this form: letter left out');
    else {
      if (!(await page.locator('#cover-letter-collapse-funnel').isChecked())) {
        await page.locator('#postuler [data-cy="motivationFieldButton"]').click();
        await page.waitForTimeout(800);
      }
      const max = Number(await box.getAttribute('maxlength')) || 0;
      const text = fitLetter(job.letter, max);
      await box.fill(text);
      if ((await box.inputValue()) !== text) return { did, stop: 'the message box did not take the letter' };
      did.push(text === job.letter ? 'letter pasted' : `letter pasted, cut to ${max} characters`);
    }
  } else if (job.letter) did.push('passed-on posting has no message box: letter left out');

  // The check before any submit: every required visible field filled, no error under any field.
  const now = await formFields(page);
  const empty = now.filter((f) => f.required && f.visible && f.type !== 'file' && !f.value.trim());
  if (empty.length) return { did, stop: `required field(s) still empty: ${empty.map((f) => f.label || f.name).join(', ')}` };
  const errs = (await formErrors(page)).filter(Boolean);
  if (errs.length) return { did, stop: `the form shows: ${errs.join(' | ')}` };
  return { did };
}

/** Poll the page (and a new tab) after a click on "Postuler" until it says something the script knows. */
async function readResult(ctx, page, popup, ms = 25000) {
  const end = Date.now() + ms;
  let r = { kind: 'pending' };
  while (Date.now() < end) {
    await page.waitForTimeout(500); // often, so the success toast is caught before it fades
    const p = popup.page;
    if (p) {
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      // HelloWork's redirect page forwards to the employer within a few seconds.
      if (/hellowork\.com/i.test(p.url())) await p.waitForURL((u) => !/hellowork\.com/i.test(u.hostname), { timeout: 12000 }).catch(() => {});
    }
    r = classifyResult({ text: await bodyText(page).catch(() => ''), url: page.url(), popupUrl: p?.url() || '' });
    if (r.kind !== 'pending') return r;
  }
  return r;
}

/** HelloWork's phone step: only a phone box is answered; any other question goes to the agent. */
async function answerStep2(page, job) {
  const fields = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea')]
    .filter((el) => { const r = el.getBoundingClientRect(); return el.type !== 'hidden' && r.width > 0 && r.height > 0 && /^sav2_|^sav\d/.test(el.name || el.id || ''); })
    .map((el) => ({ id: el.id, name: el.name, type: el.type, label: (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || '').trim().replace(/\s+/g, ' ') })));
  if (!fields.length) return { stop: 'step 2 shown but no field found', fields: ['(unreadable)'] };
  const others = fields.filter((f) => !/t[ée]l[ée]phone/i.test(f.label));
  if (others.length || !job.phone) return { stop: 'unknown step-2 question', fields: fields.map((f) => f.label || f.name) };
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const f of fields) {
      const box = page.locator(f.id ? `[id="${f.id}"]` : `[name="${f.name}"]`);
      await box.click();
      await box.press('Control+a');
      await box.press('Delete');
      await box.pressSequentially(job.phone, { delay: 120 }); // typed key by key, as the sheet says; a set value is not registered
      await box.press('Tab');
    }
    await page.waitForTimeout(700);
    if (!/N'oubliez pas cette information/i.test(await bodyText(page))) return { fields: fields.map((f) => f.label) };
  }
  return { stop: 'HelloWork did not register the phone number', fields: ['Téléphone'] };
}

async function sentInHistory(page, conf) {
  try {
    // HelloWork can take a few seconds to list a new application (job 2483, 2026-10-08: not listed at the
    // first look, listed "En cours d'envoi" when agy looked a minute later): three looks, 3 s, 15 s, 30 s.
    for (const wait of [3000, 12000, 15000]) {
      if (wait !== 3000) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      else await page.goto(HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(wait === 3000 ? 3000 : wait);
      if (historyLists(await bodyText(page), conf)) return 'listed';
    }
    return 'not-listed';
  } catch (e) {
    return `unread: ${e.message.slice(0, 60)}`;
  }
}

/**
 * The HelloWork part of one job. Returns {exit, result}. Writes the sheet (hand-off), the log line and, for
 * final outcomes, the submissions ledger.
 */
export async function runJob(job, { root, dryRun = false, headful = false, sheetPath = '', shots = '' } = {}) {
  const startedAt = Date.now();
  const did = [];
  let submitted = false;
  const shot = async (page, tag) => { if (shots) await page.screenshot({ path: join(shots, `hw-${job.num || 'x'}-${tag}.png`) }).catch(() => {}); };
  const done = (exit, r) => {
    r.did = [...did, ...(r.did || [])];
    if (!dryRun) {
      logLine(root, job, r, startedAt);
      if (exit === 0 && sheetPath) writeFileSync(sheetPath, withHandoff(readFileSync(sheetPath, 'utf8'), handoffBlock(r, job)));
    }
    return { exit, result: r };
  };

  if (!dryRun) {
    const claim = nodeRun(root, ['freemotion-run.mjs', '--url', job.url, '--company', job.company, '--role', job.role, '--run-id', job.run]);
    if (claim.code === 2) return { exit: 2, result: { kind: 'claim-refused', why: claim.out.slice(-200) } };
    if (claim.code !== 0) return { exit: 1, result: { kind: 'claim-failed', why: claim.out.slice(-200) } };
    const cap = nodeRun(root, ['lib/company-cap.mjs', '--check', job.company]);
    if (cap.code === 3) return { exit: 2, result: { kind: 'company-cap', why: cap.out.slice(-200) } };
    did.push('claimed');
  }

  let ctx;
  try {
    const b = await launch(root, headful);
    ctx = b.ctx;
    const { page } = b;
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    await acceptCookies(page);
    if (isCaptchaPage(await page.content())) {
      if (!dryRun) finalize(root, job, 'captcha', 'HelloWork showed a CAPTCHA to the HelloWork script; nothing sent');
      return done(3, { kind: 'captcha', why: 'CAPTCHA on the posting' });
    }
    if (!(await ensureSignedIn(root, page, job.url))) return done(0, { kind: 'stopped', why: 'could not sign in to HelloWork' });
    const header = page.locator('[data-cy="applyButtonHeader"]').first();
    if (!(await header.count())) {
      const gone = (await bodyText(page)).match(/[^\n]*n'est plus disponible[^\n]*/);
      if (gone) {
        if (!dryRun) finalize(root, job, 'errored', `posting closed; HelloWork says: ${gone[0].trim()}`);
        return done(3, { kind: 'closed', text: gone[0].trim() });
      }
      await shot(page, 'no-button');
      return done(0, { kind: 'stopped', why: 'no "Postuler" button on the posting' });
    }
    // Title and employer as HelloWork shows them, to find the job in "Mes candidatures" without the message.
    const posted = await page.evaluate(() => ({
      title: document.querySelector('h1 [data-cy="jobTitle"]')?.innerText?.trim() || '',
      employer: document.querySelector('h1 a')?.innerText?.trim() || '',
    }));
    const external = /site du recruteur/i.test(await header.innerText());
    await header.click();
    const form = page.locator('#postuler select[name="JweHashResume"], #postuler input[name="upload"]').first();
    const passOn = page.locator('#postuler [data-cy="applyButton"]').first();
    await form.or(passOn).first().waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1000);

    // No HelloWork form, only "Postuler sur le site du recruteur": HelloWork's redirect opens the employer's
    // page in a new tab. That address is the agent's starting point; nothing is sent by this click.
    if (!(await form.count()) && await passOn.count()) {
      const via = await passOn.getAttribute('data-redirect-external-url-value');
      if (dryRun) return done(0, { kind: 'rehearsal', why: `passed on to the employer through ${via}; not clicked` });
      const popup = {};
      ctx.on('page', (p) => { popup.page = p; });
      await passOn.click();
      did.push('"Postuler sur le site du recruteur" clicked');
      const end = Date.now() + 25000;
      let landed = '';
      while (Date.now() < end && !landed) {
        await page.waitForTimeout(1000);
        for (const u of [popup.page?.url(), page.url()]) if (u && /^https?:/.test(u) && !/hellowork\.com/i.test(new URL(u).hostname)) landed = u;
      }
      await shot(popup.page || page, 'employer');
      return landed
        ? done(0, { kind: 'employer', employerUrl: landed })
        : done(0, { kind: 'stopped', why: `"Postuler sur le site du recruteur" did not open the employer's page (HelloWork's redirect: https://www.hellowork.com${via || ''})` });
    }

    const fill = await fillForm(page, job, { external });
    did.push(...fill.did);
    await shot(page, 'before');
    if (fill.stop) return done(0, { kind: 'stopped', why: fill.stop });
    if (dryRun) return done(0, { kind: 'rehearsal', why: `ready to click "Postuler"${external ? ' (passed on to the employer)' : ''}; not clicked` });

    // One click on "Postuler". A passed-on posting opens the employer's page in a new tab.
    const popup = {};
    ctx.on('page', (p) => { popup.page = p; });
    await page.locator('#postuler [data-cy="submitButton"]').click();
    submitted = true;
    did.push('"Postuler" clicked once');
    let r = await readResult(ctx, page, popup);

    if (r.kind === 'step2') {
      await shot(page, 'step2');
      const s2 = await answerStep2(page, job);
      if (s2.stop) return done(0, { kind: 'step2', fields: s2.fields, why: s2.stop });
      did.push('phone typed in HelloWork\'s second step');
      // Step 1's "Postuler" is still on the page during step 2 (agents' saved layouts, 2026-09): only the
      // button inside the box holding the step-2 fields may be clicked.
      const step2 = page.locator('turbo-frame:has([id^="sav2_"]), form:has([id^="sav2_"])').last();
      const go = step2.locator('button[type="submit"], button:has-text("Postuler")').locator('visible=true');
      const buttons = await go.count();
      if (buttons !== 1) return done(0, { kind: 'step2', fields: s2.fields, why: `${buttons} buttons in the step-2 box, not one` });
      await go.click();
      did.push('"Postuler" of the second step clicked once');
      r = await readResult(ctx, page, popup);
      if (r.kind === 'step2') return done(0, { kind: 'unclear', why: 'the phone step was still on screen after "Postuler"' });
    }
    await shot(popup.page || page, 'after');

    switch (r.kind) {
      case 'confirmed': {
        const fromText = parseConfirmation(r.text);
        const conf = fromText.employer ? fromText : posted;
        const history = await sentInHistory(page, conf);
        if (!r.text) {
          // Only the after-application page: the proof is "Mes candidatures", or there is none.
          if (history !== 'listed') return done(0, { kind: 'unclear', why: `HelloWork moved to ${r.bounce} without its message, and Mes candidatures does not list it (${history})` });
          r.text = `HelloWork: after Postuler, its after-application page (${r.bounce.replace(/^https:\/\/www\.hellowork\.com/, '')}); Mes candidatures lists "${conf.title}" at ${conf.employer} as sent on ${frDay(new Date())}.`;
        }
        if (process.env.HW_SELF_RECORD === '1' && history === 'listed') {
          const rec = nodeRun(root, ['freemotion-night/record.mjs', job.run, job.num, job.slug, job.company, job.role, job.url, r.text]);
          if (rec.code === 0) return done(3, { ...r, ...conf, history, recorded: true });
        }
        return done(0, { ...r, ...conf, history });
      }
      case 'already-applied':
        finalize(root, job, 'already-applied', `HelloWork says: ${r.text}`);
        return done(3, r);
      case 'employer':
        return done(0, r);
      case 'captcha':
        return done(0, { kind: 'unclear', why: 'a CAPTCHA appeared after "Postuler"' });
      default: {
        // Required questions HelloWork added to the form after "Postuler" ("Combien d'années d'expérience…",
        // "Êtes-vous mobile sur Toulouse ?", job 2475 on 2026-10-08): the browser itself refuses to send a
        // form with an empty required field, so nothing was sent. That is the second-step hand-off, not "unclear".
        const asked = await page.evaluate(() => {
          const root = document.querySelector('#postuler') || document;
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          return [...root.querySelectorAll('input, select, textarea')]
            .filter((el) => el.type !== 'hidden' && el.type !== 'file' && vis(el) && el.willValidate && !el.checkValidity())
            .map((el) => (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.name || '').trim().replace(/\s*\*$/, '').replace(/\s+/g, ' '));
        });
        if (asked.length) return done(0, { kind: 'step2', fields: asked, why: 'HelloWork added required questions; the browser did not send the form' });
        const errs = (await formErrors(page)).filter(Boolean);
        return done(0, { kind: 'unclear', why: errs.length ? `HelloWork shows: ${errs.join(' | ')}` : 'no answer from HelloWork within 25 s' });
      }
    }
  } catch (e) {
    if (e.start && dryRun) return { exit: 1, result: { kind: 'no-browser', why: e.message } };
    return done(0, submitted
      ? { kind: 'unclear', why: `script error after "Postuler": ${e.message.split('\n')[0].slice(0, 160)}` }
      : { kind: 'stopped', why: `script error: ${e.message.split('\n')[0].slice(0, 160)}` });
  } finally {
    await ctx?.close().catch(() => {});
  }
}

function arg(args, name) { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; }

async function main() {
  const args = process.argv.slice(2);
  const rootArg = arg(args, '--root');
  const root = rootArg ? resolve(rootArg) : REPO_ROOT;
  const dryRun = args.includes('--dry-run');
  const headful = args.includes('--headful');
  const shots = join(root, 'tmp/fm/night');
  mkdirSync(shots, { recursive: true });

  let job; let sheetPath = '';
  const url = arg(args, '--url');
  if (url) {
    if (!dryRun) { console.error('hellowork: --url works with --dry-run only (a real job needs its sheet)'); process.exit(1); }
    const cand = readFileSync(join(root, 'config/freemotion-candidate.md'), 'utf8');
    job = { ...parseSheet(cand), url, num: 'x', run: '-', company: '-', role: '-', slug: 'x' };
    job.cvPath = arg(args, '--cv') || join(root, 'output/cv-mohammad-machaka.pdf');
    job.letter = arg(args, '--letter') ? readFileSync(arg(args, '--letter'), 'utf8').trim() : '';
  } else {
    const num = args.find((a) => /^\d+$/.test(a));
    if (!num) { console.error('Usage: node freemotion-night/sites/hellowork.mjs <num> [--dry-run] [--root <dir>] [--headful]'); process.exit(1); }
    sheetPath = join(root, `tmp/fm/night/job-${num}.md`);
    if (!existsSync(sheetPath)) { console.error(`hellowork: no sheet ${sheetPath}`); process.exit(1); }
    const sheet = readFileSync(sheetPath, 'utf8');
    if (hasHandoff(sheet) && !dryRun) { console.log(`hellowork: job ${num} already done by the script (sheet has its section)`); process.exit(0); }
    job = parseSheet(sheet);
    if (job.cvPath && !isAbsolute(job.cvPath)) job.cvPath = join(root, job.cvPath);
  }
  if (!isHelloWork(job.url)) { console.error(`hellowork: not a HelloWork posting: ${job.url || '(none)'}`); process.exit(1); }
  if (!job.first || !job.last || !job.email) { console.error('hellowork: no candidate name/email in the sheet'); process.exit(1); }

  const { exit, result } = await runJob(job, { root, dryRun, headful, sheetPath, shots });
  const what = result.text || result.employerUrl || result.why || (result.fields || []).join(', ');
  console.log(`hellowork job ${job.num}: ${result.kind}${result.history ? ` (Mes candidatures: ${result.history})` : ''}${what ? ` — ${what}` : ''}`);
  if (result.did?.length) console.log(`  did: ${result.did.join('; ')}`);
  process.exit(exit);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error(`hellowork: ${e.message}`); process.exit(1); });
