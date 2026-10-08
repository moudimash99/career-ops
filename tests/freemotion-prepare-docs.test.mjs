// tests/freemotion-prepare-docs.test.mjs — the CV and letter made right before each night job.
//
// What matters: the posting's drawn arm decides what is made; the sheet ends up naming exactly that CV
// and holding exactly that letter; a writer or a render that fails never stops the job (generic CV, no
// letter, recorded as `fallback`); and only a submitted posting is marked `sent`.
//
// Run: node test-all.mjs --only freemotion-prepare-docs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, rmSync } from './helpers.mjs';
import {
  DOCS_END, DOCS_START, applyToSheet, contactLine, docsBlock, genericCvPath, patchSheet, prepareDocs, summary, syncSent,
} from '../freemotion-night/prepare-docs.mjs';
import { chainWriter, writerOrder } from '../lib/doc-writers.mjs';
import { foldLedger, readLedger } from '../lib/cv-experiment.mjs';
import { LETTER_SPEC } from '../lib/letter-experiment.mjs';
import { savePostingTexts } from '../lib/posting-text.mjs';
import { claimSubmission, finalizeSubmission } from '../lib/freemotion-submissions.mjs';

console.log('\nfreemotion-prepare-docs — the CV and letter made before each job');
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass(label); else fail(`${label} => ${a}, expected ${e}`);
};

// ── the sheet ────────────────────────────────────────────────────────────
{
  const none = docsBlock(2301);
  const withLetter = docsBlock(2301, { text: 'Bonjour,\n\nUne phrase.\n' });
  check('no letter: optional fields stay empty, a required one has a command, never "write it yourself"',
    [/optional .* field empty/.test(none), none.includes('prepare-docs.mjs 2301 --required-letter'), /Never write a letter yourself/.test(none)], [true, true, true]);
  check('a letter is pasted word for word, with the file command for a file field',
    [withLetter.includes('----- LETTER START -----\nBonjour,\n\nUne phrase.\n----- LETTER END -----'), withLetter.includes('prepare-docs.mjs 2301 --letter-pdf'), /EXACTLY/.test(withLetter)], [true, true, true]);

  const sheet = `# Task\nCV: C:/old/cv.pdf\nAvailable now\n\n## CV and cover letter\n${DOCS_START}\n${none}\n${DOCS_END}\n\n## Never\n`;
  const once = patchSheet(sheet, { cvPath: 'C:\\out\\fm\\acme-1\\cv.pdf', block: withLetter });
  check('the sheet names this job\'s CV, with forward slashes', (once.match(/^CV: (.*)$/m) ?? [])[1], 'C:/out/fm/acme-1/cv.pdf');
  check('the letter replaces the default block and the rest of the sheet stays',
    [once.includes('LETTER START'), once.includes('--required-letter'), once.endsWith('## Never\n'), once.includes('Available now')], [true, false, true, true]);
  check('patching twice gives the same sheet', patchSheet(once, { cvPath: 'C:\\out\\fm\\acme-1\\cv.pdf', block: withLetter }), once);
  let threw = false;
  try { patchSheet('# an old sheet\nCV: x.pdf\n', { cvPath: 'y.pdf', block: none }); } catch { threw = true; }
  check('a sheet without the markers is refused, not silently left alone', threw, true);

  const cand = '<!-- note -->\n## Data\nMohammad · Machaka · m@example.com · +33 7 00 00 00 00\nCV: C:/x/output/cv-m.pdf\nAvailable 2026\n';
  check('the generic CV is the candidate file\'s CV line', genericCvPath(cand), 'C:/x/output/cv-m.pdf');
  check('contact line for a letter PDF', contactLine(cand), 'm@example.com · +33 7 00 00 00 00');
}

// ── writers ──────────────────────────────────────────────────────────────
{
  check('the job\'s driver writes first when it is a writer', writerOrder({ first: 'codex' }), ['codex', 'agy', 'sonnet1', 'copilot']);
  check('agy-sonnet counts as agy; copilot leads its own jobs', [writerOrder({ first: 'agy-sonnet' }), writerOrder({ first: 'copilot' })], [['agy', 'codex', 'sonnet1', 'copilot'], ['copilot', 'agy', 'codex', 'sonnet1']]);
  const calls = [];
  const writers = {
    agy: async () => { calls.push('agy'); throw new Error('quota exhausted'); },
    codex: async () => { calls.push('codex'); return { payload: { ok: 1 } }; },
    sonnet1: async () => { calls.push('sonnet1'); return { payload: { ok: 2 } }; },
  };
  const w = chainWriter({ names: ['agy', 'codex', 'sonnet1'], writers });
  check('a writer that fails hands over to the next', [(await w('ctx')).payload, calls, w.used], [{ ok: 1 }, ['agy', 'codex'], ['codex']]);
  const skipping = chainWriter({ names: ['agy', 'codex'], writers, skip: (n) => n === 'codex' });
  let msg = '';
  try { await skipping('ctx'); } catch (e) { msg = e.message; }
  check('a writer marked out is not called; when none answers it says why', [/no writer answered/.test(msg), /codex: out of quota/.test(msg)], [true, true]);
}

// ── a job, end to end, with a fake writer and a fake renderer ───────────
const root = mkdtempSync(join(tmpdir(), 'fm-docs-'));
try {
  for (const d of ['config', 'modes', 'data', 'night']) mkdirSync(join(root, d), { recursive: true });
  const generic = join(root, 'cv-generic.pdf');
  writeFileSync(generic, 'generic');
  writeFileSync(join(root, 'config/freemotion-candidate.md'), `## Data\nMo · M · m@example.com · 0700000000\nCV: ${generic.replace(/\\/g, '/')}\n`);
  writeFileSync(join(root, 'modes/_custom.md'), '# Custom\n\n## CV sections (x)\nkeep it short\n\n## Letter writing (y)\nplain words\n');
  writeFileSync(join(root, 'cv.md'), '# CV\nBuilt data pipelines in Python.\n');
  const weights = (cv, letter) => writeFileSync(join(root, 'config/profile.yml'),
    `cv_experiment:\n  weights: { generic: ${cv === 'generic' ? 1 : 0}, loose: ${cv === 'loose' ? 1 : 0}, strict: ${cv === 'strict' ? 1 : 0} }\nletter_experiment:\n  weights: { none: ${letter === 'none' ? 1 : 0}, short: ${letter === 'short' ? 1 : 0}, full: ${letter === 'full' ? 1 : 0} }\n`);
  const job = (n, slug) => ({ num: n, run: 'fm-test', url: `https://jobs.example/${slug}`, co: slug.toUpperCase(), title: 'Développeur Python', slug, english: false });
  const today = new Date().toISOString().slice(0, 10);
  savePostingTexts(root, ['a', 'b', 'c', 'd'].map((s) => ({ url: `https://jobs.example/${s}`, text: 'Nous cherchons un développeur Python pour nos pipelines de données.' })), today);

  const LETTER = { language: 'fr', greeting: 'Bonjour,', sign_off: 'Cordialement,', name: 'Mo M',
    paragraphs: ['Votre annonce pour un développeur Python sur les pipelines de données correspond à ce que je fais dans mon travail depuis plusieurs années. Je construis des pipelines en Python et je les garde en service pour les équipes qui en ont besoin.', 'Je suis à Toulouse et je peux vous en dire plus dans un échange quand vous voulez.'] };
  const seen = [];
  const write = Object.assign(async (context) => {
    const kind = context.startsWith('Write the CV payload') ? 'cv' : 'letter';
    seen.push(kind);
    return { payload: kind === 'cv' ? { candidate: { name: 'Mo M' } } : LETTER, usage: {} };
  }, { used: ['agy'] });
  let renders = [];
  const render = async (payload, pdf, o) => { renders.push(o.skipFactCheck); writeFileSync(pdf, 'tailored'); return { ok: true, factCheck: o.skipFactCheck ? 'skipped' : 'pass' }; };
  const sheetFor = (n) => writeFileSync(join(root, 'night', `job-${n}.md`), `# Task\nCV: ${generic.replace(/\\/g, '/')}\n\n${DOCS_START}\n${docsBlock(n)}\n${DOCS_END}\n`);

  // strict CV + short letter
  weights('strict', 'short');
  const a = await prepareDocs(job(1, 'a'), { root, write, render });
  check('strict: a CV written for the posting, same file name as the generic one, fact gate on',
    [a.cv.arm, a.cv.tailored, a.cv.path !== generic, a.cv.path.endsWith('cv-generic.pdf'), renders], ['strict', true, true, true, [false]]);
  check('short letter written, checked and saved', [a.letter.arm, a.letter.version, existsSync(a.letter.path), !!a.letter.fallback], ['short', 'short', true, false]);
  sheetFor(1);
  applyToSheet(a, join(root, 'night'));
  const sheetA = readFileSync(join(root, 'night', 'job-1.md'), 'utf8');
  check('the sheet now names that CV and holds that letter', [sheetA.includes(`CV: ${a.cv.path.replace(/\\/g, '/')}`), sheetA.includes('Votre annonce pour un développeur Python'), existsSync(join(root, 'night', 'docs-1.json'))], [true, true, true]);
  check('one line for the run log', summary(a), 'docs for job 1: CV strict, written for this posting by agy · letter short, 63 words');

  const before = seen.length;
  const again = await prepareDocs({ ...job(7, 'a') }, { root, write, render });
  check('a retry of the same posting reuses the documents (no writer call), under its new number', [seen.length - before, again.reused, again.num, again.cv.path], [0, true, 7, a.cv.path]);

  // loose CV skips the fact gate; no letter for the none arm
  weights('loose', 'none');
  renders = [];
  const b = await prepareDocs(job(2, 'b'), { root, write, render });
  check('loose: tailored, fact gate skipped; none: no letter and no fallback', [b.cv.arm, b.cv.tailored, renders, b.letter.path, !!b.letter.fallback], ['loose', true, [true], null, false]);

  // a refused payload gets one revision, told why
  {
    const contexts = [];
    const w2 = Object.assign(async (context) => { contexts.push(context); return { payload: { candidate: {} }, usage: {} }; }, { used: ['agy'] });
    let n = 0;
    const flaky = async (payload, pdf) => (++n === 1 ? { ok: false, reason: 'leaves out role(s) that must always appear: Airbus' } : (writeFileSync(pdf, 'tailored'), { ok: true }));
    savePostingTexts(root, [{ url: 'https://jobs.example/e', text: 'Nous cherchons un développeur Python.' }], today);
    const e = await prepareDocs(job(5, 'e'), { root, write: w2, render: flaky });
    check('a refused CV is written again with the reason, and then goes out', [e.cv.tailored, e.cv.attempts, !!e.cv.fallback, contexts.length, contexts[1].includes('YOUR LAST PAYLOAD WAS REFUSED') && contexts[1].includes('Airbus'), contexts[0].includes('WAS REFUSED')], [true, 2, false, 2, true, false]);
  }

  // generic CV: no writer call for the CV
  weights('generic', 'none');
  const n0 = seen.length;
  const c = await prepareDocs(job(3, 'c'), { root, write, render });
  check('generic: the candidate file\'s CV, nothing written', [c.cv.path, c.cv.tailored, seen.length - n0], [generic.replace(/\\/g, '/'), false, 0]);

  // failures fall back and are recorded
  weights('strict', 'full');
  const bad = Object.assign(async (context) => {
    if (context.startsWith('Write the CV payload')) return { payload: { candidate: {} }, usage: {} };
    return { payload: { ...LETTER, paragraphs: ['Trop court.'] }, usage: {} };
  }, { used: [] });
  const d = await prepareDocs(job(4, 'd'), { root, write: bad, render: async () => ({ ok: false, reason: 'CV is still 2 pages' }) });
  check('a CV that does not render: the generic CV goes out', [d.cv.arm, d.cv.path, d.cv.tailored, /2 pages/.test(d.cv.fallback)], ['strict', generic.replace(/\\/g, '/'), false, true]);
  check('a letter the checks refuse (full, then short): no letter', [d.letter.arm, d.letter.path, /refused/.test(d.letter.fallback)], ['full', null, true]);
  const cvLedger = foldLedger(readLedger({ root }));
  const letterLedger = foldLedger(readLedger({ root, spec: LETTER_SPEC }));
  const rec = (m, s) => [...m.values()].find((r) => r.url.endsWith(`/${s}`));
  check('both fallbacks are in the ledgers', [rec(cvLedger, 'd').fallback, rec(letterLedger, 'd').fallback, rec(cvLedger, 'a').fallback], [true, true, false]);

  // only a submitted posting counts
  await claimSubmission(job(1, 'a').url, { runId: 'fm-test', company: 'A', role: 'r', root });
  await finalizeSubmission(job(1, 'a').url, 'submitted', { runId: 'fm-test', root });
  await claimSubmission(job(2, 'b').url, { runId: 'fm-test', company: 'B', role: 'r', root });
  await finalizeSubmission(job(2, 'b').url, 'errored', { runId: 'fm-test', root });
  check('sync marks the submitted posting, and only once', [await syncSent({ root }), await syncSent({ root })], [1, 0]);
  const after = foldLedger(readLedger({ root }));
  check('sent is recorded with the CV that went out', [rec(after, 'a').sent, rec(after, 'a').pdf === a.cv.path, rec(after, 'b').sent], [true, true, false]);
  check('the letter ledger has it too', rec(foldLedger(readLedger({ root, spec: LETTER_SPEC })), 'a').sent, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── the tracked site link (issue #11) ───────────────────────────────────
{
  const { withSheetSiteLink } = await import('../freemotion-night/prepare-docs.mjs');
  const { replaceSiteMentions, getSiteLink } = await import('../lib/site-links.mjs');
  const link = 'https://machaka.net/r/k3m9xq';
  const sheet = 'LinkedIn https://www.linkedin.com/in/x · Website https://machaka.net\nCV: C:/x.pdf\n';
  const out = withSheetSiteLink(sheet, link);
  check('the sheet\'s Website line gets this application\'s link, the rest stays', [out.includes(`Website ${link}\n`), out.includes('linkedin.com/in/x'), out.includes('CV: C:/x.pdf')], [true, true, true]);
  check('written again with another link: replaced, not appended', withSheetSiteLink(out, 'https://machaka.net/r/zz11aa').includes('Website https://machaka.net/r/zz11aa\n'), true);
  check('a letter\'s bare machaka.net becomes the tracked link', replaceSiteMentions('Mon site : machaka.net. Merci.', link), `Mon site : ${link}. Merci.`);
  check('a letter without the site is unchanged', replaceSiteMentions('Bonjour,\nMerci.', link), 'Bonjour,\nMerci.');
  const tmp = mkdtempSync(join(tmpdir(), 'site-'));
  const plain = await getSiteLink({ url: 'https://example.com/job/1', company: 'Acme', role: 'R', root: tmp, env: { SITE_URL: 'https://machaka.net' } });
  check('no site key: the plain link, untracked, nothing registered', [plain?.url, plain?.tracked], ['https://machaka.net', false]);
  rmSync(tmp, { recursive: true, force: true });
}
