#!/usr/bin/env node
/**
 * greenhouse-apply.mjs — schema-first Greenhouse applier with a verify-before-submit gate.
 *
 * Why this exists: the previous heuristic filler (auto-apply-100.mjs) submitted 362
 * applications with empty required fields because Greenhouse's React form silently
 * reverts a programmatic .fill() ~500ms later. It never read the form back, so it
 * clicked Submit anyway, 345 times. Two rules follow from that:
 *
 *   1. Type into fields with real key events, then re-read them after they settle.
 *   2. Never click Submit unless every planned field verifies non-empty.
 *
 * The form schema comes from Greenhouse's public API, so required fields, custom
 * question ids and dropdown option lists are known before a browser opens. Jobs whose
 * required questions cannot be answered from config/apply-answers.yml are skipped and
 * logged — the applier never invents an answer.
 *
 * Usage:
 *   node greenhouse-apply.mjs --from-pipeline --limit 5           # dry run (default)
 *   node greenhouse-apply.mjs --from-pipeline --plan-only         # schema pass, no browser
 *   node greenhouse-apply.mjs --from-pipeline --submit            # actually applies
 *   node greenhouse-apply.mjs <url> [<url>...] --headed
 *   node greenhouse-apply.mjs --urls <file>                       # plain URL-per-line list
 *   node greenhouse-apply.mjs --report                            # ranked blocker list
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { loadBlacklist } from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { freeTextAnswer, refuseReason, yearsOfExperience } from './apply-answer-engine.mjs';

const OUT_DIR = 'data/greenhouse';
const STATE_FILE = `${OUT_DIR}/state.json`;
const LOG_FILE = `${OUT_DIR}/attempts.tsv`;
const SHOT_DIR = `${OUT_DIR}/screenshots`;

// The React form reverts programmatic writes ~500ms after they land, so every
// read-back waits past that window before believing a value.
const SETTLE_MS = 1200;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = { urls: [], limit: Infinity, submit: false, headed: false, report: false, planOnly: false, fromPipeline: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--submit') a.submit = true;
    else if (v === '--from-pipeline') a.fromPipeline = true;
    else if (v === '--plan-only') a.planOnly = true;
    else if (v === '--headed') a.headed = true;
    else if (v === '--report') a.report = true;
    else if (v === '--urls') a.file = argv[++i];
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v.startsWith('http')) a.urls.push(v);
    else if (v.startsWith('--')) throw new Error(`unknown flag: ${v}`);
  }
  return a;
}

// ---------------------------------------------------------------- config

function loadConfig() {
  const answers = yaml.load(fs.readFileSync('config/apply-answers.yml', 'utf8'));
  const profile = yaml.load(fs.readFileSync('config/profile.yml', 'utf8'));
  const c = profile.candidate || {};
  const [firstName, ...rest] = (c.full_name || '').split(' ');
  const identity = {
    first_name: firstName,
    last_name: rest.join(' '),
    email: c.email,
    phone: c.phone,
  };
  for (const [k, v] of Object.entries(identity)) {
    if (!v) throw new Error(`config/profile.yml: candidate field behind "${k}" is empty`);
  }
  if (!fs.existsSync(answers.resume)) throw new Error(`resume not found: ${answers.resume}`);
  answers.resume = path.resolve(answers.resume);
  return { answers, identity };
}

// ---------------------------------------------------------------- state

const loadState = () =>
  fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};

function saveState(state) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

function record(state, key, entry) {
  state[key] = { ...entry, at: new Date().toISOString() };
  saveState(state);
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'timestamp\tkey\toutcome\tcompany\ttitle\tdetail\turl\n');
  }
  const cell = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ');
  const row = [state[key].at, key, entry.outcome, entry.company, entry.title, entry.detail, entry.url];
  fs.appendFileSync(LOG_FILE, row.map(cell).join('\t') + '\n');
}

// ---------------------------------------------------------------- schema

/** boards.greenhouse.io/{token}/jobs/{id} and job-boards[.eu].greenhouse.io/{token}/jobs/{id} */
function parseUrl(url) {
  const m = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+)\/jobs\/(\d+)/);
  if (!m) return null;
  return { boardToken: m[1], jobId: m[2], key: `${m[1]}/${m[2]}` };
}

/**
 * Pending rows of data/pipeline.md, the scanner's own output:
 * `- [ ] {url} | {company} | {title} | {location} | posted: {date}`.
 * Non-Greenhouse hosts are left in — parseUrl drops them by design.
 * Rows under "## Needs review" are excluded: they are there precisely because
 * nobody has judged their location yet.
 */
function pipelineUrls(file = 'data/pipeline.md') {
  if (!fs.existsSync(file)) throw new Error(`${file} not found — run a scan first`);
  const lines = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n');
  const out = [];
  let inPending = false;
  for (const line of lines) {
    if (/^## /.test(line)) { inPending = /^## Pending/i.test(line); continue; }
    if (!inPending) continue;
    const m = line.match(/^- \[ \] (\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

// data/blacklist.md is the user's do-not-apply list. The applier is a separate
// entry point from the scanner, so it has to honour it independently.
const blacklist = loadBlacklist();
function blacklistedAs(company) {
  const key = normalizeCompany(company || '');
  return key && blacklist.has(key) ? blacklist.get(key).company : null;
}

async function fetchSchema({ boardToken, jobId }) {
  const api = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${jobId}?questions=true`;
  const res = await fetch(api, { signal: AbortSignal.timeout(20000) });
  if (res.status === 404 || res.status === 410) return { dead: true, status: res.status };
  if (!res.ok) throw new Error(`greenhouse api ${res.status}`);
  return await res.json();
}

// ---------------------------------------------------------------- planning

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Rule answers may carry {{years_experience}}, computed from cv.md so the number
// cannot drift away from what the CV actually shows.
const TOKENS = { years_experience: () => String(yearsOfExperience() ?? '') };
const fillTokens = (v) =>
  String(v).replace(/\{\{(\w+)\}\}/g, (m, k) => (TOKENS[k] ? TOKENS[k]() : m));

/** Match a desired answer against the option labels the schema actually offers. */
/**
 * Resolve a preference list against the options a form actually offers.
 * Each candidate is tried exactly THEN loosely before moving to the next, so a
 * low-priority exact match ("Other") cannot beat a high-priority loose one
 * ("... Careers Page").
 */
function pickOption(values, wanted) {
  const list = Array.isArray(wanted) ? wanted : [wanted];
  for (const w of list) {
    const exact = values.find((v) => norm(v.label) === norm(w));
    if (exact) return exact;
    const loose = values.find((v) => norm(v.label).includes(norm(w)) || norm(w).includes(norm(v.label)));
    if (loose) return loose;
  }
  return null;
}

const ANYWHERE_RE = /remote|anywhere|emea|europe|worldwide|global|multiple/;

/**
 * Work authorisation is the one answer that depends on the job, not the profile:
 * "authorised to work in the country of this job" is true only where the user
 * already holds the right. Ambiguous locations are refused, not guessed.
 */
function countryStance(schema, answers) {
  const parts = [schema.location?.name, ...(schema.offices || []).map((o) => o.name)];
  const loc = norm(parts.filter(Boolean).join(' | '));
  if (!loc) return 'unknown';
  // Match cities too: a posting located "Paris" names no country but is
  // plainly in one the user may work in.
  const places = (answers.authorized_places ?? answers.authorized_in).map(norm);
  const hit = places.some((c) => loc.includes(c));
  // "All France (remote)" names France and also trips the remote/anywhere test.
  // The named country is the stronger signal, so it wins.
  if (hit) return 'authorized';
  return ANYWHERE_RE.test(loc) ? 'ambiguous' : 'unauthorized';
}

const WORK_AUTH_RE = /legally (authori[sz]ed|entitled|eligible)|authori[sz]ed to work|right to work|eligible to work|work authori[sz]ation|right to work in the european union/i;
const SPONSOR_RE = /sponsor|visa support|require .*visa|immigration support/i;

/**
 * Turn the schema into a list of concrete field actions, or a list of blockers.
 * A blocker is any *required* question we cannot answer from config — the job is
 * then skipped without opening a browser.
 */
function planAnswers(schema, { answers, identity }) {
  const actions = [];
  const blockers = [];
  const stance = countryStance(schema, answers);

  for (const q of schema.questions || []) {
    const label = q.label || '';
    const field = (q.fields || [])[0];
    if (!field) continue;
    const { name, type, values = [] } = field;
    const isSelect = type === 'multi_value_single_select' || type === 'multi_value_multi_select';
    const required = !!q.required;

    const add = (value, kind) => actions.push({ name, kind: kind || (isSelect ? 'select' : 'text'), value, label, required });
    const block = (why) => { if (required) blockers.push(`${label} — ${why}`); };

    // 1. Standard identity fields, straight from the profile.
    if (identity[name] !== undefined) { add(identity[name], 'text'); continue; }
    if (type === 'input_file') {
      if (name === 'resume') add(answers.resume, 'file');
      else block('required file upload other than the resume');
      continue;
    }

    // 2. The two per-job immigration questions.
    if (WORK_AUTH_RE.test(label)) {
      if (stance === 'authorized' || stance === 'unauthorized') {
        const want = stance === 'authorized' ? 'Yes' : 'No';
        const opt = isSelect ? pickOption(values, want) : { label: want };
        if (opt) add(opt.label);
        else block(`no option matching "${want}" in [${values.map((v) => v.label).join(', ')}]`);
      } else {
        block(`job location "${schema.location?.name || 'unknown'}" is ambiguous for work authorisation`);
      }
      continue;
    }
    if (SPONSOR_RE.test(label)) {
      const want = answers.needs_sponsorship ? 'Yes' : 'No';
      const opt = isSelect ? pickOption(values, want) : { label: want };
      if (opt) add(opt.label);
      else block(`no option matching "${want}"`);
      continue;
    }

    // 3. Voluntary US EEO questions — decline, which is a real option, not a guess.
    if (answers.demographic[name]) {
      const opt = pickOption(values, answers.demographic[name]);
      if (opt) add(opt.label);
      else block('no decline-to-answer option');
      continue;
    }

    // 4. Everything else: the user's ordered rules.
    const refused = refuseReason(label);
    if (refused) { block(refused); continue; }

    const rule = answers.rules.find((r) => new RegExp(r.match, 'i').test(label));
    if (!rule || rule.skip) {
      // Textareas are essay prompts; answer them from config/apply-essays.yml,
      // which is written from cv.md and profile.yml.
      if (type === 'textarea') {
        const essay = freeTextAnswer(label);
        if (essay) { add(essay, 'text'); continue; }
      }
      block(rule ? 'rule says skip — needs a human answer' : 'no rule matches this question');
      continue;
    }
    if (isSelect) {
      const opt = pickOption(values, rule.choose || rule.answer);
      if (opt) add(opt.label);
      else block(`no option matching ${JSON.stringify(rule.choose || rule.answer)} in [${values.map((v) => v.label).join(', ')}]`);
      continue;
    }
    if (rule.answer === '' || rule.answer == null) { block('rule has an empty answer'); continue; }
    add(fillTokens(rule.answer), 'text');
  }

  return { actions: actions.filter((a) => a.value !== '' && a.value != null), blockers, stance };
}

// ---------------------------------------------------------------- browser

// CSS.escape is a browser API, not a Node one — an attribute selector needs no escaping.
const byId = (page, name) => page.locator(`[id="${name}"]`);
const shellOf = (page, name) =>
  byId(page, name).locator('xpath=ancestor::div[contains(@class,"select-shell")]');

/**
 * Type rather than fill. Greenhouse's controlled inputs discard values set through
 * the value setter (and through Playwright's .fill()) on the next React render;
 * real key events survive.
 */
/**
 * Dismiss the cookie/consent banner if one is present.
 *
 * Lever boards render a fixed .cc-window at z-index 9999 that sits over the
 * lower half of the form. Playwright's click waits for actionability, so every
 * field under the banner timed out after 30s while looking perfectly visible.
 */
async function dismissBanners(page) {
  await page.evaluate(() => {
    const kill = ['.cc-window', '#onetrust-consent-sdk', '#CybotCookiebotDialog', '[id*="cookie-banner"]', '[class*="cookie-banner"]'];
    for (const sel of kill) for (const el of document.querySelectorAll(sel)) el.remove();
  }).catch(() => {});
  for (const name of [/^dismiss$/i, /accept all/i, /^accept$/i, /agree/i, /got it/i]) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      break;
    }
  }
}

async function typeInto(page, name, value) {
  const el = byId(page, name);
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await el.pressSequentially(String(value), { delay: 15 });
  await page.keyboard.press('Tab');
}

async function selectOption(page, name, optionLabel) {
  const shell = shellOf(page, name);
  await shell.scrollIntoViewIfNeeded();
  // react-select only opens on a real click against .select__control.
  await shell.locator('.select__control').first().click();
  await page.waitForTimeout(350);
  const options = await page.evaluate((n) => {
    const sh = document.getElementById(n)?.closest('.select-shell');
    if (!sh) return [];
    return [...sh.querySelectorAll('[class*="select__option"]')].map((o) => ({ id: o.id, text: o.textContent.trim() }));
  }, name);
  const want = norm(optionLabel);
  const hit = options.find((o) => norm(o.text) === want) || options.find((o) => norm(o.text).includes(want));
  if (!hit) throw new Error(`option "${optionLabel}" not in menu [${options.map((o) => o.text).join(', ')}]`);
  await byId(page, hit.id).click();
  await page.waitForTimeout(200);
}

/**
 * Async typeahead (the Location field): type, wait for the remote suggestions,
 * then pick the closest one. Never free-texts a value the widget did not offer.
 */
async function selectTypeahead(page, name, value) {
  const el = byId(page, name);
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await el.pressSequentially(String(value).split(',')[0].trim(), { delay: 60 });
  await page.waitForFunction(
    (n) => {
      const sh = document.getElementById(n)?.closest('.select-shell');
      return !!sh && sh.querySelectorAll('[class*="select__option"]').length > 0;
    },
    name,
    { timeout: 10000 }
  );
  const options = await page.evaluate((n) => {
    const sh = document.getElementById(n)?.closest('.select-shell');
    return [...sh.querySelectorAll('[class*="select__option"]')].map((o) => ({ id: o.id, text: o.textContent.trim() }));
  }, name);
  const want = norm(value);
  const hit = options.find((o) => norm(o.text) === want) || options.find((o) => norm(o.text).startsWith(want)) || options[0];
  await byId(page, hit.id).click();
  await page.waitForTimeout(300);
}

/**
 * Ask the rendered form which required fields are still empty. The API schema
 * omits some core fields (Location, consent checkboxes), and a value that failed
 * to stick looks identical to one that was never planned — both must block.
 */
async function unfilledRequired(page) {
  return await page.evaluate(() => {
    const FILE_RE = /\.(pdf|docx?|txt|rtf)\s*$/i;
    const out = [];
    for (const el of document.querySelectorAll('[aria-required="true"]')) {
      let filled;
      if (el.closest('.select-shell')) {
        filled = !!el.closest('.select-shell').querySelector('[class*="singleValue"]');
      } else if ('value' in el && el.tagName !== 'DIV') {
        filled = (el.value || '').trim().length > 0;
      } else {
        // An upload container: the input disappears once the file is attached, so
        // the rendered filename chip is the only evidence left.
        const input = el.querySelector('input[type="file"]');
        filled = (input && input.files.length > 0) || FILE_RE.test(el.textContent || '');
      }
      if (filled) continue;
      const label =
        document.querySelector(`label[for="${el.id}"]`)?.textContent.trim() ||
        el.getAttribute('aria-label') ||
        el.closest('[class*="field"], .file-upload')?.previousElementSibling?.textContent.trim() ||
        el.id ||
        '(unnamed)';
      out.push(label.replace(/\*$/, '').slice(0, 60));
    }
    return [...new Set(out)];
  });
}

/** Read a field back the way a reviewer would see it, after the revert window. */
async function readBack(page, action) {
  const expect = action.kind === 'file' ? path.basename(action.value) : null;
  return await page.evaluate(({ name, kind, expect }) => {
    const el = document.getElementById(name);
    // Once an upload settles, Greenhouse drops the file input and renders the
    // filename as a chip instead, so an absent input is not proof of failure.
    if (kind === 'file') {
      if (el && el.files && el.files.length) return el.files[0].name;
      const chip = [...document.querySelectorAll('*')]
        .find((n) => !n.children.length && n.textContent.trim() === expect);
      return chip ? expect : '';
    }
    if (!el) return null;
    if (kind === 'select' || kind === 'typeahead') {
      const sv = el.closest('.select-shell')?.querySelector('[class*="singleValue"]');
      return sv ? sv.textContent.trim() : '';
    }
    return el.value;
  }, { name: action.name, kind: action.kind, expect });
}

function matches(action, actual) {
  if (actual == null) return false;
  if (action.kind === 'file') return actual.length > 0;
  if (action.kind === 'select' || action.kind === 'typeahead') {
    return norm(actual) === norm(action.value) || norm(actual).includes(norm(action.value)) || norm(action.value).includes(norm(actual));
  }
  // Phone widgets reformat (drop the +33, regroup the spaces), so compare digits.
  if (action.name === 'phone') {
    const digits = (s) => String(s).replace(/\D/g, '');
    const got = digits(actual);
    return got.length >= 6 && digits(action.value).endsWith(got.slice(-6));
  }
  return norm(actual) === norm(action.value);
}

/**
 * Only a challenge the user must solve counts. reCAPTCHA v3 always renders an
 * anchor iframe inside a ~256x60 .grecaptcha-badge and scores silently; treating
 * that as a captcha skipped every Ashby form on the board. The interactive popup
 * is the bframe, and hCaptcha/Turnstile widgets have real dimensions.
 */
async function hasCaptcha(page) {
  return await page.evaluate(() => {
    // offsetParent is null for position:fixed elements, which is exactly what a
    // captcha overlay is — using it as the visibility test made this never fire.
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && r.width > 100 && r.height > 100;
    };
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || '';
      if (/\/recaptcha\/api2\/bframe/.test(src) && visible(f)) return true;
      if (/hcaptcha|challenges\.cloudflare\.com/.test(src) && visible(f)) return true;
    }
    return false;
  });
}

async function applyOne(page, url, plan, cfg, opts) {
  const shot = async (tag) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${SHOT_DIR}/${Date.now()}_${tag}_${plan.key.replace(/\W+/g, '-')}.png`;
    await page.screenshot({ path: f, fullPage: true }).catch(() => {});
    return f;
  };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForSelector('#first_name, input[name="first_name"]', { timeout: 20000 });
    await dismissBanners(page);
  } catch {
    return { outcome: 'NO_FORM', detail: 'application form never hydrated (closed posting or non-standard board)' };
  }

  // Greenhouse's core "Location (City)" typeahead is required on some boards but is
  // absent from the API schema, so it has to be picked up from the live DOM.
  const actions = plan.actions.slice();
  if (await byId(page, 'candidate-location').count()) {
    if (cfg.answers.location_city) {
      actions.push({ name: 'candidate-location', kind: 'typeahead', value: cfg.answers.location_city, label: 'Location (City)', required: true });
    } else {
      return { outcome: 'UNANSWERABLE', detail: 'form requires Location (City) but location_city is not set in config/apply-answers.yml' };
    }
  }

  const failures = [];
  for (const action of actions) {
    try {
      if (action.kind === 'file') await byId(page, action.name).setInputFiles(action.value);
      else if (action.kind === 'select') await selectOption(page, action.name, action.value);
      else if (action.kind === 'typeahead') await selectTypeahead(page, action.name, action.value);
      else await typeInto(page, action.name, action.value);
    } catch (e) {
      failures.push(`${action.label}: ${e.message.split('\n')[0]}`);
    }
  }

  // THE GATE. Nothing below this point runs on an unverified form.
  await page.waitForTimeout(SETTLE_MS);
  const empty = [];
  for (const action of actions) {
    let actual = await readBack(page, action);
    if (!matches(action, actual) && action.kind === 'text') {
      // One retry: a re-render can land between the write and the settle window.
      await typeInto(page, action.name, action.value).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      actual = await readBack(page, action);
    }
    if (!matches(action, actual)) {
      empty.push(`${action.label} [${action.name}] wanted ${JSON.stringify(String(action.value).slice(0, 40))} got ${JSON.stringify(actual)}`);
    }
  }

  if (failures.length) {
    return { outcome: 'FILL_ERROR', detail: failures.join(' ; '), shot: await shot('FILL_ERROR') };
  }
  if (empty.length) {
    return { outcome: 'VERIFY_FAILED', detail: `${empty.length} field(s) did not stick: ${empty.join(' ; ')}`, shot: await shot('VERIFY_FAILED') };
  }
  // Second half of the gate: the schema does not list every required field, so
  // ask the rendered form itself what it still considers unanswered.
  const missed = await unfilledRequired(page);
  if (missed.length) {
    return { outcome: 'REQUIRED_MISSING', detail: `form still requires: ${missed.join(' ; ')}`, shot: await shot('REQUIRED_MISSING') };
  }
  if (await hasCaptcha(page)) {
    return { outcome: 'CAPTCHA', detail: 'captcha present — form is filled, submit manually', shot: await shot('CAPTCHA') };
  }
  if (!opts.submit) {
    return { outcome: 'READY', detail: `${actions.length} field(s) verified; not submitted (dry run)`, shot: await shot('READY') };
  }

  await page.locator('button[type="submit"]').last().click();
  await page.waitForTimeout(6000);
  const confirmed = await page.evaluate(() =>
    /thank you|application (has been )?(submitted|received)|we have received/i.test(document.body.innerText)
  );
  const errs = await page.evaluate(() =>
    [...document.querySelectorAll('[class*="error"], [aria-invalid="true"]')]
      .map((e) => e.textContent.trim()).filter(Boolean).slice(0, 6)
  );
  if (confirmed && !errs.length) {
    return { outcome: 'SUBMITTED', detail: 'confirmation text found', shot: await shot('SUBMITTED') };
  }
  return {
    outcome: 'SUBMIT_UNCONFIRMED',
    detail: errs.length ? `page errors: ${errs.join(' ; ')}` : 'no confirmation text after submit',
    shot: await shot('SUBMIT_UNCONFIRMED'),
  };
}

// ---------------------------------------------------------------- plan-only

/**
 * Schema-only sweep: answers "which of these could we even apply to" without
 * opening a browser. Pure API work, so it runs concurrently.
 */
async function planOnly(urls, cfg, state) {
  const queue = urls.slice();
  let n = 0;
  const total = queue.length;

  const worker = async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      const parsed = parseUrl(url);
      if (!parsed || state[parsed.key]) continue;
      let schema;
      try {
        schema = await fetchSchema(parsed);
      } catch (e) {
        record(state, parsed.key, { outcome: 'API_ERROR', detail: e.message, url });
        continue;
      }
      const base = { company: schema.company_name || parsed.boardToken, title: schema.title, url, location: schema.location?.name || '' };
      const banned = blacklistedAs(base.company);
      if (banned) {
        record(state, parsed.key, { ...base, outcome: 'BLACKLISTED', detail: banned });
      } else if (schema.dead) {
        record(state, parsed.key, { ...base, outcome: 'DEAD', detail: `api ${schema.status}` });
      } else {
        const plan = planAnswers(schema, cfg);
        record(state, parsed.key, plan.blockers.length
          ? { ...base, outcome: 'UNANSWERABLE', detail: plan.blockers.join(' ; '), blockers: plan.blockers, stance: plan.stance }
          : { ...base, outcome: 'PLANNED', detail: `${plan.actions.length} field(s) planned`, stance: plan.stance });
      }
      if (++n % 25 === 0) process.stdout.write(`  ...${n}/${total}\n`);
    }
  };

  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`\nPlanned ${n} job(s) without a browser.\n`);
  report();
}

// ---------------------------------------------------------------- report

function report() {
  if (!fs.existsSync(STATE_FILE)) return console.log('no runs yet');
  const rows = Object.entries(loadState());
  const byOutcome = {};
  const blockers = {};
  for (const [, e] of rows) {
    byOutcome[e.outcome] = (byOutcome[e.outcome] || 0) + 1;
    for (const b of e.blockers || []) {
      const label = b.split(' — ')[0];
      blockers[label] = (blockers[label] || 0) + 1;
    }
  }
  console.log(`\n${rows.length} job(s) processed\n`);
  for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  const byStance = {};
  const byCountry = {};
  for (const [, e] of rows) {
    if (e.stance) byStance[e.stance] = (byStance[e.stance] || 0) + 1;
    if (e.location) {
      const c = e.location.split(',').pop().trim().toLowerCase() || '(none)';
      byCountry[c] = (byCountry[c] || 0) + 1;
    }
  }
  if (Object.keys(byStance).length) {
    console.log('\nWork-authorisation stance (from the job location):\n');
    for (const [k, v] of Object.entries(byStance).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
  }
  const countries = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (countries.length) {
    console.log('\nTop job locations in the queue:\n');
    for (const [k, v] of countries) console.log(`  ${String(v).padStart(4)}  ${k}`);
  }

  const top = Object.entries(blockers).sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (top.length) {
    console.log('\nTop unanswered questions — add a rule to config/apply-answers.yml to unlock these:\n');
    for (const [label, n] of top) console.log(`  ${String(n).padStart(4)}  ${label}`);
  }
  console.log(`\nfull log: ${LOG_FILE}\n`);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.report) return report();

  const cfg = loadConfig();
  const state = loadState();
  let urls = args.urls;
  if (args.file) {
    urls = urls.concat(fs.readFileSync(args.file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  }
  if (args.fromPipeline) urls = urls.concat(pipelineUrls());
  if (!urls.length) throw new Error('no urls — pass URLs, --from-pipeline, or --urls <file>');

  console.log(args.submit
    ? '\n*** SUBMIT MODE — verified applications will be sent ***\n'
    : '\nDry run — forms are filled and verified, nothing is submitted. Add --submit to apply.\n');

  if (args.planOnly) return await planOnly(urls.slice(0, args.limit), cfg, state);

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  let done = 0;

  for (const url of urls) {
    if (done >= args.limit) break;
    const parsed = parseUrl(url);
    if (!parsed) { console.log(`  ~ not a greenhouse url: ${url}`); continue; }
    if (state[parsed.key]) { console.log(`  ~ already processed (${state[parsed.key].outcome}): ${parsed.key}`); continue; }
    done++;

    let schema;
    try {
      schema = await fetchSchema(parsed);
    } catch (e) {
      console.log(`  ! ${parsed.key} — api error: ${e.message}`);
      record(state, parsed.key, { outcome: 'API_ERROR', detail: e.message, url });
      continue;
    }
    if (schema.dead) {
      console.log(`  x ${parsed.key} — posting closed (${schema.status})`);
      record(state, parsed.key, { outcome: 'DEAD', detail: `api ${schema.status}`, url });
      continue;
    }

    const label = `${schema.company_name || parsed.boardToken} — ${schema.title}`;
    const plan = { ...planAnswers(schema, cfg), key: parsed.key };
    const base = { company: schema.company_name || parsed.boardToken, title: schema.title, url, location: schema.location?.name || '' };

    const banned = blacklistedAs(base.company);
    if (banned) {
      console.log(`  x ${label}
      BLACKLISTED: ${banned} is on data/blacklist.md`);
      record(state, parsed.key, { ...base, outcome: 'BLACKLISTED', detail: banned });
      continue;
    }

    if (plan.blockers.length) {
      console.log(`  - ${label}\n      SKIP: ${plan.blockers.length} unanswerable required question(s)`);
      for (const b of plan.blockers) console.log(`        · ${b}`);
      record(state, parsed.key, { ...base, outcome: 'UNANSWERABLE', detail: plan.blockers.join(' ; '), blockers: plan.blockers });
      continue;
    }

    const page = await context.newPage();
    let result;
    try {
      result = await applyOne(page, url, plan, cfg, { submit: args.submit });
    } catch (e) {
      result = { outcome: 'ERROR', detail: e.message.split('\n')[0] };
    }
    await page.close().catch(() => {});

    const mark = { SUBMITTED: '✓', READY: '✓', VERIFY_FAILED: '!', CAPTCHA: '~' }[result.outcome] || '-';
    console.log(`  ${mark} ${label}\n      ${result.outcome}: ${result.detail}`);
    record(state, parsed.key, { ...base, ...result });
  }

  await browser.close();
  console.log(`\nProcessed ${done}. Run \`node greenhouse-apply.mjs --report\` for the roll-up.\n`);
}

main().catch((e) => { console.error(`\nfatal: ${e.message}\n`); process.exit(1); });
