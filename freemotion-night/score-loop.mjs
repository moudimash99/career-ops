#!/usr/bin/env node
// @ts-check
/**
 * freemotion-night/score-loop.mjs — keeps the Gemini API busy all day: the
 * quick check (go / no-go on titles) and then the fit score of every job the
 * night list could take, English first, then by the day we found the job,
 * newest first. Runs until stopped.
 *
 * The user wants the free daily quota used to the full, every day (2026-09-29),
 * so the night list finds its jobs already scored instead of scoring them in
 * its own run. Each cycle re-reads the scan history, so new scans join the
 * queue on their own.
 *
 *   quick check   titles not answered yet, 100 per call (llm-score.mjs gateJobs)
 *   posting text  fetched just before a job's fit score (fetch-texts.mjs, no model)
 *   fit score     one call per job (scoreJobs), paced at --rpm calls a minute;
 *                 on the Flash and Pro models (~20 free calls a day each) one
 *                 call scores --batch jobs (default 10, scoreJobsBatch)
 *
 * Load and back-off:
 *   - starts at --rpm (15) calls a minute; a per-minute 429 halves it (down to
 *     2), every 25 answers in a row without one adds 1 back (up to --rpm-max 30);
 *     askWithRetry already waits out each 429 the delay Gemini asks for.
 *   - the daily quota, counted per model: moves on to the next model of
 *     MODEL_ROTATION; a model the key cannot use is skipped for good. When every
 *     model is used up it sleeps until the quotas reset (midnight Pacific, 09:00
 *     Paris) plus 5 minutes, and starts again from the first.
 *   - network or server trouble: waits 1, 2, 4... up to 30 minutes, then retries.
 *   - nothing left to ask: checks again every 20 minutes.
 * A job whose answer fails 3 times is left for the night list.
 *
 * Usage:
 *   node freemotion-night/score-loop.mjs            run (in the background: see below)
 *   node freemotion-night/score-loop.mjs --status   what it is doing now
 *   node freemotion-night/score-loop.mjs --stop     stop the running loop
 *   node freemotion-night/score-loop.mjs --once     today only: stop when the daily quota
 *                                                   is used up or nothing is left, instead of waiting
 *   [--rpm 15] [--rpm-max 30] [--days 14] [--batch 10] [--models a,b,c]   (default MODEL_ROTATION;
 *   --model X uses X alone)
 *   A second loop beside the first (user, 2026-09-30: Flash and Gemma at the same time):
 *   --name gemma --model gemma-4-26b-a4b-it --oldest-first --no-gate
 *     --name        its own pid / log / status (tmp/fm/score-loop-gemma.*); --status/--stop take it too
 *     --oldest-first  the fit queue from the other end, so the loops meet in the middle
 *     --no-gate     skip the quick title check (the first loop does it)
 *   A third (user, 2026-09-30): --name flash --models <the Flash models> --from-middle --no-gate
 *     --from-middle   the fit queue from its middle toward the old end, then the newest
 *   --text-only     only jobs whose posting text is already stored (e.g. Gemma: no title-only scores)
 *   --parallel 5    that many calls in flight at once (for a slow model such as Gemma)
 *   --busy-rest 30  a model that answers 503 (overloaded) is retried once after 2 min, then rested
 *                   this many minutes while the next model works (each retry may use a daily call)
 * Output: tmp/fm/score-loop.log (one line per event), tmp/fm/score-loop-status.json.
 * One loop per name (tmp/fm/score-loop.pid, score-loop-<name>.pid). No agy, no Claude: Gemini API only.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MAX_AGE_DAYS } from './pool-rules.mjs';
import { FIT_BATCH, gateJobs, gateStore, geminiBatchGenerate, geminiGateGenerate, geminiGenerate, jobKey, readGate, readScores, resolveCandidate, scoreJobs, scoreJobsBatch } from './llm-score.mjs';
import { applyGate, selectCandidates, strongTitle } from './make-pool.mjs';
import { fetchMissingTexts } from './fetch-texts.mjs';
import { loadPostingTexts } from '../lib/posting-text.mjs';
import { requiredYears } from '../lib/required-years.mjs';
import { loadTargets } from '../targets.mjs';
import { localToday } from '../lib/local-today.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tmp/fm');
// --name X runs a second loop beside the first (its own pid, log and status),
// e.g. Gemma next to the Gemini models: quotas are counted per model.
const NAME = (() => { const i = process.argv.indexOf('--name'); return i >= 0 ? String(process.argv[i + 1] || '').replace(/[^\w-]/g, '') : ''; })();
const BASE = NAME ? `score-loop-${NAME}` : 'score-loop';
const PID = join(OUT, `${BASE}.pid`);
const LOG = join(OUT, `${BASE}.log`);
const STATUS = join(OUT, `${BASE}-status.json`);
const MIN = 60_000;
const IDLE_MS = 20 * MIN;
const MAX_BACKOFF_MS = 30 * MIN;
const CYCLE_JOBS = 50; // fit scores between two re-reads of the scan history
const MAX_FAILS = 3;

/**
 * The fit-score queue: jobs that passed the quick check and have no fit score,
 * English first, then newest, then the rule score. Jobs whose text asks too
 * many years are left out, as the night list does.
 * @param {object[]} passed
 * @param {{ scores: Map<string, object>, texts: Map<string, string>, tooManyYears: number|null, failed?: Map<string, number> }} opts
 */
export function fitQueue(passed, { scores, texts, tooManyYears, failed = new Map(), oldestFirst = false, fromMiddle = false, textOnly = false }) {
  const seen = new Set();
  const out = [];
  for (const x of passed) {
    const k = jobKey(x);
    if (scores.has(k) || seen.has(k) || (failed.get(k) || 0) >= MAX_FAILS) continue;
    if (textOnly && !texts.has(x.url)) continue; // --text-only: jobs whose posting text is already stored
    seen.add(k);
    const y = texts.has(x.url) ? requiredYears(texts.get(x.url)) : null;
    if (tooManyYears !== null && y !== null && y >= tooManyYears) continue;
    out.push(x);
  }
  out.sort(newestEnglishFirst);
  // A second loop works from the other end, so two loops rarely ask for the same job.
  // A third one starts in the middle and works toward the old end, then wraps to the newest.
  if (fromMiddle) { const mid = Math.floor(out.length / 2); return [...out.slice(mid), ...out.slice(0, mid)]; }
  return oldestFirst ? out.reverse() : out;
}

/**
 * English first (user, 2026-09-29: "above that, give always priority to
 * everything English"), then the day we found the job, newest first (today's
 * scan, then yesterday's...), then the newest posting, then the rule score.
 */
export function newestEnglishFirst(a, b) {
  return (Number(!!b.english) - Number(!!a.english))
    || String(b.seen || '').localeCompare(String(a.seen || ''))
    || ((a.ageDays ?? 99) - (b.ageDays ?? 99))
    || ((b.score || 0) - (a.score || 0));
}

/** Milliseconds until the Gemini daily quota resets (midnight Pacific) plus 5 minutes. */
export function msUntilReset(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const since = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return 24 * 3600 * 1000 - since + 5 * MIN;
}

/**
 * Calls per minute that back off on a per-minute 429 and creep back up.
 * @param {{ start: number, max: number, min?: number, upEvery?: number }} o
 */
export function makePace({ start, max, min = 2, upEvery = 25 }) {
  let rpm = start;
  let clean = 0;
  return {
    get rpm() { return rpm; },
    gapMs() { return Math.ceil(MIN / rpm); },
    hit429() { rpm = Math.max(min, Math.floor(rpm / 2)); clean = 0; },
    ok() { if (++clean >= upEvery) { rpm = Math.min(max, rpm + 1); clean = 0; } },
  };
}

/**
 * Gemini's free daily quota is counted per model, so when one model's quota is
 * used up the loop moves on to the next (user, 2026-09-29: "use all of them,
 * maximum usage"). Cheapest first; the Pro models have the smallest quotas.
 * Scores keep the model that made them (llm-scores.tsv `model`).
 */
// 3.1 Flash-Lite first, then Flash, 3.5 Flash-Lite as backup (user, 2026-10-04:
// the fit score now also answers the sector question, which 3.1 read best).
export const MODEL_ROTATION = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
  'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash',
  'gemini-3.1-pro-preview', 'gemini-2.5-pro',
];

/**
 * Which model to call now. `usedUp()` (daily quota gone, until the reset) and
 * `unusable()` (the key cannot call it, for good) move to the next model and
 * return false when none is left; `reset()` brings the used-up ones back.
 * @param {string[]} models
 */
export function makeRotation(models, { now = () => Date.now() } = {}) {
  const used = new Set();
  const bad = new Set();
  const restUntil = new Map(); // model → time it may be asked again (503: overloaded)
  let i = 0;
  const resting = (m) => (restUntil.get(m) || 0) > now();
  const pick = () => {
    const j = models.findIndex((m) => !used.has(m) && !bad.has(m) && !resting(m));
    if (j < 0) return false;
    i = j;
    return true;
  };
  return {
    get model() { return models[i]; },
    get left() { return models.filter((m) => !used.has(m) && !bad.has(m)).length; },
    /** The model is overloaded (503): leave it alone for ms, use the next one meanwhile. */
    rest(ms) { restUntil.set(models[i], now() + ms); return pick(); },
    /** Ms until a resting model may be asked again, or null when none is resting. */
    nextRestEnds() {
      const t = models.filter((m) => !used.has(m) && !bad.has(m) && resting(m)).map((m) => restUntil.get(m) - now());
      return t.length ? Math.max(0, Math.min(...t)) : null;
    },
    /** A resting model's time is up: pick again from the top. */
    wake() { return pick(); },
    usedUp() { used.add(models[i]); return pick(); },
    unusable() { bad.add(models[i]); return pick(); },
    reset() { used.clear(); return pick(); },
  };
}

/**
 * Jobs per fit-score call for a model: the Flash and Pro models have tiny daily
 * quotas (~20 calls), so each call there scores several jobs (user, 2026-09-30:
 * "for flash we do scoring 10 per 10"); Flash-Lite and Gemma score one per call.
 */
export function jobsPerCall(model, batch = FIT_BATCH) {
  return /-(flash|pro)(-preview)?$/.test(model) ? batch : 1;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
const log = (m) => { const line = `${stamp()}  ${m}`; appendFileSync(LOG, `${line}\n`); console.log(line); };

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
  mkdirSync(OUT, { recursive: true });
  const running = existsSync(PID) ? Number(readFileSync(PID, 'utf8')) : 0;

  if (argv.includes('--status')) {
    console.log(running && alive(running) ? `running (pid ${running})` : 'not running');
    if (existsSync(STATUS)) console.log(readFileSync(STATUS, 'utf8'));
    return;
  }
  if (argv.includes('--stop')) {
    if (running && alive(running)) { process.kill(running); console.log(`stopped (pid ${running})`); } else console.log('not running');
    return;
  }
  if (running && alive(running)) { console.log(`score-loop: already running (pid ${running}); --status to see it, --stop to stop it`); return; }
  writeFileSync(PID, String(process.pid));
  const cleanup = () => { try { if (Number(readFileSync(PID, 'utf8')) === process.pid) unlinkSync(PID); } catch { /* gone */ } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('stopped'); process.exit(0); });

  const today = { date: '', gate: 0, fit: 0, byModel: {} };
  const status = (state, extra = {}) => {
    const d = localToday();
    if (today.date !== d) Object.assign(today, { date: d, gate: 0, fit: 0, byModel: {} });
    writeFileSync(STATUS, JSON.stringify({ state, at: stamp(), model: rot.model, modelsLeft: rot.left, rpm: pace.rpm, today, ...extra }, null, 1));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try { (await import('dotenv')).config({ path: join(ROOT, '.env'), quiet: true }); } catch { /* optional */ }
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) { log('no GEMINI_API_KEY in .env; nothing to do'); process.exit(1); }
  const targets = loadTargets();
  if (!targets?.candidate) { log('config/targets.yml has no candidate: block; nothing to do'); process.exit(1); }
  const who = resolveCandidate(targets.candidate).candidate;

  // Quick title check mode (issue #21): config/targets.yml gate.mode, or --gate strict|loose for one run.
  const gateFlag = flag('--gate', '');
  if (gateFlag && !['strict', 'loose'].includes(gateFlag)) { console.error('--gate must be strict or loose'); process.exit(1); }
  const gate = { ...(targets?.gate || { mode: 'loose', experience: {} }), ...(gateFlag ? { mode: gateFlag } : {}) };
  const tooManyYears = targets.tooManyYears ?? null;
  const models = flag('--model', '') ? [flag('--model', '')]
    : flag('--models', '') ? flag('--models', '').split(',').map((m) => m.trim()).filter(Boolean) : MODEL_ROTATION;
  const rot = makeRotation(models);
  const days = Number(flag('--days', MAX_AGE_DAYS));
  const newPace = () => makePace({ start: Number(flag('--rpm', 15)), max: Number(flag('--rpm-max', 30)) });
  let pace = newPace();
  const once = argv.includes('--once');
  const oldestFirst = argv.includes('--oldest-first');
  const fromMiddle = argv.includes('--from-middle');
  const textOnly = argv.includes('--text-only');
  const restMin = Number(flag('--busy-rest', 30));
  const parallel = Math.max(1, Number(flag('--parallel', 1)) || 1);
  const noGate = argv.includes('--no-gate');
  const batchSize = Number(flag('--batch', FIT_BATCH));
  const done = (why) => { log(`--once: ${why}; stopping (today: ${today.gate} quick-check calls, ${today.fit} fit scores ${JSON.stringify(today.byModel)})`); status('stopped', { why }); process.exit(0); };
  const hideKey = (e) => String(e?.message || e).split(apiKey).join('[key]');

  // Every model call goes through here: a per-minute 429 slows the pace.
  const isDaily = (e) => /per ?day|PerDay|daily/i.test(`${e?.message || ''} ${JSON.stringify(e?.errorDetails || [])}`);
  let lastStatus = 0;
  const watch = (gen) => async (...a) => {
    try { const out = await gen(...a); lastStatus = 200; return out; } catch (e) {
      lastStatus = e?.status ?? e?.response?.status ?? 0;
      if (lastStatus === 429 && !isDaily(e)) {
        pace.hit429();
        // Which limit: calls or tokens a minute (e.g. ...PerMinutePerProjectPerModel-FreeTier).
        const which = (e?.errorDetails || []).flatMap((d) => d?.violations || []).map((v) => `${v.quotaId || ''}${v.quotaValue ? ` = ${v.quotaValue}` : ''}`).filter(Boolean).join(', ');
        log(`429 per minute on ${rot.model}${which ? ` (${which})` : ''}: slowing to ${pace.rpm} calls/min`);
      }
      throw e;
    }
  };
  const gens = new Map();
  const gensFor = async (m) => {
    if (!gens.has(m)) gens.set(m, { fit: watch(await geminiGenerate({ apiKey, model: m })), fitBatch: watch(await geminiBatchGenerate({ apiKey, model: m })), gate: watch(await geminiGateGenerate({ apiKey, model: m })) });
    return gens.get(m);
  };
  // The key cannot call this model (not found, not allowed, no free quota at all).
  const isUnusable = () => [400, 403, 404].includes(lastStatus);

  const failed = new Map();
  let backoff = MIN;
  const waitQuota = async () => {
    const ms = msUntilReset();
    const until = new Date(Date.now() + ms).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
    log(`every model's daily quota is used up (today: ${today.gate} quick-check calls, ${today.fit} fit scores ${JSON.stringify(today.byModel)}); sleeping until ${until} Paris`);
    status('waiting for the daily quota', { until });
    await sleep(ms);
    rot.reset();
    pace = newPace();
  };
  // No model to call now. A model resting after a 503 still has calls today: wait for
  // it to wake instead of sleeping until the reset (a 2026-09-30 night lost 3.8-flash's
  // remaining calls that way). Only when none is resting is the day over.
  const outOfModels = async (why) => {
    const ms = rot.nextRestEnds();
    if (ms == null) { if (once) done(why); await waitQuota(); return; }
    log(`no model free now (${why}); a resting model wakes in ${Math.ceil(ms / MIN)} min; waiting`);
    status('every model busy', { retryInMin: Math.ceil(ms / MIN) });
    await sleep(ms);
    rot.wake();
    pace = newPace();
  };
  // This model's quota is gone (or the key cannot use it): next model, or false when none is left.
  const nextModel = (why) => {
    const was = rot.model;
    const ok = why === 'unusable' ? rot.unusable() : rot.usedUp();
    log(`${was}: ${why === 'unusable' ? `not usable with this key (HTTP ${lastStatus})` : 'daily quota used up'}${ok ? `; switching to ${rot.model}` : ''}`);
    pace = newPace();
    return ok;
  };
  const waitTrouble = async (why) => {
    log(`${why}; retrying in ${Math.round(backoff / MIN)} min`);
    status('backing off', { why, retryInMin: Math.round(backoff / MIN) });
    await sleep(backoff);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  };

  log(`started (pid ${process.pid}${NAME ? `, name ${NAME}` : ''}, models ${models.join(', ')}, ${pace.rpm} calls/min${oldestFirst ? ', oldest first' : ''}${fromMiddle ? ', from the middle' : ''}${noGate ? ', no quick check' : ''}${textOnly ? ', text only' : ''}${parallel > 1 ? `, ${parallel} at a time` : ''})`);
  for (;;) {
    status('reading the scan history');
    let candidates;
    try {
      ({ candidates } = await selectCandidates({ days }));
    } catch (e) { await waitTrouble(`could not read the jobs (${e.message})`); continue; }

    // 1. Quick check: titles not answered yet, English first, newest first.
    const scoresBefore = readScores();
    const gateAnswers = readGate(undefined, gateStore(who, gate));
    const needGate = candidates.filter((x) => !strongTitle(x) && !scoresBefore.has(jobKey(x)) && !gateAnswers.has(jobKey(x))).sort(newestEnglishFirst);
    if (needGate.length && !noGate) {
      status('quick check', { titles: needGate.length });
      let quota = false;
      const model = rot.model;
      const g = await gateJobs(needGate, {
        generate: (await gensFor(model)).gate, candidate: who, gate, model,
        log: (m) => { if (/daily quota/.test(m)) quota = true; else log(m); },
      });
      const calls = Math.ceil((g.go + g.noGo) / 100);
      today.gate += calls;
      log(`quick check: ${g.go + g.noGo} of ${needGate.length} titles answered (${g.go} go, ${g.noGo} no-go${g.failed ? `, ${g.failed} failed` : ''})`);
      if (quota) { if (nextModel('quota')) continue; await outOfModels('every model used up'); continue; }
      if (g.failed && !(g.go + g.noGo) && isUnusable()) { if (nextModel('unusable')) continue; await outOfModels('no usable model left'); continue; }
      if (g.failed && !(g.go + g.noGo)) { await waitTrouble('quick check failed'); continue; }
    }

    // 2. Fit score: jobs that passed, English first, newest first.
    const scores = readScores();
    const { passed } = applyGate(candidates, readGate(), scores);
    const texts = loadPostingTexts(getCareerOpsRoot(), passed.map((x) => x.url));
    const queue = fitQueue(passed, { scores, texts, tooManyYears, failed, oldestFirst, fromMiddle, textOnly });
    if (!queue.length) {
      log('nothing left to score; checking again in 20 min');
      status('idle, nothing to score', { nextCheckMin: 20 });
      backoff = MIN;
      if (once) done('nothing left to score');
      await sleep(IDLE_MS);
      continue;
    }
    const batch = queue.slice(0, CYCLE_JOBS);
    status('fit scoring', { queue: queue.length, english: queue.filter((x) => x.english).length });
    try {
      await fetchMissingTexts(batch, { root: getCareerOpsRoot(), today: localToday(), maxMinutes: 5 });
    } catch { /* no text: scored on the title */ }
    const batchTexts = loadPostingTexts(getCareerOpsRoot(), batch.map((x) => x.url));
    let got = 0, bad = 0, quota = false, busyModel = false;
    const model = rot.model;
    const { fit, fitBatch } = await gensFor(model);
    const per = jobsPerCall(model, batchSize);
    const opts = { candidate: who, model, rpm: pace.rpm, busyRetries: 1, busyWaitMs: 2 * MIN, log: (m) => { if (!/daily quota/.test(m)) log(hideKey(m)); } };
    const ask = (chunk) => (per > 1
      ? scoreJobsBatch(chunk, { ...opts, generate: fitBatch, batch: per })
      : scoreJobs(chunk, { ...opts, generate: fit, max: 1 }));
    // --parallel N: N calls in flight at once (user, 2026-09-30: Gemma answers in ~30 s,
    // so one call at a time leaves the per-minute limit mostly unused).
    for (let i = 0; i < batch.length; i += per * parallel) {
      const chunks = [];
      for (let k = i; k < Math.min(batch.length, i + per * parallel); k += per) {
        chunks.push(batch.slice(k, k + per).map((job) => ({ ...job, text: batchTexts.get(job.url) })));
      }
      const answers = await Promise.all(chunks.map(ask));
      answers.forEach((r, n) => {
        if (r.stoppedByQuota) quota = true;
        if (r.busy) busyModel = true;
        if (r.scored) { got += r.scored; today.fit += r.scored; today.byModel[model] = (today.byModel[model] || 0) + r.scored; pace.ok(); backoff = MIN; }
        if (r.failed && !r.busy) {
          bad++;
          // A model the key cannot call fails every job the same way: not the job's fault.
          const missed = per > 1 ? r.missing : chunks[n];
          if (!isUnusable()) for (const job of missed) failed.set(jobKey(job), (failed.get(jobKey(job)) || 0) + 1);
        }
      });
      if (quota || busyModel) break;
      if (bad >= 5 * parallel && !got) break; // something is wrong with every call: back off
      status('fit scoring', { queue: queue.length - got, english: queue.filter((x) => x.english).length, doneThisBatch: got });
      await sleep(pace.gapMs());
    }
    log(`fit score (${model}): ${got} scored${bad ? `, ${bad} failed` : ''} | ${queue.length - got} still waiting (${queue.filter((x) => x.english).length} English) | ${pace.rpm} calls/min`);
    if (quota) { if (nextModel('quota')) continue; await outOfModels('every model used up'); continue; }
    if (busyModel) {
      // 503: Google has no room on this model now. Every retry may use a daily call, so
      // rest it --busy-rest minutes (30) and use the next model meanwhile (user, 2026-09-30).
      const was = rot.model;
      if (rot.rest(restMin * MIN)) { log(`${was}: overloaded (503); resting it ${restMin} min, switching to ${rot.model}`); pace = newPace(); continue; }
      log(`${was}: overloaded (503); resting it ${restMin} min`);
      await outOfModels('every model used up');
      continue;
    }
    if (bad >= 5 * parallel && !got && isUnusable()) { if (nextModel('unusable')) continue; await outOfModels('no usable model left'); continue; }
    if (bad >= 5 * parallel && !got) await waitTrouble(`${bad} calls failed in a row`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`score-loop: ${err.stack || err.message}`);
    process.exit(1);
  });
}
