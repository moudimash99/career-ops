#!/usr/bin/env node

// CV payload writer: agy writes the tailored payload from ONE pasted context.
//
// Why one context file: agy run as a free agent opened cv.md, _custom.md and
// the 34k-character pdf.md itself, re-sending each on every step — 1.1 to 3.5
// million tokens and 2.5–6.5 minutes per CV (measured 2026-09-25). Pasting
// exactly what it needs into one file, in a temp folder outside the repo (no
// project instructions auto-loaded, no old drafts in reach), measured ~50–60k
// tokens and about a minute, with CVs that followed the rules better.
//
// The context holds: the CV rules from modes/_custom.md (every "## CV …"
// section, plus "Application language" and "pdf.md steps overridden"), the
// payload schema from modes/pdf.md, cv.md verbatim, and the posting.
//
// Usage:
//   node cv-write.mjs --jd jds/x.md --arm strict|loose --out output/cv-….json
//        [--lang fr|en] [--render output/cv-….pdf]
//   node cv-write.mjs --jd jds/x.md --arm strict|loose --context-only <context.md> [--lang fr|en]
//
// --context-only is for Free Motion, where agy is already the driver: it
// writes the context file and agy reads that one file instead of the modes.

import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
export const ARMS = ['strict', 'loose'];
const LANGS = { fr: 'French', en: 'English' };

const ARM_LINE = {
  strict: 'ARM: strict — only facts that are in the CV below.',
  loose: 'ARM: loose — the same build as strict; only the fact checking is relaxed, exactly as the "CV experiment" rules describe.',
};

/** Every "## " section of a markdown file, as {title, body}. */
export function markdownSections(md) {
  const out = [];
  const re = /^## (.+)$/gm;
  const heads = [...md.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
    out.push({ title: h[1].trim(), body: md.slice(h.index, end).trim() });
  });
  return out;
}

/** The _custom.md sections that govern CV writing. */
export function cvRuleSections(customMd) {
  return markdownSections(customMd)
    .filter(({ title }) => /^CV\b/i.test(title) || /^pdf\.md steps overridden/i.test(title) || /^Application language/i.test(title))
    .map(({ body }) => body);
}

/** The payload schema code block from modes/pdf.md. */
export function schemaBlock(pdfMd) {
  const at = pdfMd.indexOf('### JSON Input Schema');
  const fence = pdfMd.indexOf('```json', at);
  const end = pdfMd.indexOf('```', fence + 7);
  if (at === -1 || fence === -1 || end === -1) throw new Error('JSON Input Schema block not found in modes/pdf.md');
  return pdfMd.slice(fence, end + 3);
}

/**
 * The full context agy writes from. Pure given its inputs.
 * @param {{customMd: string, pdfMd: string, cvMd: string, jdText: string, arm: string, lang?: string}} p
 */
export function buildCvContext({ customMd, pdfMd, cvMd, jdText, arm, lang }) {
  if (!ARMS.includes(arm)) throw new Error(`--arm must be one of ${ARMS.join(', ')}`);
  const rules = cvRuleSections(customMd);
  if (!rules.length) throw new Error('no "## CV …" sections found in modes/_custom.md');
  const language = LANGS[lang] ? `LANGUAGE: ${LANGS[lang]}.` : 'LANGUAGE: follow the "Application language" rule below.';
  return `Write the CV payload for one job application, as JSON.
Everything you need is in this file. Do not open or read any other file.

${ARM_LINE[arm]}
${language}
Write one ranked payload, a little long; a script cuts it to one page.
Experience bullets are {"text": "...", "priority": 1|2|3}; roles and projects may carry "priority".

=== RULES ===
${rules.join('\n\n')}

=== JSON SCHEMA ===
${schemaBlock(pdfMd)}

=== THE CANDIDATE'S CV (his own wording: select and trim his sentences, don't rewrite them) ===
${cvMd}

=== THE POSTING ===
${jdText}
`;
}

/** Pull the JSON object out of agy's reply (tolerates code fences / prose). */
export function extractJson(text) {
  const s = String(text ?? '').replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('no JSON object in agy reply');
  return JSON.parse(s.slice(a, b + 1));
}

export const AGY_PROMPT = 'Read the file context.md in the current folder: it is the only file you may read, and it contains everything. Follow it. Reply with the JSON payload only: no prose, no code fences. Do not write or change any file.';

function run(cmd, args, opts) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { ...opts, shell: false });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => res({ code: -1, out, err: String(e.message) }));
    p.on('close', (code) => res({ code, out, err }));
  });
}

/** Load the context inputs from the data root / code root. */
export function loadContextInputs({ jd, root = getCareerOpsRoot() }) {
  const readData = (p) => readFileSync(join(root, p), 'utf8');
  const jdPath = resolve(jd);
  if (!existsSync(jdPath)) throw new Error(`posting not found: ${jd}`);
  const pdfPath = existsSync(join(root, 'modes/pdf.md')) ? join(root, 'modes/pdf.md') : join(CODE_ROOT, 'modes/pdf.md');
  return {
    customMd: readData('modes/_custom.md'),
    pdfMd: readFileSync(pdfPath, 'utf8'),
    cvMd: readData('cv.md'),
    jdText: readFileSync(jdPath, 'utf8'),
  };
}

/**
 * Run agy on the context and return {payload, usage, seconds} or throw.
 * agy runs in a fresh temp folder with only context.md in it.
 */
export async function writeWithAgy(context, { timeout = '10m' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'cv-write-'));
  writeFileSync(join(work, 'context.md'), context);
  const t0 = Date.now();
  const r = await run('agy', ['-p', AGY_PROMPT, '--dangerously-skip-permissions', '--disable-slash-commands',
    '--print-timeout', timeout, '--output-format', 'json'], { cwd: work });
  const seconds = Math.round((Date.now() - t0) / 1000);
  let j;
  try { j = JSON.parse(r.out); } catch { throw new Error(`agy gave no JSON result (exit ${r.code}): ${(r.err || r.out).trim().slice(0, 300)}`); }
  if (j.status && j.status !== 'SUCCESS') throw new Error(`agy ${j.status}: ${j.error || 'no detail'}`);
  return { payload: extractJson(j.response), usage: j.usage || {}, seconds, raw: j };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--jd', '--arm', '--out', '--lang', '--render', '--context-only'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; return; }
  const usage = 'Usage: node cv-write.mjs --jd <posting.md> --arm strict|loose (--out <payload.json> [--render <cv.pdf>] | --context-only <context.md>) [--lang fr|en]';
  if (o.help || !o.jd || !o.arm || (!o.out && !o['context-only'])) { console.error(usage); process.exitCode = o.help ? 0 : 1; return; }
  try {
    const root = getCareerOpsRoot();
    const context = buildCvContext({ ...loadContextInputs({ jd: o.jd, root }), arm: o.arm, lang: o.lang });
    if (o['context-only']) {
      const p = resolve(o['context-only']);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, context);
      console.log(JSON.stringify({ status: 'context', path: p, chars: context.length }));
      return;
    }
    const { payload, usage: u, seconds } = await writeWithAgy(context);
    const out = resolve(o.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(payload, null, 2));
    const result = { status: 'ok', payload: out, seconds, tokens: { in: u.input_tokens, cached: u.cache_read_tokens, out: u.output_tokens, thinking: u.thinking_tokens } };
    if (o.render) {
      const args = [join(CODE_ROOT, 'generate-cv-typst.mjs'), out, resolve(o.render)];
      if (o.arm === 'loose') args.push('--skip-fact-check');
      const g = await run(process.execPath, args, { cwd: root });
      try { result.render = JSON.parse(g.out); } catch { result.render = { status: 'error', exit: g.code, message: (g.err || g.out).trim().split('\n').slice(0, 3).join(' ') }; }
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.render && result.render.status !== 'ok') process.exitCode = 2;
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) main();
