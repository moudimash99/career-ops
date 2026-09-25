#!/usr/bin/env node

// Cover letter writer: agy writes the letter from ONE pasted context, then
// lib/letter-check.mjs checks it before anything is sent.
//
// The context reuses the rules already in the repo instead of a new prompt:
//   - modes/_custom.md "Letter writing" (+ "Application language")
//   - voice-dna.md (the anti-AI-slop guide: banned words, patterns, rhythm)
//   - config/apply-essays.yml, first answers, as TONE examples (the
//     hand-tuned "someone typing into a form" register)
//   - cv.md verbatim, and the posting
//
// A draft that fails the checks gets ONE retry with the problems listed. If
// the retry fails too, nothing is written as the letter (exit 2) and the
// caller falls back (short letter, or no letter): a bad letter is worse than
// none.
//
// A changed prompt ramps up gradually (lib/letter-rollout.mjs): the new
// version writes 20%, then 50% of letters, then takes over.
//
// Usage:
//   node letter-write.mjs --jd jds/x.md --version short|full --format form|pdf
//        --out output/letters/x.json [--text x.txt] [--pdf x.pdf]
//        [--lang fr|en] [--company C --role R --city T] [--arm A]
//   node letter-write.mjs --jd jds/x.md ... --context-only <context.md>
//   node letter-write.mjs --jd jds/x.md --version short|full --check <letter.json>
//        --prompt-version <id> [--company C --role R --arm A]
//        (Free Motion: agy wrote the letter itself from --context-only; this
//        runs the same checks, logs it and advances the rollout)
//   node letter-write.mjs --sample 3 [--since <ISO time>]    # letters to skim

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { markdownSections, writeWithAgy } from './cv-write.mjs';
import {
  LETTER_LOG_RELATIVE_PATH, appendLetterLog, checkLetter, detectLanguage, openingOf, parseVoiceDna, recentLetters,
} from './lib/letter-check.mjs';
import {
  chooseVersion, loadSnapshot, loadState, rampCallbacks, recordWritten, registerCurrent, saveSnapshot, saveState, STAGES,
} from './lib/letter-rollout.mjs';

export const VERSIONS = ['short', 'full'];
export const FORMATS = ['form', 'pdf'];
const LANGS = { fr: 'French', en: 'English' };

/** The _custom.md sections that govern letters. */
export function letterRuleSections(customMd) {
  return markdownSections(customMd)
    .filter(({ title }) => /^Letter writing/i.test(title) || /^Application language/i.test(title))
    .map(({ body }) => body);
}

/** The first `n` hand-tuned essay answers, as tone examples. */
export function toneExamples(essaysYml, n = 2) {
  try {
    const doc = yaml.load(essaysYml) || {};
    return (doc.essays || []).slice(0, n).map((e) => String(e.answer || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** The prompt as it is in the files now: rules + voice guide + tone examples. */
export function promptParts({ customMd, voiceDna, essaysYml }) {
  const rules = letterRuleSections(customMd);
  if (!rules.length) throw new Error('no "## Letter writing" section in modes/_custom.md');
  return { rules, voiceDna: String(voiceDna || '').trim(), examples: toneExamples(essaysYml) };
}

/** Short stable id of a prompt version. */
export function promptVersion(parts) {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 8);
}

export function buildLetterContext({ parts, cvMd, jdText, version = 'full', format = 'form', lang, retry }) {
  if (!VERSIONS.includes(version)) throw new Error(`--version must be one of ${VERSIONS.join(', ')}`);
  if (!FORMATS.includes(format)) throw new Error(`--format must be one of ${FORMATS.join(', ')}`);
  const language = LANGS[lang] ? `LANGUAGE: ${LANGS[lang]} (the posting's language).` : "LANGUAGE: the posting's language.";
  const where = format === 'form'
    ? 'It goes into an application form text field (plain text).'
    : 'It becomes a one-page PDF letter.';
  const examples = parts.examples.length
    ? `=== TONE EXAMPLES (approved answers in the right register: match how they SOUND; take no facts from them, their content may be outdated) ===\n${parts.examples.map((e, i) => `--- example ${i + 1} ---\n${e}`).join('\n\n')}\n\n`
    : '';
  const retryBlock = retry
    ? `=== YOUR FIRST DRAFT FAILED THESE CHECKS — WRITE A NEW ONE THAT PASSES ===\n${retry.problems.map((x) => `- ${x}`).join('\n')}\n\nFirst draft (do not reuse its sentences):\n${retry.text}\n\n`
    : '';
  return `Write one ${version} cover letter for this job application, as JSON.
Everything you need is in this file. Do not open or read any other file.

VERSION: ${version}. FORMAT: ${format}. ${where}
${language}
Facts come ONLY from the CV below. Follow the letter rules; the voice guide
lists the words and patterns that make text read as machine-written.

Reply with this JSON and nothing else:
{"language": "fr" or "en", "greeting": "...", "paragraphs": ["...", "..."], "sign_off": "...", "name": "Mohammad Machaka"}

${retryBlock}=== LETTER RULES ===
${parts.rules.join('\n\n')}

=== VOICE GUIDE (voice-dna.md) ===
${parts.voiceDna}

${examples}=== THE CANDIDATE'S CV ===
${cvMd}

=== THE POSTING ===
${jdText}
`;
}

/** The letter as plain text: greeting, paragraphs, sign-off, name. */
export function letterText(letter) {
  const paras = (letter.paragraphs || []).map((p) => String(p).trim()).filter(Boolean);
  return [String(letter.greeting || '').trim(), ...paras, [String(letter.sign_off || '').trim(), String(letter.name || 'Mohammad Machaka').trim()].filter(Boolean).join('\n')]
    .filter(Boolean).join('\n\n');
}

export function loadLetterInputs({ jd, root = getCareerOpsRoot() }) {
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : '');
  const jdPath = resolve(jd);
  if (!existsSync(jdPath)) throw new Error(`posting not found: ${jd}`);
  return {
    parts: promptParts({ customMd: read('modes/_custom.md'), voiceDna: read('voice-dna.md'), essaysYml: read('config/apply-essays.yml') }),
    cvMd: read('cv.md'),
    jdText: readFileSync(jdPath, 'utf8'),
  };
}

/**
 * Pick the prompt version for this letter (gradual rollout) and return its parts.
 * @returns {{id: string, parts: object, state: object}}
 */
export function rolloutPick(root, currentParts, rng = Math.random) {
  const currentId = promptVersion(currentParts);
  saveSnapshot(root, currentId, currentParts);
  const state = registerCurrent(loadState(root), currentId);
  saveState(root, state);
  const id = chooseVersion(state, rng);
  const parts = id === currentId ? currentParts : (loadSnapshot(root, id) || currentParts);
  return { id: id === currentId || loadSnapshot(root, id) ? id : currentId, parts, state };
}

/**
 * Write a letter with agy, check it, retry once on failure.
 * @returns {Promise<{ok: boolean, letter?: object, text?: string, check: object, attempts: number, promptVersion: string, usage: object[]}>}
 */
export async function writeLetter({ inputs, version, format, lang, root, write = writeWithAgy, rollout = true, rng = Math.random }) {
  const postingLanguage = lang || detectLanguage(inputs.jdText);
  const recent = recentLetters(root);
  const voiceRules = existsSync(join(root, 'voice-dna.md')) ? parseVoiceDna(join(root, 'voice-dna.md')) : undefined;
  const pick = rollout ? rolloutPick(root, inputs.parts, rng) : { id: promptVersion(inputs.parts), parts: inputs.parts, state: null };
  const usage = [];
  let retry;
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const context = buildLetterContext({ parts: pick.parts, cvMd: inputs.cvMd, jdText: inputs.jdText, version, format, lang: postingLanguage, retry });
    const res = await write(context);
    usage.push(res.usage || {});
    const text = letterText(res.payload);
    const check = checkLetter({ text, version, postingLanguage, recent, voiceRules });
    last = { letter: res.payload, text, check };
    if (check.ok) {
      let state = pick.state;
      if (rollout && state) {
        state = recordWritten(state, pick.id, rampCallbacks(root, state));
        saveState(root, state);
      }
      return { ok: true, ...last, attempts: attempt, promptVersion: pick.id, rollout: state, usage };
    }
    retry = { problems: check.problems, text };
  }
  return { ok: false, ...last, attempts: 2, promptVersion: pick.id, rollout: pick.state, usage };
}

// ── PDF ────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A plain one-page letter: contact header, place/date, the letter. No title, no bullets. */
export function letterHtml(letter, { contact = '', company = '', city = '', date = new Date() } = {}) {
  const lang = letter.language === 'en' ? 'en' : 'fr';
  const when = date.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const place = lang === 'fr' ? `Toulouse, le ${when}` : `Toulouse, ${when}`;
  const paras = (letter.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('\n');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 22mm 22mm 20mm 22mm; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; line-height: 1.45; color: #111; }
.name { font-size: 15pt; font-weight: bold; margin: 0; }
.contact { color: #333; margin: 2px 0 18px; font-size: 10pt; }
.meta { margin: 0 0 18px; }
p { margin: 0 0 10px; }
.sign { margin-top: 16px; }
</style></head><body>
<p class="name">${esc(letter.name || 'Mohammad Machaka')}</p>
<p class="contact">${esc(contact)}</p>
<p class="meta">${company ? `${esc(company)}${city ? `, ${esc(city)}` : ''}<br>` : ''}${esc(place)}</p>
<p>${esc(letter.greeting)}</p>
${paras}
<p class="sign">${esc(letter.sign_off)}<br>${esc(letter.name || 'Mohammad Machaka')}</p>
</body></html>`;
}

export async function renderLetterPdf(letter, pdfPath, meta = {}) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(letterHtml(letter, meta), { waitUntil: 'load' });
    mkdirSync(dirname(pdfPath), { recursive: true });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

// ── Sample (end of a run) ──────────────────────────────────────────────
export function sampleLetters(root, { n = 3, since, rng = Math.random } = {}) {
  const path = join(root, LETTER_LOG_RELATIVE_PATH);
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.split('\t'))
    .filter((p) => p.length >= 9 && p[0] !== 'timestamp' && (!since || p[0] >= since))
    .map((p) => ({ timestamp: p[0], company: p[1], role: p[2], version: p[3], promptVersion: p[4], textPath: p[7] }))
    .filter((r) => r.textPath && existsSync(r.textPath));
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, n).map((r) => ({ ...r, text: readFileSync(r.textPath, 'utf8') }));
}

function parseArgs(argv) {
  const o = {};
  const names = ['--jd', '--version', '--format', '--out', '--text', '--pdf', '--lang', '--company', '--role', '--city', '--arm', '--context-only', '--sample', '--since', '--contact', '--check', '--prompt-version'];
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i])) o[argv[i].slice(2)] = argv[++i];
    else if (argv[i] === '--no-rollout') o.noRollout = true;
    else if (argv[i] === '--help' || argv[i] === '-h') o.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; return; }
  const root = getCareerOpsRoot();

  if (o.sample) {
    const letters = sampleLetters(root, { n: Number(o.sample) || 3, since: o.since });
    if (!letters.length) { console.log('No letters were written in this run.'); return; }
    console.log(`Hey, here are ${letters.length} letter(s) from this run:\n`);
    for (const l of letters) {
      console.log(`──── ${l.company || '?'} · ${l.role || '?'} (${l.version}, prompt ${l.promptVersion})`);
      console.log(l.text.trim());
      console.log('');
    }
    return;
  }

  const usage = 'Usage: node letter-write.mjs --jd <posting.md> --version short|full --format form|pdf (--out <letter.json> [--text x.txt] [--pdf x.pdf] | --context-only <context.md>) [--lang fr|en] [--company C --role R --city T] [--arm A]\n       node letter-write.mjs --sample 3 [--since <ISO time>]';
  if (o.help || !o.jd || (!o.out && !o['context-only'] && !o.check)) { console.error(usage); process.exitCode = o.help ? 0 : 1; return; }
  const version = o.version || 'full';
  const format = o.format || 'form';
  try {
    const inputs = loadLetterInputs({ jd: o.jd, root });
    if (o.check) {
      const jsonPath = resolve(o.check);
      const letter = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const text = letterText(letter);
      const voiceRules = existsSync(join(root, 'voice-dna.md')) ? parseVoiceDna(join(root, 'voice-dna.md')) : undefined;
      const res = checkLetter({ text, version, postingLanguage: o.lang || detectLanguage(inputs.jdText), recent: recentLetters(root), voiceRules });
      if (!res.ok) {
        console.log(JSON.stringify({ status: 'rejected', problems: res.problems, warnings: res.warnings }, null, 2));
        process.exitCode = 2;
        return;
      }
      const textPath = resolve(o.text || jsonPath.replace(/\.json$/i, '') + '.txt');
      writeFileSync(textPath, text);
      const pv = o['prompt-version'] || promptVersion(inputs.parts);
      let state = loadState(root);
      if (state) { state = recordWritten(state, pv, rampCallbacks(root, state)); saveState(root, state); }
      let pdf = null;
      if (o.pdf) {
        pdf = resolve(o.pdf);
        await renderLetterPdf(letter, pdf, { contact: o.contact || '', company: o.company || '', city: o.city || '' });
      }
      appendLetterLog(root, { company: o.company, role: o.role, version, promptVersion: pv, language: res.language, arm: o.arm, textPath, opening: openingOf(text) });
      console.log(JSON.stringify({ status: 'ok', text: textPath, pdf, words: res.words, language: res.language, warnings: res.warnings, promptVersion: pv }, null, 2));
      return;
    }
    if (o['context-only']) {
      const p = resolve(o['context-only']);
      const pick = o.noRollout ? { id: promptVersion(inputs.parts), parts: inputs.parts } : rolloutPick(root, inputs.parts);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, buildLetterContext({ parts: pick.parts, cvMd: inputs.cvMd, jdText: inputs.jdText, version, format, lang: o.lang || detectLanguage(inputs.jdText) }));
      console.log(JSON.stringify({ status: 'context', path: p, promptVersion: pick.id }));
      return;
    }
    const r = await writeLetter({ inputs, version, format, lang: o.lang, root, rollout: !o.noRollout });
    const out = resolve(o.out);
    mkdirSync(dirname(out), { recursive: true });
    const textPath = resolve(o.text || out.replace(/\.json$/i, '') + '.txt');
    const tokens = r.usage.reduce((a, u) => a + (u.input_tokens || 0) + (u.output_tokens || 0), 0);
    const rollout = r.rollout ? { stable: r.rollout.stable, candidate: r.rollout.candidate, share: r.rollout.candidate ? STAGES[r.rollout.stage] : 100, held: r.rollout.held || null } : null;
    if (!r.ok) {
      writeFileSync(out.replace(/\.json$/i, '') + '.rejected.txt', r.text || '');
      console.log(JSON.stringify({ status: 'rejected', attempts: r.attempts, problems: r.check.problems, promptVersion: r.promptVersion, tokens }, null, 2));
      process.exitCode = 2;
      return;
    }
    writeFileSync(out, JSON.stringify(r.letter, null, 2));
    writeFileSync(textPath, r.text);
    let pdf = null;
    if (o.pdf) {
      pdf = resolve(o.pdf);
      await renderLetterPdf(r.letter, pdf, { contact: o.contact || '', company: o.company || '', city: o.city || '' });
    }
    appendLetterLog(root, { company: o.company, role: o.role, version, promptVersion: r.promptVersion, language: r.check.language, arm: o.arm, textPath, opening: openingOf(r.text) });
    console.log(JSON.stringify({ status: 'ok', json: out, text: textPath, pdf, words: r.check.words, language: r.check.language, attempts: r.attempts, warnings: r.check.warnings, promptVersion: r.promptVersion, rollout, tokens }, null, 2));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
