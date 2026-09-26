#!/usr/bin/env node

/**
 * letter-check.mjs — checks a cover letter BEFORE it is sent, so a bad prompt
 * is caught on its first letter instead of after a week of silence.
 *
 * Problems (the letter is not sent as-is):
 *   - written in a different language than the posting
 *   - too short or too long for its version (short / full)
 *   - voice-dna.md hard rules (English letters: lib/voice-check.mjs, fatal
 *     findings) and the French dead phrases below (French letters)
 *   - the letter-specific bans from modes/_custom.md "Letter writing"
 *   - a claim the CV does not back (verify-cv-facts.mjs, same gate as CVs)
 *   - a copy of a recent letter: same opening, or long word runs shared with
 *     one of the last letters in data/letter-log.tsv
 *   - layout leftovers: bullets, brackets, placeholders, "Cover Letter:"
 * Warnings (reported, not blocking): voice-check's soft findings.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { checkText, parseVoiceDna } from './voice-check.mjs';
import { verifyFacts } from '../verify-cv-facts.mjs';

export const LETTER_LOG_RELATIVE_PATH = 'data/letter-log.tsv';
const LOG_HEADER = ['timestamp', 'company', 'role', 'version', 'prompt_version', 'language', 'arm', 'text_path', 'opening'];

// Word counts per version, with some slack around the targets in _custom.md.
export const LENGTHS = { short: [35, 120], full: [140, 330] };

const FR_STOP = new Set(['le', 'la', 'les', 'des', 'et', 'je', 'pour', 'dans', 'une', 'un', 'du', 'sur', 'avec', 'vous', 'mon', 'ma', 'mes', 'est', 'que', 'qui', 'au', 'aux', 'votre', 'chez', 'nous', 'ce', 'cette', 'pas', 'sont', 'été', "j'ai", 'à', 'en']);
const EN_STOP = new Set(['the', 'and', 'to', 'of', 'in', 'for', 'with', 'on', 'at', 'is', 'my', 'i', 'you', 'your', 'was', 'that', 'this', 'it', 'as', 'be', 'have', 'from', 'we', 'an', 'by', "i've", "i'm"]);

// French equivalents of voice-dna's dead phrases, plus the letter bans from
// modes/_custom.md. Lowercase, accent-sensitive where French needs it.
export const FRENCH_DEAD = [
  "c'est avec un grand intérêt", 'je me permets', 'fort de', 'forte de', 'passionné', 'passionnée',
  'dynamique', 'rigoureux et motivé', 'vif intérêt', 'je suis convaincu', 'je suis convaincue',
  'prestigieuse', "n'hésitez pas", 'non seulement', 'leader mondial', 'en outre', 'par ailleurs',
  'diplômé de', 'diplômé du', 'français courant', 'bilingue en français', 'parfaitement bilingue',
  'véritable atout', 'relever de nouveaux défis', 'mettre à profit', 'valeur ajoutée',
];
export const ENGLISH_DEAD = [
  'i am writing to express', "i'm writing to express", 'i am excited', "i'm excited", 'thrilled',
  'passionate', 'i am confident that', "i'm confident that", 'proven track record', 'results-driven',
  'hit the ground running', 'unique opportunity', 'perfect fit', 'world leader', 'world-leading',
  'industry-leading', 'graduate of', 'graduated from', 'fluent in french', 'fluent french',
  'would welcome the opportunity to discuss', 'skills align',
];
const LEFTOVERS = [/•/, /\{\{|\}\}/, /\[[^\]]{0,40}\]/, /\bcover letter\s*:/i, /\bTODO\b/, /\bXXX\b/, /\*\*/];

const words = (s) => String(s ?? '').toLowerCase().match(/[\p{L}\p{N}'’]+/gu) || [];

/** 'fr' | 'en' | 'unknown', from stop-word counts. */
export function detectLanguage(text) {
  let fr = 0, en = 0;
  for (const w of words(text).map((x) => x.replace('’', "'"))) {
    if (FR_STOP.has(w)) fr++;
    if (EN_STOP.has(w)) en++;
  }
  if (fr + en < 5) return 'unknown';
  if (fr >= en * 1.5) return 'fr';
  if (en >= fr * 1.5) return 'en';
  return 'unknown';
}

/** The first sentence of the letter body (after the greeting line). */
export function openingOf(text) {
  const body = String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const first = body.find((p) => words(p).length > 4) || body[0] || '';
  return (first.match(/^[^.!?]+[.!?]?/) || [first])[0].trim();
}

const shingles = (text, n = 8) => {
  const w = words(text);
  const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};
const jaccard = (a, b) => {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};

/** Recent letters from the log: [{opening, text}], newest last. */
export function recentLetters(root, limit = 20) {
  const path = join(root, LETTER_LOG_RELATIVE_PATH);
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.split('\t'))
    .filter((p) => p.length >= LOG_HEADER.length && p[0] !== 'timestamp').slice(-limit);
  return rows.map((p) => {
    const textPath = p[7];
    let text = '';
    try { text = textPath && existsSync(textPath) ? readFileSync(textPath, 'utf8') : ''; } catch { /* unreadable: opening still compared */ }
    return { opening: p[8], text };
  });
}

export function appendLetterLog(root, row) {
  const path = join(root, LETTER_LOG_RELATIVE_PATH);
  const fresh = !existsSync(path);
  if (fresh) mkdirSync(dirname(path), { recursive: true });
  const line = [new Date().toISOString(), row.company, row.role, row.version, row.promptVersion,
    row.language, row.arm || '', row.textPath, row.opening].map((v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t');
  appendFileSync(path, `${fresh ? LOG_HEADER.join('\t') + '\n' : ''}${line}\n`, 'utf8');
}

/**
 * @param {{text: string, version: 'short'|'full', postingLanguage?: string,
 *          recent?: Array<{opening: string, text: string}>, factCheck?: boolean,
 *          voiceRules?: object}} input
 * @returns {{ok: boolean, problems: string[], warnings: string[], language: string, words: number}}
 */
export function checkLetter({ text, version = 'full', postingLanguage, recent = [], factCheck = true, voiceRules }) {
  const problems = [];
  const warnings = [];
  const lower = String(text ?? '').toLowerCase().replace(/’/g, "'");
  const n = words(text).length;
  const language = detectLanguage(text);

  if (postingLanguage && postingLanguage !== 'unknown' && language !== 'unknown' && language !== postingLanguage) {
    problems.push(`written in ${language} but the posting is in ${postingLanguage}`);
  }
  const [min, max] = LENGTHS[version] || LENGTHS.full;
  if (n < min || n > max) problems.push(`${n} words; a ${version} letter should be ${min}–${max}`);

  const dead = language === 'fr' ? FRENCH_DEAD : ENGLISH_DEAD;
  for (const p of dead) if (lower.includes(p)) problems.push(`dead phrase: "${p}"`);
  if (language === 'fr' && /(^|[.!?]\s+)en tant que\b/im.test(text)) problems.push('sentence opens with « En tant que »');
  for (const re of LEFTOVERS) {
    const m = String(text).match(re);
    if (m) problems.push(`layout leftover: "${m[0]}"`);
  }
  if (/—/.test(text)) problems.push('em dash');

  if (language !== 'fr') {
    const v = checkText(text, { rules: voiceRules, register: 'conversational' });
    for (const f of v.findings) {
      const msg = `${f.rule}${f.match ? `: "${f.match}"` : ''}`;
      // "as an AI Pipeline Developer" is a job title, not chatbot talk.
      const jobTitle = /^meta commentary/.test(f.rule) && /\b[Aa]s an AI [A-Z]/.test(text);
      if (f.severity === 'fatal' && !jobTitle) problems.push(msg); else warnings.push(msg);
    }
  }

  if (factCheck) {
    const facts = verifyFacts(text);
    if (facts.verdict === 'block') {
      if (facts.invented.length) problems.push(`numbers not in the CV: ${facts.invented.join(', ')}`);
      // The tool/title matcher is built for CV bullets and reads prose too
      // literally ("Loki via Helm"), so in a letter it only warns. Invented
      // numbers and forbidden phrases stay blocking.
      if (facts.unsupportedFacts.length) warnings.push(`check these claims: ${facts.unsupportedFacts.map((f) => f.value).join(', ')}`);
      if (facts.forbidden.length) problems.push(`forbidden phrases: ${facts.forbidden.join(', ')}`);
    }
  }

  const opening = openingOf(text);
  const mine = shingles(text);
  for (const r of recent) {
    if (r.opening && jaccard(opening, r.opening) >= 0.6) {
      problems.push(`opening repeats a recent letter: "${r.opening.slice(0, 70)}…"`);
      break;
    }
    if (r.text) {
      let shared = 0;
      for (const s of shingles(r.text)) if (mine.has(s)) shared++;
      if (shared >= 3) { problems.push(`copies long passages from a recent letter (${shared} shared 8-word runs)`); break; }
    }
  }
  return { ok: problems.length === 0, problems, warnings, language, words: n };
}

export { parseVoiceDna };
