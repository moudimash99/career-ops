// tests/letter.test.mjs — cover letters: checks, context, rollout, experiment.
// Run: node test-all.mjs --only letter
import { pass, fail, rmSync, ROOT } from './helpers.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nletters — checks, context, rollout, experiment');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const chk = await imp('lib/letter-check.mjs');
const lw = await imp('letter-write.mjs');
const ro = await imp('lib/letter-rollout.mjs');
const lx = await imp('lib/letter-experiment.mjs');

const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass(label); else fail(`${label} => ${a}, expected ${e}`);
};
const roots = [];
const tmpRoot = () => { const r = mkdtempSync(join(tmpdir(), 'letter-')); roots.push(r); mkdirSync(join(r, 'data'), { recursive: true }); return r; };

// ── language + checks ─────────────────────────────────────────────────
const FR = 'Bonjour,\n\nChez Green Praxis, je gérais les déploiements de la plateforme sur AWS avec Terraform et Helm. Le travail avec les équipes de développement est ce que je préfère dans ce poste à Blagnac, et je veux continuer dans cette voie. J\'ai aussi monté une chaîne Jenkins chez Murex pour les tests.\n\nJe suis à Toulouse et disponible à partir de novembre 2026. On peut en parler quand cela vous arrange.\n\nCordialement,\nMohammad Machaka';
const EN = 'Hello,\n\nI ran the platform deployments at Green Praxis on AWS with Terraform and Helm. The part of this job I like is working with the developers, and I want to keep doing that. At Murex I set up a Jenkins pipeline for the tests.\n\nI am in Toulouse and free from November 2026. Happy to talk whenever suits you.\n\nBest,\nMohammad Machaka';
check('language detection', [chk.detectLanguage(FR), chk.detectLanguage(EN), chk.detectLanguage('ok')], ['fr', 'en', 'unknown']);
const okShort = chk.checkLetter({ text: FR, version: 'short', postingLanguage: 'fr', factCheck: false });
check('a plain French short letter passes', [okShort.ok, okShort.problems], [true, []]);
check('wrong language is a problem', chk.checkLetter({ text: EN, version: 'short', postingLanguage: 'fr', factCheck: false }).problems.some((p) => p.startsWith('written in en')), true);
check('too short for a full letter', chk.checkLetter({ text: FR, version: 'full', postingLanguage: 'fr', factCheck: false }).problems.some((p) => /words; a full letter/.test(p)), true);
const dead = chk.checkLetter({ text: FR.replace('Chez Green Praxis', 'Fort de mon expérience chez Green Praxis'), version: 'short', postingLanguage: 'fr', factCheck: false });
check('French dead phrase caught', dead.problems.includes('dead phrase: "fort de"'), true);
check('« En tant que » opening caught', chk.checkLetter({ text: FR.replace('Chez Green Praxis, je', 'En tant que ingénieur, je'), version: 'short', factCheck: false }).problems.includes('sentence opens with « En tant que »'), true);
check('layout leftovers caught', chk.checkLetter({ text: FR + '\n• Cover Letter: x', version: 'short', factCheck: false }).problems.filter((p) => p.startsWith('layout leftover')).length >= 2, true);
const again = chk.checkLetter({ text: FR, version: 'short', factCheck: false, recent: [{ opening: chk.openingOf(FR), text: '' }] });
check('a repeated opening is caught', again.problems.some((p) => p.startsWith('opening repeats')), true);
const copy = chk.checkLetter({ text: FR, version: 'short', factCheck: false, recent: [{ opening: 'something else entirely here', text: FR }] });
check('copied passages are caught', copy.problems.some((p) => p.startsWith('copies long passages')), true);
check('"as an AI Pipeline Developer" is a job title, not a finding', chk.checkLetter({ text: EN.replace('At Murex', 'As an AI Pipeline Developer at ZAKA I built things. At Murex'), version: 'short', factCheck: false }).problems.some((p) => /meta commentary/.test(p)), false);

// ── context + text ────────────────────────────────────────────────────
const customMd = '# c\n\n## House Rules\nnope\n\n## Letter writing (x)\nLETTER RULES HERE\n\n## Application language (y)\nFR when French\n';
const parts = lw.promptParts({ customMd, voiceDna: 'VOICE GUIDE', essaysYml: 'essays:\n  - match: a\n    answer: TONE ONE\n  - match: b\n    answer: TONE TWO\n  - match: c\n    answer: TONE THREE\n' });
check('prompt parts: letter rules, voice guide, first 2 tone examples', [parts.rules.length, parts.voiceDna, parts.examples], [2, 'VOICE GUIDE', ['TONE ONE', 'TONE TWO']]);
const ctx = lw.buildLetterContext({ parts, cvMd: 'MY CV', jdText: 'THE JOB', version: 'short', format: 'form', lang: 'fr' });
check('context holds rules, guide, tone, CV and posting, not other sections',
  ['LETTER RULES HERE', 'FR when French', 'VOICE GUIDE', 'TONE ONE', 'MY CV', 'THE JOB', 'nope'].map((x) => ctx.includes(x)), [true, true, true, true, true, true, false]);
check('prompt version changes with the rules', lw.promptVersion(parts) !== lw.promptVersion({ ...parts, rules: ['other'] }), true);
check('letter text assembly', lw.letterText({ greeting: 'Bonjour,', paragraphs: ['Un.', ' ', 'Deux.'], sign_off: 'Cordialement,' }), 'Bonjour,\n\nUn.\n\nDeux.\n\nCordialement,\nMohammad Machaka');
const html = lw.letterHtml({ language: 'fr', greeting: 'Madame, Monsieur,', paragraphs: ['A & B'], sign_off: 'Bien cordialement,' }, { company: 'Acme', city: 'Blagnac' });
check('PDF letter: escaped, no title, no bullets', [html.includes('A &amp; B'), /cover letter/i.test(html), html.includes('•'), html.includes('Acme, Blagnac')], [true, false, false, true]);

// ── rollout ───────────────────────────────────────────────────────────
let st = ro.registerCurrent(null, 'v1');
check('first version becomes stable', [st.stable, st.candidate], ['v1', null]);
check('same version changes nothing', ro.registerCurrent(st, 'v1'), st);
st = ro.registerCurrent(st, 'v2', '2026-09-25T00:00:00Z');
check('a new version becomes the candidate at 20%', [st.candidate, ro.STAGES[st.stage]], ['v2', 20]);
check('choose: below the share → candidate, above → stable', [ro.chooseVersion(st, () => 0.1), ro.chooseVersion(st, () => 0.5)], ['v2', 'v1']);
for (let i = 0; i < ro.STAGE_SIZE; i++) st = ro.recordWritten(st, 'v2', {});
check('after a stage of letters it moves to 50%', [st.candidate, ro.STAGES[st.stage], st.written], ['v2', 50, 0]);
for (let i = 0; i < ro.STAGE_SIZE; i++) st = ro.recordWritten(st, 'v2', {});
check('then it takes over', [st.stable, st.candidate, st.previous], ['v2', null, 'v1']);
let held = ro.registerCurrent({ stable: 'a', candidate: null, stage: 0, written: 0 }, 'b');
for (let i = 0; i < ro.STAGE_SIZE; i++) held = ro.recordWritten(held, 'b', { a: 1 });
check('holds when the old version got a callback and the new one none', [held.stage, Boolean(held.held)], [0, true]);
check('letters written by the stable version do not count', ro.recordWritten(held, 'a', {}), held);

// ── writeLetter: retry once, then refuse ──────────────────────────────
{
  const root = tmpRoot();
  const inputs = { parts, cvMd: 'cv', jdText: 'Bonjour, poste à Blagnac pour une équipe de développement web et la production.' };
  let calls = 0;
  const bad = { greeting: 'Bonjour,', paragraphs: ['Fort de mon expérience, je veux ce poste.'], sign_off: 'Cordialement,' };
  const r1 = await lw.writeLetter({ inputs, version: 'short', format: 'form', root, rollout: false, write: async () => { calls++; return { payload: bad, usage: {} }; } });
  check('a failing draft is retried once, then refused', [r1.ok, r1.attempts, calls], [false, 2, 2]);
  let n = 0;
  const good = { greeting: 'Bonjour,', paragraphs: FR.split('\n\n').slice(1, 3), sign_off: 'Cordialement,' };
  const r2 = await lw.writeLetter({ inputs, version: 'short', format: 'form', root, rollout: false, write: async (ctxText) => { n++; return { payload: n === 1 ? bad : good, usage: {} }; } });
  check('the retry can pass', [r2.ok, r2.attempts], [true, 2]);
}

// ── letter experiment: its own ledger, its own arms ───────────────────
{
  const root = tmpRoot();
  const a = await lx.assignLetterArm('https://jobs.example.com/1', { root, rng: () => 0.05 });
  check('letter arms draw none/short/full (rng 0.05 → none)', a.arm, 'none');
  check('the letter ledger is its own file', [existsSync(join(root, 'data/letter-experiment.tsv')), existsSync(join(root, 'data/cv-experiment.tsv'))], [true, false]);
  const again2 = await lx.assignLetterArm('https://jobs.example.com/1', { root, rng: () => 0.99 });
  check('a posting keeps its letter arm', again2.arm, 'none');
}

// ── sample ────────────────────────────────────────────────────────────
{
  const root = tmpRoot();
  const t1 = join(root, 'a.txt'); writeFileSync(t1, 'letter A');
  const t2 = join(root, 'b.txt'); writeFileSync(t2, 'letter B');
  chk.appendLetterLog(root, { company: 'A', role: 'r', version: 'full', promptVersion: 'v1', language: 'fr', textPath: t1, opening: 'x' });
  chk.appendLetterLog(root, { company: 'B', role: 'r', version: 'short', promptVersion: 'v1', language: 'fr', textPath: t2, opening: 'y' });
  const s = lw.sampleLetters(root, { n: 3 });
  check('sample returns up to n letters with their text', [s.length, s.map((x) => x.text).sort()], [2, ['letter A', 'letter B']]);
  check('sample respects --since', lw.sampleLetters(root, { n: 3, since: '2999-01-01' }).length, 0);
}

for (const r of roots) if (existsSync(r)) rmSync(r, { recursive: true, force: true });
