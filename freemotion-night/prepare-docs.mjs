#!/usr/bin/env node

/**
 * freemotion-night/prepare-docs.mjs — the CV and the cover letter for ONE job, made right before it runs.
 *
 * run.sh calls this before it hands a job to a driver. It draws (or recalls) the posting's two arms and
 * makes the documents with the checked tools, so the agent only uploads and pastes:
 *   CV      generic 15 / loose 50 / strict 35 (lib/cv-experiment.mjs). generic = the CV named in
 *           config/freemotion-candidate.md; loose and strict are written for this posting (cv-write.mjs's
 *           context) and rendered to one page (generate-cv-typst.mjs; the fact gate runs for strict).
 *   letter  none 15 / short 35 / full 50 (lib/letter-experiment.mjs), written and checked by
 *           letter-write.mjs's writeLetter (up to two revisions). A refused `full` tries `short` once.
 * The claim the agent makes afterwards (freemotion-run.mjs) recalls the same arms: a posting keeps its
 * first draw forever.
 *
 * Nothing here can stop an application. A CV that cannot be written or rendered falls back to the generic
 * CV; a letter that cannot be written means no letter. Both are recorded as `fallback` in the ledgers,
 * a group of its own in the reports.
 *
 * The documents are kept per posting, in output/fm/<slug>-<key>/ (cv-….pdf, letter.txt, docs.json), so a
 * retry of the same job reuses them. The job sheet (tmp/fm/night/job-<N>.md) gets the CV path on its
 * "CV:" line and the letter between its docs markers.
 *
 * Usage:
 *   node freemotion-night/prepare-docs.mjs <num> [--driver agy|codex|sonnet1|...] [--force]
 *   node freemotion-night/prepare-docs.mjs <num> --required-letter   # a REQUIRED letter field and no letter: writes a short one
 *   node freemotion-night/prepare-docs.mjs <num> --letter-pdf        # the same letter as a PDF file, for a file field
 *   node freemotion-night/prepare-docs.mjs --sync                    # mark `sent` for the jobs submitted since
 */

import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { getCareerOpsRoot } from '../path-resolver.mjs';
import normalizeUrl from '../url-key.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { assignArm, markFallback, markSent } from '../lib/cv-experiment.mjs';
import { assignLetterArm, markLetterFallback, markLetterSent } from '../lib/letter-experiment.mjs';
import { loadPostingTexts } from '../lib/posting-text.mjs';
import { readCurrentState } from '../lib/freemotion-submissions.mjs';
import { appendLetterLog, openingOf } from '../lib/letter-check.mjs';
import { chainWriter, isOut, writerOrder, WRITER_ORDER } from '../lib/doc-writers.mjs';
import { buildCvContext, loadContextInputs } from '../cv-write.mjs';
import { loadLetterInputs, renderLetterPdf, writeLetter } from '../letter-write.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DOCS_START = '<!-- docs:start -->';
export const DOCS_END = '<!-- docs:end -->';
export const CV_REVISIONS = 1;
const shown = (p) => String(p).replace(/\\/g, '/');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
// The writers to try, in order: DOCS_WRITERS="codex agy" overrides; the job's driver leads when it is one.
const writerFor = (driver) => {
  const env = (process.env.DOCS_WRITERS || '').split(/\s+/).filter(Boolean);
  return chainWriter({ names: writerOrder({ first: driver, order: env.length ? env : WRITER_ORDER }), skip: (n) => isOut(n, REPO) });
};
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Where a posting's documents are kept: one folder per posting, whatever the job number. */
export function docsDir(root, job) {
  const key = createHash('sha1').update(normalizeUrl(job.url) || job.url).digest('hex').slice(0, 8);
  return join(root, 'output', 'fm', `${job.slug}-${key}`);
}

/** The generic CV: the "CV:" line of config/freemotion-candidate.md. */
export function genericCvPath(candidateMd) {
  return (String(candidateMd).match(/^CV:\s*(.+\.pdf)\s*$/m) ?? [])[1]?.trim() ?? '';
}

/** Email, phone… for a letter PDF's header: the candidate file's "Name · Name · email · phone" line. */
export function contactLine(candidateMd) {
  const line = String(candidateMd).split('\n').find((l) => l.includes('@') && l.includes(' · '));
  return line ? line.split(' · ').slice(2).join(' · ').trim() : '';
}

/**
 * What the sheet says about the CV and the letter, between the docs markers.
 * @param {number|string} num
 * @param {{text?: string}} [letter] the letter to paste; none = no letter for this job
 */
export function docsBlock(num, letter = {}) {
  const cv = '- CV: upload the file on the "CV:" line above, and no other CV.';
  if (!letter.text) {
    return `${cv}
- No cover letter for this job. Leave every optional message / cover-letter / motivation field empty.
  If such a field is REQUIRED: run \`node freemotion-night/prepare-docs.mjs ${num} --required-letter\` and
  paste exactly the letter it prints. If it prints NO LETTER, finalize \`validation-failed\` with the note
  "required letter field, no letter available". Never write a letter yourself.`;
  }
  return `${cv}
- Cover letter / message / motivation field (optional or required): paste the letter below EXACTLY as
  written. Never write or reword a letter yourself. The form has no such field: leave the letter out.
  A box with a length limit: drop whole sentences from the end until it fits; add nothing, reword nothing.
  A field that wants the letter as a FILE: run \`node freemotion-night/prepare-docs.mjs ${num} --letter-pdf\`
  and upload the file it prints. Both a text box and a file field: use the text box, and the file only
  if that field is required.
----- LETTER START -----
${letter.text.trim()}
----- LETTER END -----`;
}

/** The sheet with this job's CV on its "CV:" line and `block` between the docs markers. */
export function patchSheet(sheet, { cvPath, block }) {
  const a = sheet.indexOf(DOCS_START);
  const b = sheet.indexOf(DOCS_END);
  if (a === -1 || b < a) throw new Error('the job sheet has no docs markers: write the sheets again with make-jobs.mjs');
  const out = `${sheet.slice(0, a + DOCS_START.length)}\n${block}\n${sheet.slice(b)}`;
  return cvPath ? out.replace(/^CV:\s*.*$/m, () => `CV: ${shown(cvPath)}`) : out;
}

/** Render a CV payload to a one-page PDF. @returns {Promise<{ok: boolean, reason?: string, factCheck?: string}>} */
export function renderCv(payloadPath, pdfPath, { skipFactCheck, root }) {
  return new Promise((res) => {
    const args = [join(REPO, 'generate-cv-typst.mjs'), payloadPath, pdfPath, ...(skipFactCheck ? ['--skip-fact-check'] : [])];
    const p = spawn(process.execPath, args, { cwd: root });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => res({ ok: false, reason: e.message }));
    p.on('close', (code) => {
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (code === 0 && j?.status === 'ok' && existsSync(pdfPath)) res({ ok: true, factCheck: j.factCheck });
      else res({ ok: false, reason: String(err || out || `render exit ${code}`).replace(/s+/g, ' ').trim().slice(0, 600) });
    });
  });
}

async function makeCv({ arm, jdPath, lang, dir, generic, root, write, render }) {
  if (arm === 'generic') return { arm, path: generic, tailored: false };
  try {
    if (!jdPath) throw new Error('no posting text saved for this job');
    const inputs = loadContextInputs({ jd: jdPath, root });
    const payloadPath = join(dir, 'cv.json');
    // The same file name as the generic CV: the employer sees no difference between the arms.
    const pdf = join(dir, basename(generic) || 'cv.pdf');
    // A payload the renderer refuses (a must-keep role left out, over one page, the fact gate) gets
    // CV_REVISIONS more tries, each told why the last one was refused.
    let retry;
    for (let attempt = 0; ; attempt++) {
      const { payload } = await write(buildCvContext({ ...inputs, arm, lang, retry }));
      writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
      const r = await render(payloadPath, pdf, { skipFactCheck: arm === 'loose', root });
      if (r.ok) return { arm, path: pdf, tailored: true, writer: write.used.at(-1) ?? null, factCheck: r.factCheck ?? null, attempts: attempt + 1 };
      if (attempt >= CV_REVISIONS) throw new Error(`render: ${r.reason}`);
      retry = r.reason;
    }
  } catch (e) {
    return { arm, path: generic, tailored: false, fallback: oneLine(e.message) };
  }
}

async function makeLetter({ arm, versions, jdPath, lang, dir, job, root, write }) {
  if (!versions.length) return { arm, version: null, path: null };
  let why = 'no posting text saved for this job';
  if (jdPath) {
    for (const version of versions) {
      try {
        const r = await writeLetter({ inputs: loadLetterInputs({ jd: jdPath, root }), version, format: 'form', lang, root, write });
        if (!r.ok) { why = `${version} letter refused by the checks: ${r.check.problems.slice(0, 2).join('; ')}`; continue; }
        const path = join(dir, 'letter.txt');
        writeFileSync(join(dir, 'letter.json'), JSON.stringify(r.letter, null, 2));
        writeFileSync(path, r.text);
        appendLetterLog(root, { company: job.co, role: job.title, version, promptVersion: r.promptVersion, language: r.check.language, arm, textPath: path, opening: openingOf(r.text) });
        const fallback = version === arm ? undefined : `${arm} letter not made (${why}); ${version} sent instead`;
        return { arm, version, path, words: r.check.words, writer: write.used.at(-1) ?? null, ...(fallback ? { fallback } : {}) };
      } catch (e) {
        why = e.message;   // no writer answered: the shorter version would fail the same way
        break;
      }
    }
  }
  return { arm, version: null, path: null, fallback: oneLine(why) };
}

/**
 * Make (or reuse) the documents for one job.
 * @param {{num: number, url: string, co: string, title: string, slug: string, english?: boolean, run?: string}} job
 * @param {{root?: string, driver?: string, force?: boolean, write?: Function, render?: Function}} [o]
 */
export async function prepareDocs(job, { root = getCareerOpsRoot(), driver, force = false, write, render = renderCv } = {}) {
  const dir = docsDir(root, job);
  const statePath = join(dir, 'docs.json');
  const prior = readJson(statePath);
  if (prior && !force && existsSync(prior.cv.path) && (!prior.letter.path || existsSync(prior.letter.path))) {
    const state = { ...prior, num: job.num, run: job.run ?? prior.run };
    writeFileSync(statePath, JSON.stringify(state, null, 1));
    return { ...state, reused: true };
  }
  mkdirSync(dir, { recursive: true });
  const candidateMd = readFileSync(join(root, 'config/freemotion-candidate.md'), 'utf8');
  const generic = genericCvPath(candidateMd);
  const lang = job.english ? 'en' : 'fr';
  const writer = write ?? writerFor(driver);

  // A failed draw must not stop an application: generic CV, short letter (the claim step's own rule).
  const meta = { company: job.co, role: job.title, root };
  let cvArm = 'generic';
  let letterArm = 'short';
  try { ({ arm: cvArm } = await assignArm(job.url, meta)); } catch {}
  try { ({ arm: letterArm } = await assignLetterArm(job.url, meta)); } catch {}

  const text = loadPostingTexts(root, [job.url]).get(job.url);
  let jdPath = null;
  if (text) {
    jdPath = join(dir, 'posting.md');
    writeFileSync(jdPath, `# ${job.title} — ${job.co}\n${job.url}\n\n${text}\n`);
  }

  const cv = await makeCv({ arm: cvArm, jdPath, lang, dir, generic, root, write: writer, render });
  const letter = await makeLetter({ arm: letterArm, versions: { none: [], short: ['short'], full: ['full', 'short'] }[letterArm], jdPath, lang, dir, job, root, write: writer });
  if (cv.fallback) { try { await markFallback(job.url, cv.fallback, { root }); } catch {} }
  if (letter.fallback) { try { await markLetterFallback(job.url, letter.fallback, { root }); } catch {} }

  const state = { num: job.num, run: job.run ?? null, url: job.url, company: job.co, role: job.title, lang, dir, cv, letter, at: new Date().toISOString(), sent: null };
  writeFileSync(statePath, JSON.stringify(state, null, 1));
  return state;
}

/** One line for the run log. */
export function summary(state) {
  const cv = state.cv.arm === 'generic' ? 'generic'
    : state.cv.tailored ? `${state.cv.arm}, written for this posting${state.cv.writer ? ` by ${state.cv.writer}` : ''}`
      : `${state.cv.arm} -> generic CV (${state.cv.fallback})`;
  const letter = state.letter.path ? `${state.letter.version}, ${state.letter.words ?? '?'} words${state.letter.fallback ? ` (drawn ${state.letter.arm})` : ''}`
    : state.letter.arm === 'none' ? 'none' : `${state.letter.arm} -> no letter (${state.letter.fallback})`;
  return `docs for job ${state.num}: CV ${cv} · letter ${letter}${state.reused ? ' · reused' : ''}`;
}

/** Put the documents into the job sheet and leave a copy of the state next to it. */
export function applyToSheet(state, nightDir) {
  const sheetPath = join(nightDir, `job-${state.num}.md`);
  const text = state.letter.path ? readFileSync(state.letter.path, 'utf8') : '';
  writeFileSync(sheetPath, patchSheet(readFileSync(sheetPath, 'utf8'), { cvPath: state.cv.path, block: docsBlock(state.num, { text }) }));
  writeFileSync(join(nightDir, `docs-${state.num}.json`), JSON.stringify(state, null, 1));
}

/**
 * Mark `sent` in both ledgers for every prepared posting the submissions log now shows as submitted.
 * Only sent postings count in the reports. Safe to run any time (after check-sent.py --fix too).
 * @returns {Promise<number>} how many were marked
 */
export async function syncSent({ root = getCareerOpsRoot() } = {}) {
  const base = join(root, 'output', 'fm');
  if (!existsSync(base)) return 0;
  const ledger = readCurrentState({ root });
  let marked = 0;
  for (const name of readdirSync(base)) {
    const statePath = join(base, name, 'docs.json');
    const state = readJson(statePath);
    if (!state || state.sent || ledger.get(normalizeUrl(state.url))?.outcome !== 'submitted') continue;
    try {
      await markSent(state.url, state.cv.path, { root });
      await markLetterSent(state.url, state.letter.path || '', { root });
    } catch { continue; }   // no arm on record for it: nothing to count
    writeFileSync(statePath, JSON.stringify({ ...state, sent: new Date().toISOString() }, null, 1));
    marked++;
  }
  return marked;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => argv.includes(f);
  const root = getCareerOpsRoot();
  const nightDir = join(REPO, 'tmp', 'fm', 'night');
  if (flag('--sync')) { console.log(`docs: ${await syncSent({ root })} sent application(s) marked in the CV and letter ledgers`); return; }
  const num = argv.find((a) => /^\d+$/.test(a));
  const job = num && readJson(join(nightDir, `job-${num}.json`));
  if (!job) { console.error(num ? `no tmp/fm/night/job-${num}.json: write the sheets again with make-jobs.mjs` : 'Usage: node freemotion-night/prepare-docs.mjs <num> [--driver D] [--force] | <num> --required-letter | <num> --letter-pdf | --sync'); process.exitCode = 1; return; }
  const driver = flag('--driver') ? argv[argv.indexOf('--driver') + 1] : undefined;

  if (flag('--required-letter') || flag('--letter-pdf')) {
    let state = readJson(join(docsDir(root, job), 'docs.json')) ?? await prepareDocs(job, { root });
    if (!state.letter.path && flag('--required-letter')) {
      const dir = docsDir(root, job);
      const jdPath = existsSync(join(dir, 'posting.md')) ? join(dir, 'posting.md') : null;
      const made = await makeLetter({ arm: state.letter.arm, versions: ['short'], jdPath, lang: state.lang, dir, job, root, write: writerFor() });
      if (made.path) {
        // The posting's arm did not decide this letter (none, or a refused one): its own group in the report.
        try { await markLetterFallback(job.url, 'required letter field: short letter written', { root }); } catch {}
        state = { ...state, letter: { ...made, fallback: 'required letter field: short letter written' } };
        writeFileSync(join(dir, 'docs.json'), JSON.stringify(state, null, 1));
        applyToSheet({ ...state, num: job.num }, nightDir);
      }
    }
    if (!state.letter.path) { console.log('NO LETTER'); process.exitCode = 2; return; }
    if (flag('--letter-pdf')) {
      const pdf = join(state.dir, state.lang === 'en' ? 'cover-letter-mohammad-machaka.pdf' : 'lettre-de-motivation-mohammad-machaka.pdf');
      const candidateMd = readFileSync(join(root, 'config/freemotion-candidate.md'), 'utf8');
      await renderLetterPdf(readJson(join(state.dir, 'letter.json')), pdf, { contact: contactLine(candidateMd), company: job.co });
      console.log(`LETTER FILE: ${shown(pdf)}`);
      return;
    }
    console.log(`LETTER (paste exactly as written):\n${readFileSync(state.letter.path, 'utf8').trim()}`);
    return;
  }

  // Not worth a CV: a posting already sent, or a company at its cap (the claim would refuse it anyway).
  if (readCurrentState({ root }).get(normalizeUrl(job.url))?.outcome === 'submitted') { console.log(`docs for job ${num}: already submitted, nothing made`); return; }
  if (spawnSync(process.execPath, [join(REPO, 'lib/company-cap.mjs'), '--check', job.co], { cwd: REPO }).status === 3) { console.log(`docs for job ${num}: ${job.co} is at its cap, nothing made`); return; }

  const state = await prepareDocs(job, { root, driver, force: flag('--force') });
  applyToSheet(state, nightDir);
  console.log(summary(state));
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error(`docs: ${e.message}`); process.exitCode = 1; });
