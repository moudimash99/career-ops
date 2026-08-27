#!/usr/bin/env node
/**
 * ashby-apply.mjs — schema-first Ashby applier with a verify-before-submit gate.
 *
 * Sibling of greenhouse-apply.mjs, same three rules:
 *   1. Plan every answer from the posting schema before a browser opens; a
 *      required question with no rule in config/apply-answers.yml skips the job
 *      rather than getting an invented answer.
 *   2. Fill with real key events, then read every field back.
 *   3. Never click Submit unless the form itself agrees it is complete.
 *
 * The schema comes from Ashby's own job-board GraphQL endpoint (the one the
 * posting page calls to render itself), so field paths, types, required flags
 * and option lists are known up front.
 *
 * Ashby renders more control shapes than Greenhouse, and only text/file fields
 * carry the schema `path` as a DOM id. Location, Boolean and ValueSelect fields
 * are found by matching the schema's field title against the label of a
 * `.ashby-application-form-field-entry` container:
 *
 *   String/Email/Phone/LongText  input#{path} / textarea#{path}
 *   File                         input[type=file]#{path}
 *   Location                     input[role=combobox]  (async typeahead)
 *   Boolean                      a Yes/No button pair + a hidden checkbox
 *   ValueSelect                  radio inputs, identified by adjacent label text
 *   MultiValueSelect             checkboxes, same
 *
 * Usage:
 *   node ashby-apply.mjs --from-pipeline --plan-only        # no browser
 *   node ashby-apply.mjs --from-pipeline                    # dry run, fills + verifies
 *   node ashby-apply.mjs <url> --headed
 *   node ashby-apply.mjs --from-pipeline --submit           # actually applies
 *   node ashby-apply.mjs --report
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { loadBlacklist } from './scan.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { freeTextAnswer, refuseReason, skillProbe, yearsOfExperience } from './apply-answer-engine.mjs';

const OUT_DIR = 'data/ashby';
const STATE_FILE = `${OUT_DIR}/state.json`;
const LOG_FILE = `${OUT_DIR}/attempts.tsv`;
const SHOT_DIR = `${OUT_DIR}/screenshots`;
const QUERY_FILE = 'templates/ashby-posting.graphql';

const SETTLE_MS = 1000;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const a = { urls: [], limit: Infinity, submit: false, headed: false, report: false, planOnly: false, fromPipeline: false, channel: null, delay: null, profile: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--submit') a.submit = true;
    else if (v === '--from-pipeline') a.fromPipeline = true;
    else if (v === '--plan-only') a.planOnly = true;
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

// ---------------------------------------------------------------- config / state

function loadConfig() {
  const answers = yaml.load(fs.readFileSync('config/apply-answers.yml', 'utf8'));
  const profile = yaml.load(fs.readFileSync('config/profile.yml', 'utf8'));
  const c = profile.candidate || {};
  const [firstName, ...rest] = (c.full_name || '').split(' ');
  const identity = {
    full_name: c.full_name,
    first_name: firstName,
    last_name: rest.join(' '),
    email: c.email,
    phone: c.phone,
  };
  if (!fs.existsSync(answers.resume)) throw new Error(`resume not found: ${answers.resume}`);
  answers.resume = path.resolve(answers.resume);
  return { answers, identity };
}

const loadState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {});

function record(state, key, entry) {
  state[key] = { ...entry, at: new Date().toISOString() };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, 'timestamp\tkey\toutcome\tcompany\ttitle\tdetail\turl\n');
  }
  const cell = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ');
  fs.appendFileSync(
    LOG_FILE,
    [state[key].at, key, entry.outcome, entry.company, entry.title, entry.detail, entry.url].map(cell).join('\t') + '\n'
  );
}

const blacklist = loadBlacklist();
function blacklistedAs(company) {
  const key = normalizeCompany(company || '');
  return key && blacklist.has(key) ? blacklist.get(key).company : null;
}

function pipelineUrls(file = 'data/pipeline.md') {
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

// ---------------------------------------------------------------- schema

/** https://jobs.ashbyhq.com/{org}/{uuid}[/application] */
function parseUrl(url) {
  const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  return { org: m[1], id: m[2], key: `${m[1]}/${m[2]}` };
}

async function fetchSchema({ org, id }) {
  const query = fs.readFileSync(QUERY_FILE, 'utf8');
  const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'apollographql-client-name': 'frontend_non_user' },
    body: JSON.stringify({
      operationName: 'ApiJobPosting',
      variables: { organizationHostedJobsPageName: org, jobPostingId: id },
      query,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`ashby graphql ${res.status}`);
  const j = await res.json();
  const jp = j?.data?.jobPosting;
  if (!jp) return { dead: true };
  return jp;
}

/** Flatten the section/fieldEntry tree into one ordered list of fields. */
function schemaFields(jp) {
  const out = [];
  for (const s of jp.applicationForm?.sections ?? []) {
    for (const fe of s.fieldEntries ?? []) {
      const f = fe.field ?? {};
      out.push({
        title: (f.title ?? '').trim(),
        path: f.path,
        type: f.type,
        required: !!fe.isRequired,
        values: (f.selectableValues ?? []).map((v) => v.label),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- planning

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Rule answers may carry {{years_experience}}, computed from cv.md so the number
// cannot drift away from what the CV actually shows.
const TOKENS = { years_experience: () => String(yearsOfExperience() ?? '') };
const fillTokens = (v) =>
  String(v).replace(/\{\{(\w+)\}\}/g, (m, k) => (TOKENS[k] ? TOKENS[k]() : m));

/**
 * Resolve a preference list against the options a form actually offers.
 *
 * Each candidate is tried exactly THEN loosely before moving to the next. The
 * previous version ran a full exact pass first, so a low-priority candidate with
 * an exact match beat a high-priority one with a loose match — "Other" won over
 * "Alan Careers Page" every time the form offered both.
 */
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

function countryStance(jp, answers) {
  const loc = norm([jp.locationName, ...(jp.secondaryLocationNames ?? [])].filter(Boolean).join(' | '));
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

const WORK_AUTH_RE = /legally (authori[sz]ed|entitled|eligible)|able to legally work|authori[sz]ed to work|right to work|legal right to work|eligible to work|work authori[sz]ation|work permit|right to work in the european union/i;
const SPONSOR_RE = /sponsor|visa support|require .*visa|need a visa|immigration support/i;
const IDENTITY_PATHS = {
  // _systemfield_name is deliberately absent: its label decides whether it wants
  // the full name or just the first name (see planAnswers).
  _systemfield_email: 'email',
  phone: 'phone',
  currentCompany: null, // handled by rules so the user can override it
};

// LongText is the essay type. A required one is a human's job — except where a
// rule already answers the same question a short field would have asked
// ("Where are you based?", "Salary expectations?").
const ESSAY_TYPES = new Set(['LongText']);

function planAnswers(jp, { answers, identity }) {
  const actions = [];
  const blockers = [];
  const stance = countryStance(jp, answers);

  for (const f of schemaFields(jp)) {
    const add = (value, kind) => actions.push({ ...f, kind, value });
    const block = (why) => { if (f.required) blockers.push(`${f.title} — ${why}`); };

    if (f.type === 'File') {
      if (/resume|cv/i.test(f.title) || f.path === '_systemfield_resume') add(answers.resume, 'file');
      else block('required file upload other than the resume');
      continue;
    }
    if (IDENTITY_PATHS[f.path]) { add(identity[IDENTITY_PATHS[f.path]], 'text'); continue; }
    // _systemfield_name is "Full Name" on some boards and "First name" on others
    // (Alan splits the surname into a separate custom field). Trust the label,
    // not the path — otherwise the first-name box gets "Mohammad Machaka".
    if (f.path === '_systemfield_name' || /^(full |legal |preferred )?(first |last |family |sur)?name$/i.test(f.title)) {
      const t = f.title.toLowerCase();
      const value = /first/.test(t) ? identity.first_name
        : /last|family|surname/.test(t) ? identity.last_name
        : identity.full_name;
      add(value, 'text');
      continue;
    }
    // A custom "Phone Number" question carries a uuid path, so match on the type.
    if (f.type === 'Phone' || /^phone/i.test(f.title)) { add(identity.phone, 'text'); continue; }

    // Only the schema's Location type is the async typeahead. A String field
    // merely titled "Current location" is a text box and goes through the rules.
    if (f.type === 'Location') {
      if (answers.location_city) add(answers.location_city, 'location');
      else block('form requires a location but location_city is not set');
      continue;
    }

    if (WORK_AUTH_RE.test(f.title) && f.type !== 'LongText') {
      // "...able to legally work in France, Belgium or Spain?" names the country
      // itself, which is better evidence than a posting location of "Anywhere in
      // France, Belgium, Spain" — the latter only reads as ambiguous.
      const namesAuthorized = answers.authorized_in.some((c) => norm(f.title).includes(norm(c)));
      const effective = namesAuthorized ? 'authorized' : stance;
      if (effective !== 'authorized' && effective !== 'unauthorized') {
        block(`job location "${jp.locationName || 'unknown'}" is ambiguous for work authorisation`);
        continue;
      }
      const want = effective === 'authorized' ? 'Yes' : 'No';
      if (f.type === 'Boolean') { add(want, 'boolean'); continue; }
      const opt = pickOption(f.values, want);
      if (!opt) { block(`no option matching "${want}" in [${f.values.join(', ')}]`); continue; }
      // Some boards phrase the Yes option as a *permanent* work permit. A holder
      // of a student titre de sejour who still needs the employer for a status
      // change cannot claim that, so it goes to a human instead of being guessed.
      if (/permanent/i.test(opt) && answers.needs_sponsorship) {
        block(`the only affirmative option claims a permanent work permit ("${opt.slice(0, 60)}") — confirm this yourself`);
        continue;
      }
      add(opt, 'select');
      continue;
    }
    if (SPONSOR_RE.test(f.title) && f.type !== 'LongText') {
      const want = answers.needs_sponsorship ? 'Yes' : 'No';
      if (f.type === 'Boolean') { add(want, 'boolean'); continue; }
      // "Yes - I need a visa and I would like to relocate" and "Yes - I need a
      // visa but I have already relocated" are both Yes and only one is true.
      // Picking the first Yes told Qonto the user still had to move to France.
      const alreadyThere = stance === 'authorized';
      const prefs = answers.needs_sponsorship
        ? (alreadyThere
            ? ['already relocated', 'already live in', 'but I have already', 'Yes']
            : ['would like to relocate', 'and I would like to', 'Yes'])
        : (alreadyThere ? ['already have a visa', 'already live in', 'No'] : ['No']);
      const opt = pickOption(f.values, prefs);
      if (opt) add(opt, 'select');
      else block(`no option matching ${JSON.stringify(prefs)} in [${f.values.join(', ')}]`);
      continue;
    }

    const refused = refuseReason(f.title);
    if (refused) { block(refused); continue; }

    // "Do you have experience with X?" is decided against cv.md — Yes when the
    // CV names X, No when it does not. Both are grounded; neither is a guess.
    const probe = skillProbe(f.title);
    if (probe) {
      if (f.type === 'Boolean') { add(probe, 'boolean'); continue; }
      if (f.type === 'ValueSelect' || f.type === 'MultiValueSelect') {
        const opt = pickOption(f.values, probe);
        if (opt) { add(opt, 'select'); continue; }
      } else { add(probe, 'text'); continue; }
    }

    const rule = answers.rules.find((r) => new RegExp(r.match, 'i').test(f.title));
    if (!rule || rule.skip) {
      // Free text is answerable from config/apply-essays.yml, which is written
      // from cv.md and profile.yml. Only a question with no essay match at all
      // still blocks.
      if (ESSAY_TYPES.has(f.type)) {
        const essay = freeTextAnswer(f.title);
        if (essay) { add(essay, 'text'); continue; }
        block('free-text question with no matching essay — needs a human answer');
      } else {
        // A short String box can still be a prompt ("favourite movie quote").
        // Only a SPECIFIC essay match is allowed here — never the generic
        // fallback, which would drop a career summary into a one-line field.
        if (f.type === 'String') {
          const essay = freeTextAnswer(f.title, { allowFallback: false });
          if (essay) { add(essay, 'text'); continue; }
        }
        block(rule ? 'rule says skip — needs a human answer' : 'no rule matches this question');
      }
      continue;
    }
    if (f.type === 'ValueSelect' || f.type === 'MultiValueSelect') {
      const opt = pickOption(f.values, rule.choose || rule.answer);
      if (opt) add(opt, 'select');
      else block(`no option matching ${JSON.stringify(rule.choose || rule.answer)} in [${f.values.join(', ')}]`);
      continue;
    }
    if (f.type === 'Boolean') {
      const opt = pickOption(['Yes', 'No'], rule.choose || rule.answer);
      if (opt) add(opt, 'boolean');
      else block(`rule answer is not a yes/no`);
      continue;
    }
    if (!rule.answer) { block('rule has an empty answer'); continue; }
    add(fillTokens(rule.answer), 'text');
  }

  return { actions: actions.filter((a) => a.value !== '' && a.value != null), blockers, stance };
}

// ---------------------------------------------------------------- browser

const byId = (page, id) => page.locator(`[id="${id}"]`);

/** The field container whose label matches this schema field's title. */
function entryFor(page, field) {
  if (field.path) {
    const direct = page.locator(`[id="${field.path}"]`);
    return { direct, container: null };
  }
  return { direct: null, container: null };
}

/** Locate a field's container by its rendered label, for controls with no id. */
async function containerHandle(page, title) {
  return await page.evaluateHandle((t) => {
    const clean = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\*/g, '').trim();
    const want = clean(t);
    if (!want) return null;
    const entries = [...document.querySelectorAll('[class*="ashby-application-form-field-entry"], fieldset')];
    // An entry whose label is blank (the resume drop-zone, the consent checkbox)
    // must never match: "".startsWith(anything) is false, but want.startsWith("")
    // is TRUE, so an unguarded prefix test hands every field the first blank entry.
    const scored = entries
      .map((e) => ({ e, lab: clean(e.querySelector('label, legend')?.textContent) }))
      .filter((x) => x.lab.length >= 3);
    return (
      scored.find((x) => x.lab === want)?.e ||
      scored.find((x) => x.lab.startsWith(want.slice(0, 40)))?.e ||
      scored.find((x) => want.startsWith(x.lab.slice(0, 40)))?.e ||
      null
    );
  }, title);
}

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

async function typeInto(page, id, value) {
  const el = byId(page, id);
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await el.pressSequentially(String(value), { delay: 12 });
  await page.keyboard.press('Tab');
}

/**
 * Radio/checkbox option groups. The wanted option is matched against the
 * schema's own label list rather than by loose containment: sibling options
 * routinely share a long prefix ("Yes - I need a visa and I would like to
 * relocate" vs "...but I have already relocated"), and a containment test on an
 * ancestor's text — which holds every option at once — clicks the first one.
 */
/**
 * Radio/checkbox option groups.
 *
 * The click has to come from Playwright, not from el.click() inside
 * page.evaluate. A scripted DOM click checks the input visually but does not run
 * React's change handler, so the form's own state stays empty — Ashby then
 * rejected the submit with "Missing entry for required field" on a question the
 * screenshot showed as answered. Playwright's click goes through the browser's
 * real input path and registers.
 *
 * Option identity is positional: every input in an Ashby group shares one id, so
 * label[for=...] resolves to option one for all of them.
 */
async function selectRadio(page, field, optionLabel) {
  const handle = await containerHandle(page, field.title);
  const el = handle.asElement();
  if (!el) throw new Error('no container');
  const inputs = await el.$$('input[type="radio"], input[type="checkbox"]');
  if (!inputs.length) throw new Error('no options in container');

  const options = field.values ?? [];
  let idx = options.findIndex((o) => norm(o) === norm(optionLabel));
  if (idx === -1 || inputs.length !== options.length) {
    // Fall back to the label text carried by each input.
    const labels = await el.evaluate((root) => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      return [...root.querySelectorAll('input[type="radio"], input[type="checkbox"]')].map(
        (i) => clean(i.name) || clean(i.closest('label')?.textContent) || ''
      );
    });
    idx = labels.findIndex((l) => norm(l) === norm(optionLabel));
    if (idx === -1) idx = labels.findIndex((l) => l && norm(optionLabel).startsWith(norm(l)));
  }
  if (idx === -1 || !inputs[idx]) {
    throw new Error(`no option "${optionLabel}" among [${options.join(' / ')}]`);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    // force: the inputs are visually replaced by styled markers, so the real
    // element is often zero-sized even though it is the click target React binds.
    await inputs[idx].click({ force: true }).catch(async () => {
      const label = await inputs[idx].evaluateHandle((i) => i.closest('label') ?? i.parentElement);
      await label.asElement()?.click({ force: true });
    });
    await page.waitForTimeout(250);
    const checked = await inputs[idx].evaluate((i) => i.checked);
    if (checked) return;
  }
  throw new Error(`option "${optionLabel}" would not stay selected`);
}

/**
 * Boolean fields render as a Yes/No button pair over a hidden checkbox.
 * Clicked through Playwright for the same reason as selectRadio: a scripted DOM
 * click updates the button but not the form state behind it.
 */
async function selectBoolean(page, field, yesNo) {
  const handle = await containerHandle(page, field.title);
  const el = handle.asElement();
  if (!el) throw new Error('no container');
  const want = String(yesNo).toLowerCase();

  const buttons = await el.$$('button');
  for (const b of buttons) {
    const text = (await b.evaluate((n) => n.textContent)).trim().toLowerCase();
    if (text !== want) continue;
    await b.click({ force: true });
    await page.waitForTimeout(250);
    return;
  }
  const radios = await el.$$('input[type="radio"]');
  for (const r of radios) {
    const lab = (await r.evaluate((n) => (n.closest('label')?.textContent || '').trim().toLowerCase()));
    if (lab !== want) continue;
    await r.click({ force: true });
    await page.waitForTimeout(250);
    return;
  }
  const seen = await el.evaluate((root) => [...root.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' / '));
  throw new Error(`no "${yesNo}" control among [${seen}]`);
}

/**
 * Ashby's Location autocomplete is a remote lookup whose granularity varies by
 * board — Photoroom's resolves countries only ("Paris" returns nothing, "France"
 * returns France), others resolve cities. So try the configured value, then the
 * country, then the city, and take the first query that returns real options.
 *
 * Options are read from the listbox the combobox names in aria-controls; a
 * document-wide class search picks up the Yes/No buttons of unrelated Boolean
 * questions and clicks one of them instead.
 */
async function selectLocation(page, field, value) {
  const handle = await containerHandle(page, field.title);
  const el = handle.asElement();
  const combo = el ? await el.$('input[role="combobox"], input[type="text"]') : null;
  if (!combo) throw new Error(`no location combobox in the "${field.title}" field`);

  const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  const candidates = [...new Set([String(value).trim(), parts[parts.length - 1], parts[0]])];

  await combo.scrollIntoViewIfNeeded();
  for (const q of candidates) {
    await combo.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await combo.type(q, { delay: 90 });
    await page.waitForTimeout(2500);
    const picked = await page.evaluate(({ want, full }) => {
      const combo = document.querySelector('input[role="combobox"][aria-controls]');
      const lb = combo && document.getElementById(combo.getAttribute('aria-controls'));
      if (!lb || lb.querySelector('[data-empty]')) return null;
      const opts = [...lb.querySelectorAll('*')]
        .filter((n) => !n.children.length && n.textContent.trim() && !/^no results$/i.test(n.textContent.trim()))
        .map((n) => ({ el: n, text: n.textContent.trim() }));
      if (!opts.length) return null;
      const w = want.toLowerCase();
      const f = full.toLowerCase();
      const hit =
        opts.find((o) => o.text.toLowerCase() === f) ||
        opts.find((o) => o.text.toLowerCase() === w) ||
        opts.find((o) => f.includes(o.text.toLowerCase())) ||
        opts[0];
      (hit.el.closest('[role="option"], li, button, div') || hit.el).click();
      return hit.text;
    }, { want: q, full: String(value) });
    if (picked) { await page.waitForTimeout(500); return picked; }
  }
  throw new Error(`location typeahead returned no suggestions for [${candidates.join(' / ')}]`);
}

async function readBack(page, action) {
  if (action.kind === 'file') {
    return await page.evaluate((p) => {
      const el = document.getElementById(p);
      if (el && el.files && el.files.length) return el.files[0].name;
      return /\.(pdf|docx?)\b/i.test(document.body.innerText) ? 'attached' : '';
    }, action.path);
  }
  if (action.kind === 'text') {
    return await page.evaluate((p) => document.getElementById(p)?.value ?? null, action.path);
  }
  // select / boolean / location — read the container's rendered state
  const handle = await containerHandle(page, action.title);
  return await handle.evaluate((el, OPTIONS) => {
    if (!el) return null;
    // Boolean fields are a Yes/No button pair over a hidden checkbox, so the
    // pressed button is the only place the chosen answer is readable as text —
    // the checkbox's name is a uuid, which is what a naive read returns.
    const pressed = [...el.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true' || /selected|_selected/i.test(b.className)
    );
    if (pressed && pressed.textContent.trim()) return pressed.textContent.trim();

    const checked = [...el.querySelectorAll('input[type="radio"],input[type="checkbox"]')].filter((r) => r.checked);
    if (checked.length) {
      // Read the choice the same way it was made: by position in the group,
      // because the shared id makes label[for=...] point at option one.
      const all = [...el.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
      const positional = OPTIONS.length > 0 && all.length === OPTIONS.length;
      const labelOf = (r) => {
        if (positional) return OPTIONS[all.indexOf(r)];
        const texts = [r.name, r.closest('label')?.textContent];
        for (let n = r.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) texts.push(n.textContent);
        const seen = texts.map((t) => (t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        for (const v of OPTIONS) if (seen.some((t) => t.includes(v))) return v;
        return seen.find((t) => t.length <= 60) || 'checked';
      };
      return checked.map(labelOf).join(', ');
    }

    const combo = el.querySelector('input[role="combobox"]');
    if (combo && combo.value) return combo.value;
    return '';
  }, action.values ?? []);
}

function matches(action, actual) {
  if (actual == null) return false;
  const got = norm(actual);
  // An empty read-back is never a match. Without this an empty string satisfies
  // `wanted.includes(got)` for every wanted value, which is how a form with an
  // unset dropdown and an empty location reported itself fully verified.
  if (got === '') return false;
  if (action.kind === 'file') return true;
  if (action.kind === 'text') {
    if (/phone/i.test(action.path || '') || action.type === 'Phone') {
      const digits = (s) => String(s).replace(/\D/g, '');
      return digits(actual).length >= 6 && digits(action.value).endsWith(digits(actual).slice(-6));
    }
    return got === norm(action.value);
  }
  const want = norm(action.value);
  return got === want || got.includes(want) || want.includes(got);
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

/** Ask the rendered form what it still considers unanswered. */
async function unfilledRequired(page) {
  return await page.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('[class*="ashby-application-form-field-entry"], fieldset')) {
      const labelEl = e.querySelector('label, legend');
      const label = (labelEl?.textContent || '').trim();
      if (!/\*/.test(label) && !e.querySelector('[aria-required="true"], [required]')) continue;
      const text = [...e.querySelectorAll('input,textarea')].some((i) => {
        if (i.type === 'file') return i.files && i.files.length;
        if (i.type === 'radio' || i.type === 'checkbox') return i.checked;
        return (i.value || '').trim().length > 0;
      });
      if (!text) out.push(label.replace(/\*/g, '').trim().slice(0, 60));
    }
    return [...new Set(out)].filter(Boolean);
  });
}

async function applyOne(page, url, plan, cfg, opts) {
  const shot = async (tag) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = `${SHOT_DIR}/${Date.now()}_${tag}_${plan.key.replace(/\W+/g, '-')}.png`;
    await page.screenshot({ path: f, fullPage: true }).catch(() => {});
    return f;
  };

  const applyUrl = url.replace(/\/application\/?$/, '') + '/application';
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForSelector('#_systemfield_name, #_systemfield_email', { timeout: 20000 });
    await dismissBanners(page);
  } catch {
    return { outcome: 'NO_FORM', detail: 'application form never hydrated' };
  }

  const failures = [];
  for (const action of plan.actions) {
    try {
      if (action.kind === 'file') await byId(page, action.path).setInputFiles(action.value);
      else if (action.kind === 'text') await typeInto(page, action.path, action.value);
      else if (action.kind === 'boolean') await selectBoolean(page, action, action.value);
      else if (action.kind === 'select') await selectRadio(page, action, action.value);
      else if (action.kind === 'location') await selectLocation(page, action, action.value);
    } catch (e) {
      failures.push(`${action.title}: ${e.message.split('\n')[0].slice(0, 140)}`);
    }
  }

  // THE GATE.
  await page.waitForTimeout(SETTLE_MS);
  const bad = [];
  for (const action of plan.actions) {
    const actual = await readBack(page, action);
    if (!matches(action, actual)) {
      bad.push(`${action.title} [${action.path}] wanted ${JSON.stringify(String(action.value).slice(0, 34))} got ${JSON.stringify(actual)}`);
    }
  }
  if (failures.length) return { outcome: 'FILL_ERROR', detail: failures.join(' ; '), shot: await shot('FILL_ERROR') };
  if (bad.length) return { outcome: 'VERIFY_FAILED', detail: `${bad.length} field(s) did not stick: ${bad.join(' ; ')}`, shot: await shot('VERIFY_FAILED') };

  const missed = await unfilledRequired(page);
  if (missed.length) return { outcome: 'REQUIRED_MISSING', detail: `form still requires: ${missed.join(' ; ')}`, shot: await shot('REQUIRED_MISSING') };
  if (await hasCaptcha(page)) return { outcome: 'CAPTCHA', detail: 'captcha present — filled, submit manually', shot: await shot('CAPTCHA') };
  if (!opts.submit) return { outcome: 'READY', detail: `${plan.actions.length} field(s) verified; not submitted (dry run)`, shot: await shot('READY') };

  // Ashby renders each Boolean's Yes/No pair as button[type=submit] too, so the
  // real submit has to be picked by name, not by position.
  const submitBtn = page.getByRole('button', { name: /submit application/i }).first();
  await submitBtn.scrollIntoViewIfNeeded();
  await submitBtn.click({ timeout: 15000 });
  await page.waitForTimeout(7000);
  // Boards word the receipt however they like ("Thanks for applying to Qonto!
  // Got your application"), so match the shapes rather than one phrase, and read
  // the rejection banner too — Ashby returns "flagged as possible spam" when the
  // invisible reCAPTCHA v3 score is too low, which headless Chromium reliably is.
  const verdict = await page.evaluate(() => {
    const text = document.body.innerText;
    const rejected = /couldn.t submit|flagged as possible spam|please submit your application again/i.exec(text);
    if (rejected) return { ok: false, why: rejected[0] };
    const ok = /thank(s| you) for applying|got your application|thank you|application (has been )?(submitted|received)|we have received|successfully submitted/i.test(text);
    return { ok, why: ok ? (text.trim().split(/\n/).find((l) => l.trim()) || '').slice(0, 90) : '' };
  });
  if (verdict.ok) return { outcome: 'SUBMITTED', detail: verdict.why || 'confirmation shown', shot: await shot('SUBMITTED') };
  return {
    outcome: 'SUBMIT_REJECTED',
    detail: verdict.why || 'no confirmation text after submit',
    shot: await shot('SUBMIT_REJECTED'),
  };
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
  for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
  const top = Object.entries(blockers).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length) {
    console.log('\nTop unanswered questions:\n');
    for (const [label, n] of top) console.log(`  ${String(n).padStart(4)}  ${label.slice(0, 100)}`);
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
  if (args.file) urls = urls.concat(fs.readFileSync(args.file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  if (args.fromPipeline) urls = urls.concat(pipelineUrls());
  if (!urls.length) throw new Error('no urls — pass URLs, --from-pipeline, or --urls <file>');

  console.log(args.submit
    ? '\n*** SUBMIT MODE — verified applications will be sent ***\n'
    : '\nDry run — forms are filled and verified, nothing is submitted. Add --submit to apply.\n');

  // Ashby scores submissions with invisible reCAPTCHA v3. Headless Chromium
  // scores badly enough that the submit is rejected as "possible spam", so a
  // real submit run wants --headed and ideally --channel chrome.
  // --profile keeps cookies and history between runs. Ashby scores submissions
  // with invisible reCAPTCHA v3, and a browser with no past scores worse than one
  // that has been around.
  const launchOpts = { headless: !args.headed, ...(args.channel ? { channel: args.channel } : {}) };
  let browser = null;
  let context = null;
  if (!args.planOnly) {
    if (args.profile) {
      context = await chromium.launchPersistentContext('data/ashby/browser-profile', {
        ...launchOpts,
        viewport: { width: 1280, height: 1000 },
      });
    } else {
      browser = await chromium.launch(launchOpts);
      context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    }
  }

  // Submitting back to back is what drives the v3 score down until a run starts
  // getting rejected as "possible spam". Jittered so the gaps are not uniform.
  const gapMs = () => {
    const base = (args.delay ?? (args.submit ? 150 : 0)) * 1000;
    return base ? base + Math.random() * base * 0.6 : 0;
  };

  let done = 0;

  for (const url of urls) {
    if (done >= args.limit) break;
    const parsed = parseUrl(url);
    if (!parsed) continue;
    if (state[parsed.key]) { console.log(`  ~ already processed (${state[parsed.key].outcome}): ${parsed.key}`); continue; }
    done++;

    let jp;
    try {
      jp = await fetchSchema(parsed);
    } catch (e) {
      console.log(`  ! ${parsed.key} — api error: ${e.message}`);
      record(state, parsed.key, { outcome: 'API_ERROR', detail: e.message, url });
      continue;
    }
    if (jp.dead) {
      console.log(`  x ${parsed.key} — posting closed`);
      record(state, parsed.key, { outcome: 'DEAD', detail: 'graphql returned no jobPosting', url });
      continue;
    }

    const base = { company: parsed.org, title: jp.title, url, location: jp.locationName || '' };
    const banned = blacklistedAs(base.company);
    if (banned) {
      console.log(`  x ${jp.title} — BLACKLISTED (${banned})`);
      record(state, parsed.key, { ...base, outcome: 'BLACKLISTED', detail: banned });
      continue;
    }

    const plan = { ...planAnswers(jp, cfg), key: parsed.key };
    const label = `${parsed.org} — ${jp.title}`;

    if (plan.blockers.length) {
      console.log(`  - ${label}\n      SKIP: ${plan.blockers.length} unanswerable required question(s)`);
      for (const b of plan.blockers) console.log(`        · ${b.slice(0, 130)}`);
      record(state, parsed.key, { ...base, outcome: 'UNANSWERABLE', detail: plan.blockers.join(' ; '), blockers: plan.blockers, stance: plan.stance });
      continue;
    }
    if (args.planOnly) {
      console.log(`  ✓ ${label}\n      PLANNED: ${plan.actions.length} field(s)`);
      record(state, parsed.key, { ...base, outcome: 'PLANNED', detail: `${plan.actions.length} field(s) planned`, stance: plan.stance });
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
    console.log(`  ${mark} ${label}\n      ${result.outcome}: ${String(result.detail).slice(0, 200)}`);
    record(state, parsed.key, { ...base, ...result, stance: plan.stance });

    // Back-to-back submissions are what drove the reCAPTCHA v3 score down until
    // Ashby started rejecting them as "possible spam" partway through a run.
    if (args.submit && /SUBMITTED|SUBMIT_REJECTED/.test(result.outcome)) {
      const wait = gapMs();
      if (wait) {
        console.log(`      pausing ${Math.round(wait / 1000)}s before the next submission`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  if (browser) await browser.close();
  else if (context) await context.close();
  console.log(`\nProcessed ${done}. Run \`node ashby-apply.mjs --report\` for the roll-up.\n`);
}

// ---------------------------------------------------------------- staging API

/** See greenhouse-apply.mjs prepareJob — same contract, Ashby schema. */
export async function prepareJob(page, url, cfg) {
  const parsed = parseUrl(url);
  if (!parsed) return { outcome: 'NOT_SUPPORTED', detail: 'not an ashby url' };
  const jp = await fetchSchema(parsed);
  if (jp.dead) return { outcome: 'DEAD', detail: 'posting closed' };
  const banned = blacklistedAs(parsed.org);
  if (banned) return { outcome: 'BLACKLISTED', detail: banned };
  const plan = { ...planAnswers(jp, cfg), key: parsed.key };
  if (plan.blockers.length) {
    return { outcome: 'UNANSWERABLE', detail: plan.blockers.join(' ; '), blockers: plan.blockers };
  }
  const result = await applyOne(page, url, plan, cfg, { submit: false });
  return { ...result, company: parsed.org, title: jp.title };
}

export { loadConfig };

// Only run the CLI when invoked directly — apply-stage.mjs imports prepareJob().
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('ashby-apply.mjs')) {
  main().catch((e) => { console.error(`\nfatal: ${e.message}\n`); process.exit(1); });
}
