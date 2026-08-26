#!/usr/bin/env node
/**
 * apply-answer-engine.mjs — shared free-text answering for the ATS appliers.
 *
 * Lives in one place on purpose: greenhouse-apply.mjs, ashby-apply.mjs and
 * lever-apply.mjs must give the same answer to the same question. Two copies of
 * this logic would drift, and drift here means the same person answers the same
 * question differently on two forms.
 *
 * The rule it enforces: an answer may reword what cv.md / config/profile.yml
 * already say, and may never add a fact they do not. Anything matching
 * `never_auto` in config/apply-essays.yml is refused outright rather than
 * guessed — those are the questions where a wrong answer is a real liability on
 * a real application, not a formatting problem.
 */

import fs from 'fs';
import yaml from 'js-yaml';

const ESSAY_FILE = 'config/apply-essays.yml';

let cached = null;

export function loadEssays(file = ESSAY_FILE) {
  if (cached) return cached;
  if (!fs.existsSync(file)) return (cached = { essays: [], fallback: null, never_auto: [] });
  const raw = yaml.load(fs.readFileSync(file, 'utf8')) ?? {};
  cached = {
    essays: (raw.essays ?? []).map((e) => ({ re: new RegExp(e.match, 'i'), answer: String(e.answer ?? '').trim() })),
    fallback: raw.fallback ? String(raw.fallback).trim() : null,
    never_auto: (raw.never_auto ?? []).map((p) => new RegExp(p, 'i')),
  };
  return cached;
}

/** Questions we refuse to answer automatically, with the reason for the log. */
export function refuseReason(title, bank = loadEssays()) {
  const hit = bank.never_auto.find((re) => re.test(title));
  return hit ? `answer would be an unsupported factual claim (matches /${hit.source}/)` : null;
}

/**
 * Free-text answer for a question, or null if none applies.
 *
 * `allowFallback` is for questions that read as motivation/background. A
 * required free-text question with no specific match still gets a grounded
 * summary rather than blocking the whole application — but only when it is not
 * asking for a fact (see refuseReason) and not obviously numeric.
 */
export function freeTextAnswer(title, { allowFallback = true } = {}) {
  const bank = loadEssays();
  if (refuseReason(title, bank)) return null;
  const hit = bank.essays.find((e) => e.re.test(title));
  if (hit) return hit.answer;
  if (!allowFallback || !bank.fallback) return null;
  // A short-answer box asking for a number or a date is not an essay prompt.
  if (/^(how many|how much|what (year|date)|when |number of)/i.test(title.trim())) return null;
  return bank.fallback;
}

/**
 * Years of professional experience, computed from the date ranges in cv.md
 * rather than hard-coded, so it stays true as the CV changes. Overlapping
 * ranges are merged — a role held during a degree is not counted twice.
 */
export function yearsOfExperience(cvPath = 'cv.md') {
  if (!fs.existsSync(cvPath)) return null;
  const full = fs.readFileSync(cvPath, 'utf8');
  // Only the Experience section. The bold date ranges under Education and
  // Projects have the same shape, and counting a degree as work experience
  // inflated this from ~4 years to 8.
  const from = full.search(/^##\s+Experience\s*$/m);
  const rest = from === -1 ? full : full.slice(from + 1);
  const to = rest.search(/^##\s+(?!#)/m);
  const text = from === -1 ? full : (to === -1 ? rest : rest.slice(0, to));
  const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const re = new RegExp(`\\*\\*(${MONTHS})[a-z]* (\\d{4})\\s*[–-]\\s*((${MONTHS})[a-z]* (\\d{4})|present)`, 'gi');
  const monthIdx = (m) => 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m.slice(0, 3).toLowerCase()) / 3;
  const now = new Date();
  const spans = [];
  for (const m of text.matchAll(re)) {
    const start = new Date(Number(m[2]), monthIdx(m[1]), 1);
    const end = /present/i.test(m[3]) ? now : new Date(Number(m[5]), monthIdx(m[4]), 1);
    if (end > start) spans.push([start.getTime(), Math.min(end.getTime(), now.getTime())]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0]];
  for (const [s, e] of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const ms = merged.reduce((acc, [s, e]) => acc + (e - s), 0);
  return Math.floor(ms / (365.25 * 24 * 3600 * 1000));
}


/**
 * "Do you have experience with X?" answered against cv.md rather than guessed.
 *
 * Yes only when the technology is actually named in the CV; otherwise No. Both
 * answers are grounded — "No" to Ruby on Rails is as true and as useful as "Yes"
 * to Docker, and answering it beats skipping the whole application.
 *
 * Returns 'Yes' | 'No' | null (null = not a skill question, decide elsewhere).
 */
const SKILL_PROBE_RE =
  /(^|[,.:;]\s*)(do you have|have you|are you) (any )?(experience|familiar|worked|used|built|designed|personally designed|significantly contributed)/i;

export function skillProbe(title, cvPath = 'cv.md') {
  if (!SKILL_PROBE_RE.test(title.trim())) return null;
  if (!fs.existsSync(cvPath)) return null;
  const cv = fs.readFileSync(cvPath, 'utf8').toLowerCase();

  // Candidate technology tokens: the capitalised / punctuated terms a question
  // uses to name a stack ("python, postgreSQL, fastAPI", "Ruby on Rails").
  const tail = title.replace(/^[^:?]*[:?]?/, '') || title;
  const tokens = [...new Set(
    (title.match(/[A-Za-z][A-Za-z0-9+#./-]{2,}/g) ?? [])
      .map((t) => t.toLowerCase())
      .filter((t) => !STOPWORDS.has(t))
  )];
  const named = tokens.filter((t) => TECH_HINT.test(t) || cv.includes(t));
  if (!named.length) return null;

  const known = named.filter((t) => cv.includes(t));
  // A question naming several technologies is a Yes if the CV shows any of them;
  // these questions screen for exposure, not for the full set.
  return known.length ? 'Yes' : 'No';
}

const STOPWORDS = new Set([
  'do', 'you', 'have', 'any', 'experience', 'with', 'the', 'and', 'are', 'familiar',
  'worked', 'used', 'built', 'designed', 'maintained', 'system', 'systems', 'running',
  'production', 'beyond', 'prototypes', 'demos', 'personally', 'significantly',
  'contributed', 'following', 'stack', 'particular', 'images', 'pipeline', 'pipelines',
  'please', 'note', 'this', 'that', 'your', 'our', 'for', 'from', 'about', 'has', 'his',
  'her', 'their', 'been', 'were', 'more', 'than', 'years', 'year', 'work', 'working',
]);

// Terms that look like technologies even when the CV does not mention them, so a
// truthful "No" can be given instead of falling through to a skip.
const TECH_HINT =
  /^(ruby|rails|php|laravel|django|flask|spring|scala|kotlin|swift|golang|rust|elixir|erlang|haskell|perl|cobol|salesforce|sap|dynamics|servicenow|snowflake|databricks|spark|hadoop|kafka|flink|airflow|dbt|terraform|ansible|puppet|chef|kubernetes|docker|jenkins|gitlab|circleci|argocd|helm|prometheus|grafana|datadog|splunk|elasticsearch|postgres|postgresql|postgis|mysql|mongodb|redis|cassandra|dynamodb|bigquery|redshift|python|java|javascript|typescript|c\+\+|c#|\.net|node|react|angular|vue|fastapi|express|graphql|aws|azure|gcp|openshift|pytorch|tensorflow|cuda|tensorrt|deepstream)$/i;

if (process.argv[1] && process.argv[1].endsWith('apply-answer-engine.mjs')) {
  const bank = loadEssays();
  console.log(`essays: ${bank.essays.length} · never_auto: ${bank.never_auto.length} · years: ${yearsOfExperience()}`);
  for (const q of process.argv.slice(2)) {
    const refused = refuseReason(q);
    console.log(`\n${q}\n  -> ${refused ? 'REFUSED: ' + refused : (freeTextAnswer(q) ?? 'no answer').slice(0, 120) + '...'}`);
  }
}
