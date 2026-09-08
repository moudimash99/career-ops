#!/usr/bin/env node

/**
 * voice-check.mjs — lint generated prose against `voice-dna.md` BEFORE it is
 * typed into a form, pasted into an email, or rendered into a PDF.
 *
 * WHY THIS EXISTS. `voice-dna.md` and `modes/_writing.md` have specified the
 * rules all along; the failure mode is not that they are missing, it is that a
 * model writing prose in the middle of a long task does not stop to re-read
 * them and cannot see its own tells. Asking the writer to remember has already
 * been tried and it does not hold: a run on 2026-09-07 shipped 3 em dashes
 * (a HARD ban) and 7 concession-pivot constructions into live application
 * forms, and the user could tell at a glance the text was machine-written.
 *
 * So the guardrail becomes mechanical. Text goes through here and the findings
 * come back with line numbers. No judgement required at the point of use.
 *
 * `voice-dna.md` IS THE SOURCE OF TRUTH AND IS PARSED, NOT COPIED. The banned
 * vocabulary, dead phrases, transitions, bait and hype lists are read out of
 * the user's own file at run time. Duplicating them here would fork the rules
 * the first time the user edits theirs — and it is a user-layer file they are
 * expected to edit. Only checks that CANNOT be expressed as a word list live
 * in code: em dashes, the negative-parallelism skeletons, rule-of-three,
 * metronome rhythm, participle padding, meta commentary, title-case headers.
 *
 * REGISTER MATTERS. `modes/_writing.md` splits the rules in two: the
 * anti-slop guardrail applies to everything, but the conversational tier
 * (contractions, "I"/"you", hedging) applies only to prose a human reads as a
 * message — cover letters, outreach, form essays — and NOT to CV bullets,
 * which keep a formal keyword-dense register for ATS parsers. Pass the
 * register so the checker does not demand contractions in a CV bullet.
 *
 * Usage:
 *   node lib/voice-check.mjs --file <path> [--register conversational|ats]
 *   node lib/voice-check.mjs --text "..." [--json]
 *   cat draft.txt | node lib/voice-check.mjs --file -
 *
 * Exit codes:
 *   0  clean, or warnings only
 *   1  at least one FATAL finding — rewrite before sending
 *   2  usage error
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

import { flagValue, hasFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

/** Where the rules live, relative to the data root. */
export const VOICE_DNA_RELATIVE_PATH = 'voice-dna.md';

/** Registers the checker understands. See the header on why this is split. */
export const REGISTERS = ['conversational', 'ats'];

/**
 * The negative-parallelism skeletons from voice-dna §3F, plus the three
 * "sneaky versions" it calls out.
 *
 * These are the single most reliable tell and they are structural, so they
 * cannot be a word list. Each pattern deletes the negated framing: the fix is
 * always to keep the positive claim and drop everything before it.
 *
 * `rather than` and `instead of` are included because they are the same
 * skeleton in the most common disguise — the run that prompted this file used
 * "rather than" seven times without once writing "it's not X, it's Y".
 */
const NEGATIVE_PARALLELISM = [
  { re: /\b(?:it'?s|this|that)\s+(?:is\s+)?not\s+(?:just\s+)?(?:about\s+)?[^.!?]{2,60}?[,.]?\s*(?:it'?s|this is|that is)\s+(?:about\s+)?/gi, name: "it's not X, it's Y" },
  { re: /\bnot\s+only\s+[^.!?]{2,60}?\s+but\s+also\b/gi, name: 'not only X but also Y' },
  { re: /\bless\s+\w+\s*,\s*more\s+\w+/gi, name: 'less X, more Y' },
  { re: /\bforget\s+[^.!?]{2,40}?[.,]\s*(?:this|that|here)\b/gi, name: 'forget X, this is Y' },
  { re: /\bstop\s+\w+ing\s+[^.!?]{2,40}?[.,]\s*start\s+\w+ing\b/gi, name: 'stop X, start Y' },
  { re: /\bthe\s+question\s+is\s*n[o']t\b/gi, name: "the question isn't X" },
  { re: /\byou\s+do\s*n[o']t\s+need\s+[^.!?]{2,40}?[.,]\s*you\s+need\b/gi, name: "you don't need X, you need Y" },
  { re: /\bis\s+(?:dead|overrated)\s*[.,]\s*\w+\s+is\b/gi, name: 'X is dead, Y is the future' },
  // The disguises §3F names explicitly.
  { re: /\bwhile\s+[^.!?]{2,60}?\s+might\s+seem\b/gi, name: 'while X might seem, Y actually (disguised)' },
  { re: /\bsure\s*,\s*[^.!?]{2,50}?\.\s*but\b/gi, name: 'sure X. But Y (concession pivot)' },
  { re: /\bgets?\s+all\s+the\s+attention\s*,?\s*but\b/gi, name: 'X gets the attention, but Y (disguised)' },
  { re: /\brather\s+than\b/gi, name: 'rather than (concession pivot skeleton)' },
  { re: /\binstead\s+of\s+\w+ing\b/gi, name: 'instead of X-ing (same skeleton)' },
  { re: /\bI'?d\s+rather\s+[^.!?]{2,80}?\bthan\b/gi, name: "I'd rather X than Y" },
];

/**
 * Participle phrases bolted on to fake analytic depth (§4F).
 *
 * Matched only at a clause boundary (after a comma) so that ordinary
 * mid-sentence "-ing" verbs are left alone.
 */
const PARTICIPLE_PADDING = /,\s*(highlighting|underscoring|showcasing|reflecting|demonstrating|emphasizing|illustrating|contributing to|paving the way|setting the stage|marking a|serving as)\b/gi;

/** Copulative avoidance (§4J): bloated stand-ins for "is" and "has". */
const COPULATIVE_AVOIDANCE = /\b(serves as|stands as|marks a|represents a|boasts a|features a|holds the distinction of)\b/gi;

/** Meta commentary (§4E) and chat leakage (§4H). */
const META_COMMENTARY = /\b(in this (section|article|letter),?\s*I|let me walk you through|here'?s a comprehensive|I hope this helps|would you like me to|great question|as an AI)\b/gi;

/**
 * Split a markdown list or comma blob into clean terms.
 *
 * @param {string} block
 * @returns {string[]}
 */
function splitTerms(block) {
  return block
    .split(/\n/)
    .flatMap((line) => {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) return [bullet[1]];
      // A prose paragraph of comma-separated words (how §3A is written).
      if (/^[a-z0-9]/i.test(line.trim()) && line.includes(',')) return line.split(',');
      return [];
    })
    .map((t) => t
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .replace(/\s*\(.*?\)\s*/g, ' ')
      .replace(/\.\.\.$/, '')
      .trim())
    .filter((t) => t && t.length > 2 && !t.startsWith('#') && !/^also banned/i.test(t));
}

/**
 * Read the banned lists out of `voice-dna.md`.
 *
 * Sections are located by their headings rather than by position, so the user
 * can reorder or extend the file without breaking this. A missing file yields
 * empty lists and the structural checks still run — the guardrail degrades,
 * it does not vanish.
 *
 * @param {string} [path] - Defaults to `voice-dna.md` at the data root.
 * @returns {{words: string[], phrases: string[], found: boolean, path: string}}
 */
export function parseVoiceDna(path) {
  const file = path
    ? (isAbsolute(path) ? path : join(getCareerOpsRoot(), path))
    : join(getCareerOpsRoot(), VOICE_DNA_RELATIVE_PATH);
  if (!existsSync(file)) return { words: [], phrases: [], found: false, path: file };

  const md = readFileSync(file, 'utf-8');
  const section = (heading) => {
    const re = new RegExp(`###\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n---|\\n## |$)`, 'i');
    const m = md.match(re);
    return m ? m[1] : '';
  };

  // 3A is a prose blob of comma-separated words; 3B-3E are bullet lists.
  const words = splitTerms(section('3A'))
    .flatMap((t) => t.split(/[,/]/))
    .map((t) => t.trim())
    .filter((t) => t && t.length > 2 && t.split(/\s+/).length <= 3);

  const phrases = ['3B', '3C', '3D', '3E']
    .flatMap((s) => splitTerms(section(s)))
    .map((t) => t.replace(/\s*\/\s*/g, '|'))
    .flatMap((t) => t.split('|'))
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter((t) => t && t.length > 3 && !/^any\b|^anything\b/i.test(t));

  return { words: [...new Set(words)], phrases: [...new Set(phrases)], found: true, path: file };
}

/** Line number (1-based) of a character offset. */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * Lint a draft.
 *
 * @param {string} text
 * @param {{rules?: ReturnType<typeof parseVoiceDna>, register?: string}} [options]
 * @returns {{findings: Array<{severity: 'fatal'|'warn', rule: string, match: string, line: number, fix: string}>,
 *   stats: {sentences: number, meanWords: number, stdevWords: number, emDashes: number},
 *   ok: boolean}}
 */
export function checkText(text, { rules, register = 'conversational' } = {}) {
  const src = String(text ?? '');
  const dna = rules ?? parseVoiceDna();
  const findings = [];
  const add = (severity, rule, match, index, fix) => {
    findings.push({ severity, rule, match: String(match).slice(0, 80), line: lineOf(src, index), fix });
  };

  // --- HARD RULES (voice-dna §2, §3) ---------------------------------------

  for (const m of src.matchAll(/—/g)) {
    add('fatal', 'em dash', '—', m.index,
      'voice-dna §2: NO em dashes. Use a comma, a period, a colon or parentheses.');
  }

  for (const word of dna.words) {
    const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|d|ing|es)?\\b`, 'gi');
    for (const m of src.matchAll(re)) {
      add('fatal', `banned word: ${word}`, m[0], m.index,
        'voice-dna §3A: dead AI vocabulary. Say the plain thing instead.');
    }
  }

  for (const phrase of dna.phrases) {
    // Match across the contraction boundary. voice-dna writes "It's worth
    // noting"; a draft may say "it is worth noting", and the two have to be
    // the same rule or half the list quietly never fires.
    const body = phrase
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\.\\\.\\\./g, '')
      .replace(/'s\b/gi, "(?:'s| is)")
      .replace(/n't\b/gi, "(?:n't| not)")
      .replace(/'re\b/gi, "(?:'re| are)")
      .replace(/\s+/g, '\\s+')
      .trim();
    if (!body) continue;
    const re = new RegExp(body, 'gi');
    for (const m of src.matchAll(re)) {
      add('fatal', `dead phrase: ${phrase}`, m[0], m.index, 'voice-dna §3B-3E: cut it.');
    }
  }

  for (const { re, name } of NEGATIVE_PARALLELISM) {
    for (const m of src.matchAll(re)) {
      add('fatal', `negative parallelism: ${name}`, m[0], m.index,
        'voice-dna §3F (FATAL): delete everything before the positive claim and just state it.');
    }
  }

  for (const m of src.matchAll(COPULATIVE_AVOIDANCE)) {
    add('fatal', `copulative avoidance: ${m[0]}`, m[0], m.index, 'voice-dna §4J: just say "is" or "has".');
  }

  for (const m of src.matchAll(META_COMMENTARY)) {
    add('fatal', `meta commentary: ${m[0]}`, m[0], m.index, 'voice-dna §4E/§4H: say the thing, do not announce it.');
  }

  // --- STRONG TENDENCIES (warn: judgement, not absolutes) ------------------

  for (const m of src.matchAll(PARTICIPLE_PADDING)) {
    add('warn', `participle padding: ${m[1]}`, m[0], m.index,
      'voice-dna §4F: delete the "-ing" clause, or give the claim its own sentence.');
  }

  // Rule of three (§4B): three comma-separated items ending in "and X".
  //
  // What §4B actually objects to is abstract padding — "speed, efficiency, and
  // innovation" — used to make thin analysis look complete. A real enumeration
  // of three things that exist is not that: "French, English and Arabic" and
  // "VPC, EKS and versioned S3" are facts, and flagging them every time trains
  // the reader to ignore the warning. Skip the match when at least two items
  // are proper nouns or carry a number, which is what tells a list of real
  // things apart from a list of abstractions.
  const concrete = (s) => /^[A-Z0-9]/.test(s.trim()) || /\d/.test(s);
  for (const m of src.matchAll(/\b(\w+(?:\s\w+)?),\s+(\w+(?:\s\w+)?),?\s+and\s+(\w+(?:\s\w+)?)\b/g)) {
    const items = [m[1], m[2], m[3]];
    if (items.filter(concrete).length >= 2) continue;
    add('warn', 'rule of three', m[0], m.index,
      'voice-dna §4B: use 2 items, or 4, or name the one that matters.');
  }

  const sentences = src.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const words = sentences.map((s) => s.split(/\s+/).length);
  const mean = words.length ? words.reduce((a, b) => a + b, 0) / words.length : 0;
  const stdev = words.length
    ? Math.sqrt(words.reduce((a, b) => a + (b - mean) ** 2, 0) / words.length)
    : 0;

  // Metronome rhythm (§4I). Only meaningful with enough sentences to have a
  // rhythm at all, and judged on spread rather than length: even, medium-length
  // sentences all the way through is the tell, not long sentences as such.
  if (sentences.length >= 5 && stdev < 6 && mean > 14) {
    add('warn', `metronome rhythm (mean ${mean.toFixed(0)}w, stdev ${stdev.toFixed(0)})`, '', 0,
      'voice-dna §4I: vary it. Add a short sentence. A fragment. Then one that earns its length.');
  }

  if (register === 'conversational') {
    // §1: contractions and direct address are how the user actually writes.
    // Only nudged on a draft long enough for their absence to be a choice.
    //
    // These two tests are LANGUAGE-SPECIFIC, and this candidate applies in
    // France, so a French cover letter was being told to add contractions and
    // the word "I" — neither of which exists in French the way the English
    // rule means. French elides instead (j'ai, c'est, l'équipe) and its first
    // person is "je". Detect the language cheaply from function words and
    // apply the matching pair, so the nudge stays useful in both.
    const wordCount = src.split(/\s+/).filter(Boolean).length;
    const frenchHits = (src.match(/\b(je|j'|le|la|les|des|une|avec|pour|dans|que|qui|est|sur|mon|ma)\b/gi) || []).length;
    const isFrench = frenchHits / Math.max(wordCount, 1) > 0.08;

    const hasContraction = isFrench
      ? /\b[a-zà-ÿ]'[a-zà-ÿ]/i.test(src)   // j'ai, c'est, l'ISAE, d'une
      : /\b\w+'(?:s|t|re|ve|ll|d|m)\b/.test(src);
    const hasFirstPerson = isFrench ? /\b(je|j'|mon|ma|mes)\b/i.test(src) : /\bI\b/.test(src);

    if (wordCount > 80 && !hasContraction) {
      add('warn', `no contractions${isFrench ? ' (fr)' : ''}`, '', 0,
        'voice-dna §1: use contractions. Without them the register reads like a press release.');
    }
    if (wordCount > 80 && !hasFirstPerson) {
      add('warn', `no first person${isFrench ? ' (fr)' : ''}`, '', 0,
        'voice-dna §1: write in the first person. Active voice, direct address.');
    }
  }

  findings.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === 'fatal' ? -1 : 1));
  return {
    findings,
    stats: {
      sentences: sentences.length,
      meanWords: Number(mean.toFixed(1)),
      stdevWords: Number(stdev.toFixed(1)),
      emDashes: (src.match(/—/g) || []).length,
    },
    ok: !findings.some((f) => f.severity === 'fatal'),
  };
}

const USAGE = `Usage:
  node lib/voice-check.mjs --file <path|->  [--register conversational|ats] [--json]
  node lib/voice-check.mjs --text "..."      [--register conversational|ats] [--json]

Lints prose against voice-dna.md before it is sent. The banned word and phrase
lists are read FROM voice-dna.md, so editing that file changes this check.

Exit: 0 clean or warnings only, 1 fatal findings, 2 usage error.`;

function main(argv) {
  validateFlags(argv, ['--file', '--text', '--register', '--json', '--voice-dna', '--help', '-h'], USAGE,
    { valueFlags: ['--file', '--text', '--register', '--voice-dna'] });

  const file = flagValue(argv, '--file');
  const inline = flagValue(argv, '--text');
  if (!file && inline === undefined) { console.error(USAGE); return 2; }

  let text;
  if (inline !== undefined) text = inline;
  else if (file === '-') text = readFileSync(0, 'utf-8');
  else {
    const path = isAbsolute(file) ? file : join(getCareerOpsRoot(), file);
    if (!existsSync(path)) { console.error(`no such file: ${path}`); return 2; }
    text = readFileSync(path, 'utf-8');
  }

  const register = flagValue(argv, '--register') ?? 'conversational';
  if (!REGISTERS.includes(register)) { console.error(`--register must be one of ${REGISTERS.join(', ')}`); return 2; }

  const rules = parseVoiceDna(flagValue(argv, '--voice-dna'));
  const result = checkText(text, { rules, register });

  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify({ ...result, voiceDna: rules.found ? rules.path : null }, null, 2));
  } else if (!result.findings.length) {
    console.log(`clean — ${result.stats.sentences} sentences, mean ${result.stats.meanWords}w, stdev ${result.stats.stdevWords}`);
  } else {
    if (!rules.found) console.log('(voice-dna.md not found — structural checks only)');
    for (const f of result.findings) {
      const tag = f.severity === 'fatal' ? 'FATAL' : 'warn ';
      console.log(`${tag} line ${f.line}: ${f.rule}${f.match ? `  «${f.match}»` : ''}`);
      console.log(`      ${f.fix}`);
    }
    console.log(`\n${result.findings.filter((f) => f.severity === 'fatal').length} fatal, ${result.findings.filter((f) => f.severity === 'warn').length} warnings`);
  }
  return result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
