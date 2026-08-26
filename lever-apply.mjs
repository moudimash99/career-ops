#!/usr/bin/env node
/**
 * lever-apply.mjs — Lever applier with the same verify-before-submit gate as its
 * Greenhouse and Ashby siblings.
 *
 * Difference from the other two: Lever publishes postings through
 * api.lever.co/v0/postings/{org} but does NOT publish the application form
 * schema, so the "schema" here is read from the rendered form instead. Field
 * names are stable and self-describing (`name`, `email`, `phone`, `location`,
 * `org`, `urls[LinkedIn]`, `resume`, plus `cards[...]` custom questions), which
 * makes the DOM a reliable source — but it does mean a browser has to open
 * before a job can be judged unanswerable.
 *
 * `surveysResponses[...]` blocks are Lever's optional diversity surveys. They
 * are left untouched: they are never required, and declining by omission is the
 * option that claims nothing.
 *
 * AGENTS.md flags Lever as captcha-prone. A real challenge is detected and the
 * job is skipped and logged rather than fought.
 *
 * Usage:
 *   node lever-apply.mjs --from-pipeline              # dry run
 *   node lever-apply.mjs --from-pipeline --submit
 *   node lever-apply.mjs <url> --headed
 *   node lever-apply.mjs --report
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { loadBlacklist } from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { freeTextAnswer, refuseReason, skillProbe, yearsOfExperience } from './apply-answer-engine.mjs';

const OUT_DIR = 'data/lever';
const STATE_FILE = `${OUT_DIR}/state.json`;
const LOG_FILE = `${OUT_DIR}/attempts.tsv`;
const SHOT_DIR = `${OUT_DIR}/screenshots`;
const SETTLE_MS = 900;

// ---------------------------------------------------------------- args / config

function parseArgs(argv) {
  const a = { urls: [], limit: Infinity, submit: false, headed: false, report: false, fromPipeline: false, channel: null, delay: null, profile: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--submit') a.submit = true;
    else if (v === '--from-pipeline') a.fromPipeline = true;
    else if (v === '--headed') a.headed = true;
    else if (v === '--channel') a.channel = argv[++i];
    else if (v === '--delay') a.delay = Number(argv[++i]);
    else if (v === '--profile') a.profile = true;
    else if (v === '--report') a.report = true;
    else if (v === '--urls') a.file = argv[++i];
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v.startsWith('http')) a.urls.push(v);
    else if (v.startsWith('--')) throw new Error(`unknown flag: ${v}`);
  }
  return a;
}

function loadConfig() {
  const answers = yaml.load(fs.readFileSync('config/apply-answers.yml', 'utf8'));
  const profile = yaml.load(fs.readFileSync('config/profile.yml', 'utf8'));
  const c = profile.candidate || {};
  const [first, ...rest] = (c.full_name || '').split(' ');
  if (!fs.existsSync(answers.resume)) throw new Error(`resume not found: ${answers.resume}`);
  answers.resume = path.resolve(answers.resume);
  return {
    answers,
    identity: {
      full_name: c.full_name, first_name: first, last_name: rest.join(' '),
      email: c.email, phone: c.phone,
      linkedin: c.linkedin?.startsWith('http') ? c.linkedin : `https://${c.linkedin}`,
      portfolio: c.portfolio_url, github: c.github,
    },
  };
}

const loadState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {});

function record(state, key, entry) {
  state[key] = { ...entry, at: new Date().toISOString() };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, 'timestamp\tkey\toutcome\tcompany\ttitle\tdetail\turl\n');
  const cell = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ');
  fs.appendFileSync(LOG_FILE, [state[key].at, key, entry.outcome, entry.company, entry.title, entry.detail, entry.url].map(cell).join('\t') + '\n');
}

const blacklist = loadBlacklist();
const blacklistedAs = (c) => {
  const k = normalizeCompany(c || '');
  return k && blacklist.has(k) ? blacklist.get(k).company : null;
};

function pipelineUrls(file = 'data/pipeline.md') {
  const out = [];
  let inPending = false;
  for (const line of fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')) {
    if (/^## /.test(line)) { inPending = /^## Pending/i.test(line); continue; }
    if (!inPending) continue;
    const m = line.match(/^- \[ \] (\S+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const TOKENS = { years_experience: () => String(yearsOfExperience() ?? '') };
const fillTokens = (v) => String(v).replace(/\{\{(\w+)\}\}/g, (m, k) => (TOKENS[k] ? TOKENS[k]() : m));

function parseUrl(url) {
  const m = url.match(/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  return { org: m[1], id: m[2], key: `${m[1]}/${m[2]}` };
}

async function fetchPosting({ org, id }) {
  const res = await fetch(`https://api.lever.co/v0/postings/${org}/${id}`, { signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return { dead: true };
  if (!res.ok) throw new Error(`lever api ${res.status}`);
  return await res.json();
}

// ---------------------------------------------------------------- DOM schema

/**
 * Read the rendered form into the same field shape the other appliers plan from.
 * Radio/checkbox groups collapse into one field carrying their option labels.
 */
async function readForm(page) {
  return await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    // Lever keeps the question text OUTSIDE the .application-field wrapper that
    // holds the input, as a sibling inside .application-question. Reading the
    // wrapper gave us the first option's text ("Yes") instead of the question.
    const labelFor = (el) => {
      const q = el.closest('.application-question, .application-field, li');
      const outer = el.closest('.application-question') || q;
      if (outer) {
        const copy = outer.cloneNode(true);
        for (const f of copy.querySelectorAll('.application-field, input, textarea, select')) f.remove();
        const text = clean(copy.textContent);
        if (text) return text;
      }
      return (
        clean(q?.querySelector('.application-label, .text')?.textContent) ||
        clean(el.previousElementSibling?.textContent) ||
        clean(el.getAttribute('placeholder')) ||
        clean(el.name)
      );
    };
    const groups = new Map();
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden' || !el.name) continue;
      if (/^surveysResponses/.test(el.name)) continue; // optional diversity survey
      // Lever hides a spare text input inside some groups (the "Custom" pronoun
      // box). It shares the group's name, so an unfiltered locator resolves to it
      // and the click times out.
      if (el.offsetParent === null && el.type !== 'file') continue;
      const label = labelFor(el);
      const kind =
        el.type === 'file' ? 'file'
        : el.type === 'radio' || el.type === 'checkbox' ? 'choice'
        : el.tagName === 'SELECT' ? 'select'
        : el.tagName === 'TEXTAREA' ? 'longtext'
        : 'text';
      const required = !!(el.required || el.getAttribute('aria-required') === 'true' || /✱|\*/.test(label));
      const prev = groups.get(el.name);
      if (kind === 'choice') {
        const optLabel = clean(el.closest('label')?.textContent || el.parentElement?.textContent) || clean(el.value);
        if (prev) { prev.values.push(optLabel); prev.required = prev.required || required; }
        else groups.set(el.name, { name: el.name, kind, label, required, values: [optLabel] });
        continue;
      }
      if (kind === 'select') {
        groups.set(el.name, { name: el.name, kind: 'choice', label, required, values: [...el.options].map((o) => clean(o.textContent)).filter(Boolean), isSelect: true });
        continue;
      }
      if (!prev) groups.set(el.name, { name: el.name, kind, label, required, values: [] });
    }
    return [...groups.values()];
  });
}

// ---------------------------------------------------------------- planning

function pickOption(values, wanted) {
  const list = Array.isArray(wanted) ? wanted : [wanted];
  for (const w of list) {
    const exact = values.find((v) => norm(v) === norm(w));
    if (exact) return exact;
    const loose = values.find((v) => norm(v).includes(norm(w)) || norm(w).includes(norm(v)));
    if (loose) return loose;
  }
  return null;
}

const ANYWHERE_RE = /remote|anywhere|emea|europe|worldwide|global|multiple/;
const WORK_AUTH_RE = /legally (authori[sz]ed|entitled|eligible)|able to legally work|authori[sz]ed to work|right to work|legal right to work|eligible to work|work authori[sz]ation|work permit/i;
const SPONSOR_RE = /sponsor|visa support|require .*visa|need a visa|immigration support/i;

function countryStance(posting, answers) {
  const loc = norm([posting.categories?.location, posting.country, ...(posting.categories?.allLocations ?? [])].filter(Boolean).join(' | '));
  if (!loc) return 'unknown';
  const places = (answers.authorized_places ?? answers.authorized_in).map(norm);
  if (places.some((c) => loc.includes(c))) return 'authorized';
  return ANYWHERE_RE.test(loc) ? 'ambiguous' : 'unauthorized';
}

const FIELD_IDENTITY = {
  name: 'full_name', email: 'email', phone: 'phone',
  'urls[LinkedIn]': 'linkedin', 'urls[GitHub]': 'github', 'urls[Portfolio]': 'portfolio', 'urls[Other]': 'portfolio',
};

function planAnswers(fields, posting, { answers, identity }) {
  const actions = [];
  const blockers = [];
  const stance = countryStance(posting, answers);

  for (const f of fields) {
    const add = (value, kind) => actions.push({ ...f, kind: kind ?? f.kind, value });
    const block = (why) => { if (f.required) blockers.push(`${f.label} — ${why}`); };

    if (f.kind === 'file') { if (/resume|cv/i.test(f.name + f.label)) add(answers.resume, 'file'); continue; }
    if (FIELD_IDENTITY[f.name]) {
      const v = identity[FIELD_IDENTITY[f.name]];
      if (v) add(v, 'text'); else block('no value for this identity field in config/profile.yml');
      continue;
    }
    if (f.name === 'location') { add(answers.location_city, 'text'); continue; }
    if (f.name === 'org') { add('Airbus Operations', 'text'); continue; }
    if (/^urls\[/.test(f.name)) continue; // optional extra links

    const refused = refuseReason(f.label);
    if (refused) { block(refused); continue; }

    const probe = skillProbe(f.label);
    if (probe) {
      if (f.kind === 'choice') {
        const opt = pickOption(f.values, probe);
        if (opt) { add(opt, 'choice'); continue; }
      } else { add(probe, 'text'); continue; }
    }

    if (WORK_AUTH_RE.test(f.label) && f.kind === 'choice') {
      const namesAuthorized = answers.authorized_in.some((c) => norm(f.label).includes(norm(c)));
      const eff = namesAuthorized ? 'authorized' : stance;
      if (eff !== 'authorized' && eff !== 'unauthorized') { block('job location is ambiguous for work authorisation'); continue; }
      const opt = pickOption(f.values, eff === 'authorized' ? 'Yes' : 'No');
      if (opt && !(/permanent/i.test(opt) && answers.needs_sponsorship)) { add(opt, 'choice'); continue; }
      block(`no usable option in [${f.values.join(', ')}]`);
      continue;
    }
    if (SPONSOR_RE.test(f.label) && f.kind === 'choice') {
      const already = stance === 'authorized';
      const prefs = answers.needs_sponsorship
        ? (already ? ['already relocated', 'already live in', 'Yes'] : ['would like to relocate', 'Yes'])
        : ['No'];
      const opt = pickOption(f.values, prefs);
      if (opt) add(opt, 'choice'); else block(`no option matching ${JSON.stringify(prefs)}`);
      continue;
    }

    const rule = answers.rules.find((r) => new RegExp(r.match, 'i').test(f.label));
    if (!rule || rule.skip) {
      const essay = freeTextAnswer(f.label, { allowFallback: f.kind === 'longtext' });
      if (essay && f.kind !== 'choice') { add(essay, 'text'); continue; }
      block(rule ? 'rule says skip — needs a human answer' : 'no rule matches this question');
      continue;
    }
    if (f.kind === 'choice') {
      const opt = pickOption(f.values, rule.choose || rule.answer);
      if (opt) add(opt, 'choice'); else block(`no option matching ${JSON.stringify(rule.choose || rule.answer)} in [${f.values.join(', ')}]`);
      continue;
    }
    if (!rule.answer) { block('rule has an empty answer'); continue; }
    add(fillTokens(rule.answer), 'text');
  }
  return { actions: actions.filter((a) => a.value !== '' && a.value != null), blockers, stance };
}

// ---------------------------------------------------------------- browser

// :visible matters — see readForm: some groups carry a display:none twin.
const byName = (page, name) => page.locator(`[name="${name.replace(/"/g, '\\"')}"]:visible`);
const byNameAll = (page, name) => page.locator(`[name="${name.replace(/"/g, '\\"')}"]`);

/**
 * Dismiss the cookie/consent banner if one is present.
 *
 * Lever boards render a fixed .cc-window at z-index 9999 that sits over the
 * lower half of the form. Playwright's click waits for actionability, so every
 * field under the banner timed out after 30s while looking perfectly visible.
 */
async function dismissBanners(page) {
  // CSS first: the banner is injected asynchronously, so a one-shot remove can
  // run before it exists and the next click still lands on it.
  await page
    .addStyleTag({
      content:
        '.cc-window,#onetrust-consent-sdk,#CybotCookiebotDialog,[id*="cookie-banner"],[class*="cookie-banner"]{display:none!important;pointer-events:none!important}',
    })
    .catch(() => {});
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
  const el = byName(page, name).first();
  await el.scrollIntoViewIfNeeded();
  try {
    await el.click({ timeout: 5000 });
  } catch {
    // A consent banner can be re-injected after the first sweep and will sit
    // over the lower half of the form. Clear it and force the click.
    await dismissBanners(page);
    await el.click({ force: true, timeout: 5000 });
  }
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await el.pressSequentially(String(value), { delay: 25 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(150);
}

async function chooseOption(page, field, wanted) {
  const ok = await page.evaluate(({ name, want, options }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll(`[name="${name.replace(/"/g, '\\"')}"]`)];
    if (!els.length) return 'field not in DOM';
    if (els[0].tagName === 'SELECT') {
      const opt = [...els[0].options].find((o) => clean(o.textContent) === clean(want)) ||
                  [...els[0].options].find((o) => clean(o.textContent).includes(clean(want)));
      if (!opt) return `no <option> "${want}"`;
      els[0].value = opt.value;
      els[0].dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // Radio/checkbox groups render in the same order their labels were read.
    // Only the INDEX is resolved here — the click itself is done by Playwright
    // below, because a scripted DOM click does not run the framework's change
    // handler and the form submits as if the field were never answered.
    const idx = options.findIndex((o) => clean(o) === clean(want));
    const found = idx >= 0 && els[idx] ? idx : els.findIndex((e) => clean(e.closest('label')?.textContent) === clean(want));
    if (found === -1) return `no option "${want}" among [${options.join(' / ')}]`;
    return found;
  }, { name: field.name, want: wanted, options: field.values });
  if (typeof ok === 'string') throw new Error(ok);
  if (ok !== true) {
    const input = byName(page, field.name).nth(ok);
    await input.click({ force: true });
    await page.waitForTimeout(200);
    if (!(await input.evaluate((i) => i.checked))) throw new Error(`option "${wanted}" would not stay selected`);
  }
  await page.waitForTimeout(120);
}

async function readBack(page, action) {
  return await page.evaluate(({ name, kind, options }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll(`[name="${name.replace(/"/g, '\\"')}"]`)];
    if (!els.length) return null;
    if (kind === 'file') return els[0].files?.length ? els[0].files[0].name : '';
    if (kind === 'choice') {
      if (els[0].tagName === 'SELECT') return clean(els[0].selectedOptions[0]?.textContent);
      const i = els.findIndex((e) => e.checked);
      if (i === -1) return '';
      return options[i] ?? clean(els[i].closest('label')?.textContent) ?? 'checked';
    }
    return els[0].value;
  }, { name: action.name, kind: action.kind, options: action.values ?? [] });
}

function matches(action, actual) {
  if (actual == null) return false;
  const got = norm(actual);
  if (got === '') return false;
  if (action.kind === 'file') return true;
  if (/phone/i.test(action.name)) {
    const d = (s) => String(s).replace(/\D/g, '');
    return d(got).length >= 6 && d(action.value).endsWith(d(got).slice(-6));
  }
  if (action.kind === 'choice') {
    const w = norm(action.value);
    return got === w || got.includes(w) || w.includes(got);
  }
  // Lever's location box is an autocomplete: it normalises "Toulouse, France"
  // to its own form ("Toulouse, FRA"). Match on the city, not the whole string.
  if (action.name === 'location') {
    const city = norm(String(action.value).split(',')[0]);
    return got.includes(city);
  }
  return got === norm(action.value);
}

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

async function unfilledRequired(page) {
  return await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden' || !el.name || /^surveysResponses/.test(el.name)) continue;
      const outer = el.closest('.application-question') || el.closest('.application-field, li');
      let label = clean(el.name);
      if (outer) {
        const copy = outer.cloneNode(true);
        for (const f of copy.querySelectorAll('.application-field, input, textarea, select')) f.remove();
        label = clean(copy.textContent) || label;
      }
      const required = !!(el.required || el.getAttribute('aria-required') === 'true');
      if (!required) continue;
      const filled =
        el.type === 'file' ? el.files && el.files.length
        : el.type === 'radio' || el.type === 'checkbox'
          ? [...document.querySelectorAll(`[name="${el.name.replace(/"/g, '\\"')}"]`)].some((e) => e.checked)
          : clean(el.value).length > 0;
      if (!filled) out.push(label.slice(0, 60));
    }
    return [...new Set(out)];
  });
}

async function applyOne(page, url, plan, cfg, opts) {
  const shot = async (tag) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${SHOT_DIR}/${Date.now()}_${tag}_${plan.key.replace(/\W+/g, '-')}.png`;
    await page.screenshot({ path: f, fullPage: true }).catch(() => {});
    return f;
  };

  await dismissBanners(page);

  const failures = [];
  for (const a of plan.actions) {
    try {
      if (a.kind === 'file') await byNameAll(page, a.name).first().setInputFiles(a.value);
      else if (a.kind === 'choice') await chooseOption(page, a, a.value);
      else await typeInto(page, a.name, a.value);
    } catch (e) {
      failures.push(`${a.label}: ${e.message.split('\n')[0].slice(0, 120)}`);
    }
  }

  await page.waitForTimeout(SETTLE_MS);
  const bad = [];
  for (const a of plan.actions) {
    let actual = await readBack(page, a);
    if (!matches(a, actual) && a.kind === 'text') {
      await typeInto(page, a.name, a.value).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      actual = await readBack(page, a);
    }
    if (!matches(a, actual)) bad.push(`${a.label} [${a.name}] wanted ${JSON.stringify(String(a.value).slice(0, 30))} got ${JSON.stringify(actual)}`);
  }
  if (failures.length) return { outcome: 'FILL_ERROR', detail: failures.join(' ; '), shot: await shot('FILL_ERROR') };
  if (bad.length) return { outcome: 'VERIFY_FAILED', detail: `${bad.length} field(s) did not stick: ${bad.join(' ; ')}`, shot: await shot('VERIFY_FAILED') };
  const missed = await unfilledRequired(page);
  if (missed.length) return { outcome: 'REQUIRED_MISSING', detail: `form still requires: ${missed.join(' ; ')}`, shot: await shot('REQUIRED_MISSING') };
  if (await hasCaptcha(page)) return { outcome: 'CAPTCHA', detail: 'captcha challenge present — skipped per policy', shot: await shot('CAPTCHA') };
  if (!opts.submit) return { outcome: 'READY', detail: `${plan.actions.length} field(s) verified; not submitted (dry run)`, shot: await shot('READY') };

  const btn = page.getByRole('button', { name: /submit application/i }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ timeout: 15000 });
  await page.waitForTimeout(7000);

  // Lever raises its captcha AFTER the submit click, so the pre-submit check
  // cannot see it. Per AGENTS.md the policy is to skip, not to fight it: log the
  // URL and move on. The application is NOT submitted when this fires.
  if (await hasCaptcha(page)) {
    fs.mkdirSync('output', { recursive: true });
    fs.appendFileSync('output/captcha_links.txt', `${url}
`);
    return {
      outcome: 'CAPTCHA',
      detail: 'captcha challenge raised on submit — not submitted, logged to output/captcha_links.txt',
      shot: await shot('CAPTCHA'),
    };
  }

  const verdict = await page.evaluate(() => {
    const t = document.body.innerText;
    if (/couldn.t submit|flagged as possible spam|error/i.test(t) && !/thank/i.test(t)) return { ok: false, why: 'submission rejected by the form' };
    const ok = /thank(s| you)|application (has been )?(submitted|received)|we have received|successfully/i.test(t);
    return { ok, why: ok ? clean(t) : 'no confirmation text after submit' };
    function clean(s) { return (s.trim().split(/\n/).find((l) => l.trim()) || '').slice(0, 90); }
  });
  if (verdict.ok) return { outcome: 'SUBMITTED', detail: verdict.why, shot: await shot('SUBMITTED') };
  return { outcome: 'SUBMIT_REJECTED', detail: verdict.why, shot: await shot('SUBMIT_REJECTED') };
}

// ---------------------------------------------------------------- report / main

function report() {
  if (!fs.existsSync(STATE_FILE)) return console.log('no runs yet');
  const rows = Object.entries(loadState());
  const by = {};
  const blockers = {};
  for (const [, e] of rows) {
    by[e.outcome] = (by[e.outcome] || 0) + 1;
    for (const b of e.blockers || []) { const l = b.split(' — ')[0]; blockers[l] = (blockers[l] || 0) + 1; }
  }
  console.log(`\n${rows.length} job(s) processed\n`);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  const top = Object.entries(blockers).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length) {
    console.log('\nTop unanswered questions:\n');
    for (const [l, n] of top) console.log(`  ${String(n).padStart(4)}  ${l.slice(0, 100)}`);
  }
  console.log(`\nfull log: ${LOG_FILE}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.report) return report();

  const cfg = loadConfig();
  const state = loadState();
  let urls = args.urls;
  if (args.file) urls = urls.concat(fs.readFileSync(args.file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  if (args.fromPipeline) urls = urls.concat(pipelineUrls());
  if (!urls.length) throw new Error('no urls — pass URLs, --from-pipeline, or --urls <file>');

  console.log(args.submit ? '\n*** SUBMIT MODE ***\n' : '\nDry run — nothing is submitted. Add --submit to apply.\n');
  const browser = await chromium.launch({ headless: !args.headed, ...(args.channel ? { channel: args.channel } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  let done = 0;
  // AGENTS.md: once a captcha appears, proactively skip the rest of that board
  // rather than burning attempts on it.
  const captchaBoards = new Set();

  for (const url of urls) {
    if (done >= args.limit) break;
    const parsed = parseUrl(url);
    if (!parsed) continue;
    if (state[parsed.key]) continue;
    done++;

    let posting;
    try { posting = await fetchPosting(parsed); }
    catch (e) { record(state, parsed.key, { outcome: 'API_ERROR', detail: e.message, url }); continue; }
    if (posting.dead) { console.log(`  x ${parsed.key} — posting closed`); record(state, parsed.key, { outcome: 'DEAD', detail: 'lever api 404', url }); continue; }

    const base = { company: parsed.org, title: posting.text, url, location: posting.categories?.location || '' };
    const banned = blacklistedAs(base.company);
    if (banned) { record(state, parsed.key, { ...base, outcome: 'BLACKLISTED', detail: banned }); continue; }
    if (captchaBoards.has(parsed.org)) {
      console.log(`  ~ ${parsed.org} — skipped, this board raised a captcha earlier in the run`);
      record(state, parsed.key, { ...base, outcome: 'CAPTCHA_BOARD', detail: 'board raised a captcha earlier in this run' });
      continue;
    }

    const page = await context.newPage();
    let result;
    try {
      await page.goto(url.replace(/\/apply\/?$/, '') + '/apply', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('[name="name"], [name="email"]', { timeout: 20000 });
      await dismissBanners(page);
      const fields = await readForm(page);
      const plan = { ...planAnswers(fields, posting, cfg), key: parsed.key };
      if (plan.blockers.length) {
        result = { outcome: 'UNANSWERABLE', detail: plan.blockers.join(' ; '), blockers: plan.blockers, stance: plan.stance };
      } else {
        result = await applyOne(page, url, plan, cfg, { submit: args.submit });
        result.stance = plan.stance;
      }
    } catch (e) {
      result = { outcome: 'ERROR', detail: e.message.split('\n')[0] };
    }
    await page.close().catch(() => {});

    const mark = { SUBMITTED: '✓', READY: '✓', VERIFY_FAILED: '!', CAPTCHA: '~' }[result.outcome] || '-';
    console.log(`  ${mark} ${parsed.org} — ${posting.text}\n      ${result.outcome}: ${String(result.detail).slice(0, 180)}`);
    record(state, parsed.key, { ...base, ...result });
    if (result.outcome === 'CAPTCHA') captchaBoards.add(parsed.org);

    // Space submissions out. Ashby started rejecting a run as "possible spam"
    // once submissions came back to back; no reason to find Lever's limit the
    // same way. Dry runs stay fast.
    if (args.submit && /SUBMITTED|SUBMIT_REJECTED/.test(result.outcome)) {
      const base = (args.delay ?? 90) * 1000;
      const wait = base + Math.random() * base * 0.6;
      console.log(`      pausing ${Math.round(wait / 1000)}s before the next submission`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  await browser.close();
  console.log(`\nProcessed ${done}. Run \`node lever-apply.mjs --report\` for the roll-up.\n`);
}

main().catch((e) => { console.error(`\nfatal: ${e.message}\n`); process.exit(1); });
