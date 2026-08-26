#!/usr/bin/env node
/**
 * apply-stage.mjs — pool the human work into one pass instead of one per job.
 *
 * The problem this solves: running the appliers in --submit mode interleaves
 * machine work and human work. You solve a captcha, wait 40s for the next form
 * to fill, solve another, wait again. Fifty interruptions for fifty jobs.
 *
 * This inverts it. Every form is filled and verified headlessly first, with zero
 * human involvement. Only then does a single browser window open, carrying one
 * tab per job, each already complete and scrolled to its Submit button. You go
 * Ctrl+Tab, click, Ctrl+W, and the script records what landed.
 *
 * The contract for a staged tab is the point of the whole thing: when a tab
 * reaches you, the ONLY thing left to do is the action named in the banner. If a
 * form still wants something else, it does not get staged — it goes back to the
 * fix list. You should never be hunting a page for a stray checkbox.
 *
 * Usage:
 *   node apply-stage.mjs --plan                  # what would be staged, by class
 *   node apply-stage.mjs --stage --limit 20      # open the staged window
 *   node apply-stage.mjs --stage --class captcha # captcha sprint only
 */

import fs from 'fs';
import { chromium } from 'playwright';
import * as greenhouse from './greenhouse-apply.mjs';
import * as ashby from './ashby-apply.mjs';
import * as lever from './lever-apply.mjs';

const MODULES = { greenhouse, ashby, lever };

const APPLIERS = {
  greenhouse: { state: 'data/greenhouse/state.json', match: /greenhouse\.io/ },
  ashby: { state: 'data/ashby/state.json', match: /ashbyhq\.com/ },
  lever: { state: 'data/lever/state.json', match: /lever\.co/ },
};

const STAGE_LOG = 'data/staged-runs.tsv';

function parseArgs(argv) {
  const a = { plan: false, stage: false, limit: 25, cls: null, keepOpen: true };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--plan') a.plan = true;
    else if (v === '--stage') a.stage = true;
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--class') a.cls = argv[++i];
    else if (v.startsWith('--')) throw new Error(`unknown flag: ${v}`);
  }
  if (!a.plan && !a.stage) a.plan = true;
  return a;
}

/**
 * What a job needs from a human, derived from the outcome its applier recorded.
 *
 *   auto     nothing — submits unattended
 *   captcha  a challenge to solve
 *   code     a verification code from the user's inbox
 *   handoff  something the applier will not answer on the user's behalf
 *   blocked  unanswerable; not the user's problem to click through
 */
function classify(entry) {
  switch (entry.outcome) {
    case 'READY':
    case 'PLANNED':
      return 'auto';
    case 'CAPTCHA':
    case 'CAPTCHA_BOARD':
      return 'captcha';
    case 'VERIFICATION_CODE':
      return 'code';
    case 'SUBMIT_REJECTED':
    case 'SUBMIT_UNCONFIRMED':
      // Filled and verified, but the platform refused the automated submit.
      // A human click is exactly what it is asking for.
      return 'handoff';
    default:
      return null;
  }
}

function collect() {
  const jobs = [];
  for (const [name, cfg] of Object.entries(APPLIERS)) {
    if (!fs.existsSync(cfg.state)) continue;
    const state = JSON.parse(fs.readFileSync(cfg.state, 'utf8'));
    for (const [key, e] of Object.entries(state)) {
      if (e.outcome === 'SUBMITTED') continue;
      const cls = classify(e);
      if (!cls) continue;
      jobs.push({ applier: name, key, cls, company: e.company, title: e.title, url: e.url, detail: e.detail });
    }
  }
  return jobs;
}

function banner(page, text, sub) {
  return page.evaluate(({ text, sub }) => {
    document.getElementById('__careerops_banner')?.remove();
    const bar = document.createElement('div');
    bar.id = '__careerops_banner';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:#111', 'color:#fff', 'font:600 14px/1.5 system-ui,sans-serif',
      'padding:10px 16px', 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
    ].join(';');
    bar.innerHTML =
      `<span>${text}</span>` +
      (sub ? `<span style="opacity:.65;font-weight:400;margin-left:12px">${sub}</span>` : '');
    document.documentElement.appendChild(bar);
    document.body.style.paddingTop = '44px';
  }, { text, sub });
}

/** Scroll the thing they have to click into view so nothing needs hunting. */
async function focusAction(page, cls) {
  const target =
    cls === 'captcha'
      ? page.locator('iframe[src*="hcaptcha"], iframe[src*="/recaptcha/api2/bframe"]').first()
      : page.getByRole('button', { name: /submit application|submit/i }).first();
  await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let jobs = collect();
  if (args.cls) jobs = jobs.filter((j) => j.cls === args.cls);

  const byClass = {};
  for (const j of jobs) (byClass[j.cls] ??= []).push(j);

  console.log(`\n${jobs.length} job(s) staged across ${Object.keys(byClass).length} class(es)\n`);
  for (const [cls, list] of Object.entries(byClass).sort((a, b) => b[1].length - a[1].length)) {
    const note = {
      auto: 'no human needed — run the applier with --submit',
      captcha: 'one headed sprint: solve, script submits each as it clears',
      code: 'needs an emailed code',
      handoff: 'filled and verified; you click Submit',
      blocked: 'not staged',
    }[cls];
    console.log(`  ${String(list.length).padStart(3)}  ${cls.padEnd(8)} ${note}`);
  }

  if (args.plan) {
    console.log('\nRe-run with --stage to open the window.\n');
    for (const [cls, list] of Object.entries(byClass)) {
      if (cls === 'auto') continue;
      console.log(`\n${cls}:`);
      for (const j of list.slice(0, 12)) console.log(`   ${j.company} — ${String(j.title).slice(0, 55)}`);
      if (list.length > 12) console.log(`   ...and ${list.length - 12} more`);
    }
    console.log();
    return;
  }

  const staged = jobs.filter((j) => j.cls !== 'auto' && j.cls !== 'blocked').slice(0, args.limit);
  if (!staged.length) return console.log('nothing to stage — everything is either auto or blocked.\n');

  console.log(`\nOpening ${staged.length} tab(s). Each one is already filled and verified.`);
  console.log('Ctrl+Tab moves between them. Click the highlighted action, then Ctrl+W.\n');

  const context = await chromium.launchPersistentContext('data/browser-profile', {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--start-maximized'],
  });

  // Each applier reads the same config files; load once and reuse.
  const cfgs = {};
  for (const name of Object.keys(MODULES)) cfgs[name] = MODULES[name].loadConfig();

  const opened = [];
  for (const job of staged) {
    const page = await context.newPage();
    try {
      // The tab has to arrive FILLED. Re-navigating alone hands over an empty
      // form, which is the whole thing this script exists to avoid.
      const result = await MODULES[job.applier].prepareJob(page, job.url, cfgs[job.applier]);
      if (!/READY|CAPTCHA|VERIFICATION_CODE/.test(result.outcome)) {
        // Anything else means the form is not actually finished, so it does not
        // get staged. No tab should ever need hunting through.
        console.log(`  – not staged (${result.outcome}): ${job.company} — ${String(job.title).slice(0, 45)}`);
        await page.close().catch(() => {});
        continue;
      }
      await focusAction(page, job.cls);
      await banner(
        page,
        `${opened.length + 1}/${staged.length} · ${job.company} — ${String(job.title).slice(0, 50)}`,
        job.cls === 'captcha' ? 'solve the challenge, then Submit' : 'click Submit, then Ctrl+W'
      );
      opened.push({ job, page });
      console.log(`  ${String(opened.length).padStart(3)}. ${job.company} — ${String(job.title).slice(0, 55)}`);
    } catch (e) {
      console.log(`  skipped ${job.company}: ${e.message.split('\n')[0]}`);
      await page.close().catch(() => {});
    }
  }

  console.log('\nWatching for submissions. Close the window when you are done.\n');
  fs.mkdirSync('data', { recursive: true });
  if (!fs.existsSync(STAGE_LOG)) fs.writeFileSync(STAGE_LOG, 'timestamp\tapplier\tkey\tcompany\ttitle\toutcome\n');

  const done = new Set();
  const CONFIRM = /thank(s| you)|application (has been )?(submitted|received)|we have received|successfully/i;
  await new Promise((resolve) => {
    context.on('close', resolve);
    const timer = setInterval(async () => {
      for (const { job, page } of opened) {
        if (done.has(job.key) || page.isClosed()) continue;
        const ok = await page.evaluate((re) => new RegExp(re, 'i').test(document.body.innerText), CONFIRM.source).catch(() => false);
        if (!ok) continue;
        done.add(job.key);
        const row = [new Date().toISOString(), job.applier, job.key, job.company, job.title, 'SUBMITTED'];
        fs.appendFileSync(STAGE_LOG, row.map((c) => String(c ?? '').replace(/[\t\n\r]+/g, ' ')).join('\t') + '\n');
        // Write it back to the applier's own state so it is never re-staged.
        const cfg = APPLIERS[job.applier];
        const state = JSON.parse(fs.readFileSync(cfg.state, 'utf8'));
        if (state[job.key]) {
          state[job.key].outcome = 'SUBMITTED';
          state[job.key].detail = 'submitted by hand from a staged tab';
          state[job.key].submittedAt = new Date().toISOString();
          fs.writeFileSync(cfg.state, JSON.stringify(state, null, 1));
        }
        console.log(`  ✓ ${job.company} — ${String(job.title).slice(0, 50)}`);
      }
      if (done.size === opened.length && opened.length) {
        clearInterval(timer);
        console.log('\nAll staged tabs submitted.\n');
        resolve();
      }
    }, 2000);
  });

  console.log(`\n${done.size}/${opened.length} submitted. Logged to ${STAGE_LOG}.\n`);
  await context.close().catch(() => {});
}

main().catch((e) => { console.error(`\nfatal: ${e.message}\n`); process.exit(1); });
