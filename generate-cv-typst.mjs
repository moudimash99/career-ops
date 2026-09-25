#!/usr/bin/env node

// One-page CV PDF via RenderCV + Typst.
//
// Takes the tailored CV payload (modes/pdf.md schema) or a RenderCV YAML file,
// renders it with RenderCV, and guarantees the result is exactly ONE page:
//
//   1. Render at the theme's own layout.
//   2. Over one page → retry with a fixed ladder of tighter layouts (FIT_STEPS),
//      stopping at the first that fits — but never past the floor step, which
//      the user picked by eye (config/profile.yml → cv.fit_floor).
//   3. Still over at the floor → exit 2 and say so. Content has to be cut; the
//      caller trims the payload and reruns. Nothing is reported or indexed.
//
// On success the PDF is written, the YAML that produced it is kept next to it
// (so it can be hand-edited and re-rendered), the fact gate runs on RenderCV's
// markdown output unless --skip-fact-check, and --report=NNN indexes the PDF in
// data/pdf-index.tsv exactly like generate-pdf.mjs does.
//
// --preview-steps renders EVERY step to PNG (no fit, no manifest) so a person
// can see where the layout stops looking good and set cv.fit_floor.
//
// Usage:
//   node generate-cv-typst.mjs <payload.json|cv.yaml> <out.pdf>
//        [--report=NNN] [--theme=X] [--format=a4|letter] [--floor=<step>]
//        [--skip-fact-check] [--preview-steps]
//
// Requires RenderCV: pip install -r requirements-cv.txt

import { spawnSync } from 'child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, extname, join, resolve } from 'path';
import * as yaml from 'js-yaml';
import { buildRenderCvDocument, DEFAULT_REQUIRED_SECTIONS, listThemes, mergeDesign, missingRequiredSections, resolveTheme } from './build-cv-rendercv.mjs';
import { validatePayload } from './lib/cv-payload-schema.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

// Cumulative: each step keeps every override of the steps before it.
export const FIT_STEPS = [
  { name: 'base', design: {} },
  { name: 'font-9.5', design: { typography: { font_size: { body: '9.5pt', connections: '9.5pt', headline: '9.5pt' } } } },
  {
    name: 'margins',
    design: {
      page: { top_margin: '0.5in', bottom_margin: '0.5in', left_margin: '0.55in', right_margin: '0.55in' },
      header: { space_below_name: '0.4cm', space_below_headline: '0.4cm', space_below_connections: '0.4cm' },
    },
  },
  {
    name: 'spacing',
    design: {
      typography: { line_spacing: '0.5em' },
      section_titles: { space_above: '0.35cm', space_below: '0.2cm' },
      sections: { space_between_regular_entries: '0.8em' },
    },
  },
  { name: 'font-9', design: { typography: { font_size: { body: '9pt', connections: '9pt', headline: '9pt' } } } },
];

// Until the user has picked a floor by eye, stop before any 9pt step.
export const DEFAULT_FLOOR = 'spacing';

/** The steps to try, base first, ending at the floor (inclusive). */
export function stepsUpTo(floor = DEFAULT_FLOOR) {
  const idx = FIT_STEPS.findIndex(s => s.name === floor);
  if (idx === -1) {
    throw new Error(`Unknown fit floor "${floor}". Steps: ${FIT_STEPS.map(s => s.name).join(', ')}`);
  }
  const out = [];
  let design = {};
  for (const step of FIT_STEPS.slice(0, idx + 1)) {
    design = mergeDesign(design, step.design);
    out.push({ name: step.name, design });
  }
  return out;
}

/**
 * Walk the steps until one renders to a single page.
 *
 * @param {(step: {name: string, design: object}) => Promise<{pages: number}>|{pages: number}} render
 * @param {Array<{name: string, design: object}>} steps
 * @returns {Promise<{fit: boolean, step: object, result: object, tried: Array<{name: string, pages: number}>}>}
 */
export async function fitToOnePage(render, steps) {
  const tried = [];
  let last;
  for (const step of steps) {
    const result = await render(step);
    tried.push({ name: step.name, pages: result.pages });
    last = { step, result };
    if (result.pages === 1) return { fit: true, ...last, tried };
  }
  return { fit: false, ...last, tried };
}

// ── Rank-and-cut ─────────────────────────────────────────────────────────
// The tailoring model writes ONE ranked payload, possibly a little long, and
// this script makes it fit with no second model pass. Each experience bullet
// may be {text, priority} and each role or project may carry `priority`:
//   1 = must keep (the default for anything unranked), 2 = keep if possible,
//   3 = drop first.
// Content is cut BEFORE the layout shrinks, so the floor layout stays rare.
// Nothing ranked 1 is ever cut, no role loses its last bullet, and the
// experience section never empties — required sections always survive.

/** Priority of a bullet, role or project: 1 unless explicitly 2 or 3. */
export function priorityOf(item) {
  const n = Number(item && typeof item === 'object' ? item.priority : NaN);
  return n === 2 || n === 3 ? n : 1;
}

const bulletLabel = (b) => {
  const t = typeof b === 'object' && b ? String(b.text ?? '') : String(b);
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
};

/**
 * Ordered cut candidates for a payload (references into that same object).
 * Projects are scored 1–3 like bullets and cut in the same tier:
 *   priority-3 projects → priority-3 bullets → priority-3 roles
 *   → priority-2 projects → priority-2 bullets.
 * A project goes before a bullet of the same score (Projects is the optional
 * section). Within a tier, the last-listed project and the bullet furthest
 * down its role's best-first list go first; role age only breaks ties.
 */
export function cutPlan(payload) {
  const ops = [];
  const projects = [...(payload.projects || [])].reverse();
  const roles = [...(payload.experience || [])].reverse();
  const projectOps = (tier) => {
    for (const p of projects) {
      if (priorityOf(p) === tier) ops.push({ kind: 'project', project: p, label: `project "${p.name}"` });
    }
  };
  // The model lists each role's bullets best-first, so within a tier the
  // bullet furthest down its list goes first, whatever the role's age. Role
  // age only breaks an exact tie (same position, same tier).
  const bulletOps = (tier) => {
    const tierBullets = [];
    (payload.experience || []).forEach((role, roleIdx) => {
      (role.bullets || []).forEach((b, idx) => {
        if (priorityOf(b) === tier) tierBullets.push({ role, b, idx, roleIdx });
      });
    });
    tierBullets.sort((x, y) => y.idx - x.idx || y.roleIdx - x.roleIdx);
    for (const { role, b } of tierBullets) {
      ops.push({ kind: 'bullet', role, bullet: b, label: `${role.company}: "${bulletLabel(b)}"` });
    }
  };
  projectOps(3);
  bulletOps(3);
  for (const role of roles) {
    if (priorityOf(role) === 3) ops.push({ kind: 'role', role, label: `role ${role.company} (${role.role})` });
  }
  projectOps(2);
  bulletOps(2);
  return ops;
}

/** Apply one cut in place. Returns false when a guard refuses it. */
export function applyCut(payload, op) {
  if (op.kind === 'project') {
    const i = (payload.projects || []).indexOf(op.project);
    if (i === -1) return false;
    payload.projects.splice(i, 1);
    return true;
  }
  if (op.kind === 'role') {
    const i = (payload.experience || []).indexOf(op.role);
    if (i === -1 || payload.experience.length <= 1) return false;
    payload.experience.splice(i, 1);
    return true;
  }
  if (op.kind === 'bullet') {
    if (!(payload.experience || []).includes(op.role)) return false;
    const list = op.role.bullets || [];
    const i = list.indexOf(op.bullet);
    if (i === -1 || list.length <= 1) return false;
    list.splice(i, 1);
    return true;
  }
  return false;
}

/**
 * Fit a ranked payload on one page: cut content at the first step, then walk
 * the remaining layout steps.
 *
 * @param {object} payload
 * @param {Array<{name: string, design: object}>} steps - base first, floor last.
 * @param {(payload: object, step: object) => Promise<{pages: number}>|{pages: number}} render
 */
export async function fitWithCuts(payload, steps, render) {
  const work = structuredClone(payload);
  const tried = [];
  const dropped = [];
  const attempt = async (step) => {
    const result = await render(work, step);
    tried.push({ name: step.name, pages: result.pages, dropped: dropped.length });
    return result;
  };
  let result = await attempt(steps[0]);
  if (result.pages === 1) return { fit: true, step: steps[0], result, tried, dropped, payload: work };
  for (const op of cutPlan(work)) {
    if (!applyCut(work, op)) continue;
    dropped.push(op.label);
    result = await attempt(steps[0]);
    if (result.pages === 1) return { fit: true, step: steps[0], result, tried, dropped, payload: work };
  }
  for (const step of steps.slice(1)) {
    result = await attempt(step);
    if (result.pages === 1) return { fit: true, step, result, tried, dropped, payload: work };
  }
  return { fit: false, step: steps[steps.length - 1], result, tried, dropped, payload: work };
}

// ── Floor-hit tracking ───────────────────────────────────────────────────
// Every real render appends one row to data/cv-fit-log.tsv. A CV "hits the
// floor" when it only fit at the floor step, or overflowed it. Counted per
// output PDF, not per attempt: an overflow that was trimmed and then fit is
// still one CV that hit the floor. When more than cv.floor_alert_pct (default
// 20) of recent CVs hit it, the tailoring prompt is writing too much and
// modes/pdf.md's content budget needs tightening — not the layout.
export const FIT_LOG_RELATIVE_PATH = 'data/cv-fit-log.tsv';
const FIT_LOG_HEADER = ['timestamp', 'pdf', 'theme', 'step', 'floor', 'outcome'];
export const DEFAULT_FLOOR_ALERT_PCT = 20;
export const FIT_STATS_WINDOW = 50;
// Below this many CVs the rate is noise; no alert.
export const FIT_STATS_MIN = 10;

export function appendFitLog(root, row) {
  const path = join(root, FIT_LOG_RELATIVE_PATH);
  const fresh = !existsSync(path);
  if (fresh) mkdirSync(dirname(path), { recursive: true });
  const line = [new Date().toISOString(), row.pdf, row.theme, row.step, row.floor, row.outcome]
    .map(v => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t');
  appendFileSync(path, `${fresh ? FIT_LOG_HEADER.join('\t') + '\n' : ''}${line}\n`, 'utf-8');
}

export function readFitLog(root) {
  const path = join(root, FIT_LOG_RELATIVE_PATH);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split(/\r?\n/)
    .map(l => l.split('\t'))
    .filter(p => p.length >= 6 && p[0] !== 'timestamp')
    .map(([timestamp, pdf, theme, step, floor, outcome]) => ({ timestamp, pdf, theme, step, floor, outcome }));
}

/**
 * Share of the most recent CVs (distinct PDFs) that hit the floor.
 * @returns {{cvs: number, hits: number, rate: number|null, alert: boolean, threshold: number, window: number}}
 */
export function fitStats(rows, { threshold = DEFAULT_FLOOR_ALERT_PCT, window = FIT_STATS_WINDOW } = {}) {
  const byPdf = new Map();
  for (const r of rows) {
    const hit = r.outcome === 'overflow' || r.outcome === 'floor';
    const prev = byPdf.get(r.pdf);
    byPdf.delete(r.pdf); // re-insert so Map order tracks the latest attempt
    byPdf.set(r.pdf, (prev || false) || hit);
  }
  const recent = [...byPdf.values()].slice(-window);
  const hits = recent.filter(Boolean).length;
  const rate = recent.length ? Math.round((hits / recent.length) * 1000) / 10 : null;
  return { cvs: recent.length, hits, rate, alert: recent.length >= FIT_STATS_MIN && rate > threshold, threshold, window };
}

function floorAlertMessage(stats) {
  return `${stats.rate}% of the last ${stats.cvs} CVs needed the floor layout or overflowed (limit ${stats.threshold}%). `
    + 'The tailoring writes too much for one page: tighten the content budget in modes/pdf.md '
    + '(fewer bullets per role, shorter summary), not the layout.';
}

function readProfileCv(root) {
  const path = join(root, 'config', 'profile.yml');
  if (!existsSync(path)) return {};
  try {
    return yaml.load(readFileSync(path, 'utf-8'))?.cv || {};
  } catch {
    return {};
  }
}

function pythonCmd() {
  return process.env.RENDERCV_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export function renderCvAvailable() {
  const r = spawnSync(pythonCmd(), ['-m', 'rendercv', '--version'], {
    encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return r.status === 0;
}

/** Run RenderCV on one YAML document; returns the produced file paths. */
function runRenderCv(doc, workDir, { png = false } = {}) {
  mkdirSync(workDir, { recursive: true });
  const yamlPath = join(workDir, 'cv.yaml');
  writeFileSync(yamlPath, yaml.dump(doc, { lineWidth: -1, noRefs: true }));
  const args = ['-m', 'rendercv', 'render', yamlPath, '-o', join(workDir, 'out'), '-nohtml', '-q'];
  if (!png) args.push('-nopng');
  const r = spawnSync(pythonCmd(), args, {
    encoding: 'utf-8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0) {
    throw new Error(`RenderCV failed (exit ${r.status}):\n${(r.stderr || r.stdout || '').trim()}`);
  }
  const outDir = join(workDir, 'out');
  const files = readdirSync(outDir);
  const pick = (ext) => files.filter(f => f.endsWith(ext)).map(f => join(outDir, f)).sort();
  const pdf = pick('.pdf')[0];
  if (!pdf) throw new Error(`RenderCV produced no PDF in ${outDir}`);
  return { yamlPath, pdf, markdown: pick('.md')[0] || null, pngs: pick('.png') };
}

function parseArgs(argv) {
  const opts = { positional: [] };
  for (const a of argv) {
    if (a === '--skip-fact-check') opts.skipFactCheck = true;
    else if (a === '--preview-steps') opts.preview = true;
    else if (a === '--stats') opts.stats = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--report=')) opts.report = a.slice(9);
    else if (a.startsWith('--theme=')) opts.theme = a.slice(8);
    else if (a.startsWith('--format=')) opts.format = a.slice(9);
    else if (a.startsWith('--floor=')) opts.floor = a.slice(8);
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}

/** Load the input as a base RenderCV document (design overrides are applied per step). */
function loadBaseDocument(inputPath, { theme, explicitTheme, format, required = DEFAULT_REQUIRED_SECTIONS }) {
  const raw = readFileSync(inputPath, 'utf-8');
  if (extname(inputPath).toLowerCase() === '.json') {
    const payload = JSON.parse(raw);
    if (format) payload.page_format = format;
    const { errors, warnings } = validatePayload(payload, 'html');
    if (errors.length) throw new Error(`Invalid CV payload:\n  - ${errors.join('\n  - ')}`);
    for (const w of warnings) console.error(`Warning: ${w}`);
    const missing = missingRequiredSections(payload, required);
    if (missing.length) {
      throw new Error(`CV payload is missing required section(s): ${missing.join(', ')} (config/profile.yml → cv.required_sections). Only optional sections such as projects may be dropped.`);
    }
    return { doc: buildRenderCvDocument(payload, { theme }), payload, format: payload.page_format || 'a4' };
  }
  const doc = yaml.load(raw);
  if (!doc?.cv) throw new Error(`${inputPath} is not a RenderCV document (no "cv" key)`);
  // A YAML file keeps its own design (it may be hand-edited); only an explicit
  // --theme restyles it, and even then its own design keys win.
  if (explicitTheme) {
    const style = resolveTheme(explicitTheme);
    const own = { ...(doc.design || {}) };
    delete own.theme;
    doc.design = mergeDesign(mergeDesign(style.design, own), { theme: style.theme });
  } else {
    doc.design = mergeDesign({ theme: 'classic' }, doc.design || {});
  }
  if (format) doc.design = mergeDesign(doc.design, { page: { size: format === 'letter' ? 'us-letter' : 'a4' } });
  const size = doc.design?.page?.size;
  return { doc, format: size === 'us-letter' ? 'letter' : 'a4' };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const root = getCareerOpsRoot();
  const profileCv = readProfileCv(root);
  const threshold = Number.isFinite(Number(profileCv.floor_alert_pct)) ? Number(profileCv.floor_alert_pct) : DEFAULT_FLOOR_ALERT_PCT;

  if (opts.stats) {
    const stats = fitStats(readFitLog(root), { threshold });
    console.log(JSON.stringify({ ...stats, ...(stats.alert ? { message: floorAlertMessage(stats) } : {}) }, null, 2));
    return;
  }

  if (opts.help || opts.positional.length < 2) {
    console.error('Usage: node generate-cv-typst.mjs <payload.json|cv.yaml> <out.pdf> [--report=NNN] [--theme=X]');
    console.error('       [--format=a4|letter] [--floor=<step>] [--skip-fact-check] [--preview-steps]');
    console.error('       node generate-cv-typst.mjs --stats   (share of recent CVs that hit the floor)');
    console.error(`Steps: ${FIT_STEPS.map(s => s.name).join(' → ')}`);
    process.exit(opts.help ? 0 : 1);
  }

  const theme = opts.theme || profileCv.theme || 'classic';
  const floor = opts.floor || profileCv.fit_floor || DEFAULT_FLOOR;
  if (!listThemes().includes(theme)) {
    console.error(`Unknown theme "${theme}". Known: ${listThemes().join(', ')}`);
    process.exit(1);
  }

  const inputPath = resolve(opts.positional[0]);
  const outPdf = resolve(opts.positional[1]);
  if (!existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }
  if (!renderCvAvailable()) {
    console.error('RenderCV is not installed. Run: pip install -r requirements-cv.txt');
    process.exit(1);
  }

  // Imported lazily: generate-pdf.mjs pulls in Playwright and creates output/.
  const { assertInsideWorkspace, countRenderedPdfPages, updatePDFManifest } = await import('./generate-pdf.mjs');
  assertInsideWorkspace(outPdf, 'output');

  let base;
  try {
    const required = Array.isArray(profileCv.required_sections) ? profileCv.required_sections : DEFAULT_REQUIRED_SECTIONS;
    // --format wins; otherwise config/profile.yml → cv.page_format pins the
    // size for every CV, whatever the payload says.
    const pinnedFormat = ['a4', 'letter'].includes(profileCv.page_format) ? profileCv.page_format : undefined;
    base = loadBaseDocument(inputPath, { theme, explicitTheme: opts.theme, format: opts.format || pinnedFormat, required });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), 'cv-typst-'));
  let renders = 0;
  const renderDoc = (sourceDoc, step, png = false) => {
    const doc = { ...sourceDoc, design: mergeDesign(sourceDoc.design, step.design) };
    const files = runRenderCv(doc, join(work, `${String(renders++).padStart(2, '0')}-${step.name}`), { png });
    return { ...files, pages: countRenderedPdfPages(readFileSync(files.pdf)) };
  };
  const renderStep = (step, png = false) => renderDoc(base.doc, step, png);

  try {
    if (opts.preview) {
      const dir = join(dirname(outPdf), `${basename(outPdf, '.pdf')}-steps`);
      mkdirSync(dir, { recursive: true });
      const rows = [];
      stepsUpTo(FIT_STEPS[FIT_STEPS.length - 1].name).forEach((step, i) => {
        const r = renderStep(step, true);
        const images = r.pngs.map((png, p) => {
          const dest = join(dir, `${i}-${step.name}-page${p + 1}.png`);
          copyFileSync(png, dest);
          return dest;
        });
        copyFileSync(r.pdf, join(dir, `${i}-${step.name}.pdf`));
        rows.push({ step: step.name, pages: r.pages, images });
      });
      console.log(JSON.stringify({ status: 'preview', theme, floor, dir, steps: rows }, null, 2));
      return;
    }

    // A JSON payload can be cut (rank-and-cut); a YAML file is only re-laid-out.
    const outcome = base.payload
      ? await fitWithCuts(base.payload, stepsUpTo(floor), (p, step) => renderDoc(buildRenderCvDocument(p, { theme }), step))
      : await fitToOnePage((step) => renderStep(step), stepsUpTo(floor));
    const dropped = outcome.dropped || [];
    const tried = outcome.tried.map(t => `${t.name}${t.dropped ? `-${t.dropped}cut` : ''}=${t.pages}p`).join(', ');
    const logFit = (outcomeName) => appendFitLog(root, { pdf: outPdf, theme, step: outcome.step.name, floor, outcome: outcomeName });
    if (!outcome.fit) {
      logFit('overflow');
      console.error(`❌ CV is still ${outcome.result.pages} pages at the floor step "${floor}" (${tried}).`);
      console.error(dropped.length
        ? `   Already cut ${dropped.length} ranked item(s); what is left is ranked must-keep. The length budget is too big: write less, or rank more as 2/3.`
        : '   Nothing was ranked 2/3, so nothing could be cut. Rank bullets (priority 2/3) or write less, then rerun.');
      process.exitCode = 2;
      return;
    }

    let factCheck = 'skipped';
    if (!opts.skipFactCheck) {
      if (!outcome.result.markdown) throw new Error('RenderCV produced no markdown; cannot run the fact gate.');
      const { assertFacts } = await import('./verify-cv-facts.mjs');
      factCheck = assertFacts(readFileSync(outcome.result.markdown, 'utf-8'), { label: basename(outPdf) }).verdict;
    }

    mkdirSync(dirname(outPdf), { recursive: true });
    copyFileSync(outcome.result.pdf, outPdf);
    const outYaml = outPdf.replace(/\.pdf$/i, '') + '.yaml';
    copyFileSync(outcome.result.yamlPath, outYaml);
    if (opts.report) updatePDFManifest(opts.report, outPdf, outYaml, base.format);
    logFit(outcome.step.name === floor && outcome.tried.length > 1 ? 'floor' : 'fit');
    const stats = fitStats(readFitLog(root), { threshold });
    if (stats.alert) console.error(`⚠️  ${floorAlertMessage(stats)}`);

    console.log(JSON.stringify({
      status: 'ok', pdf: outPdf, yaml: outYaml, pages: 1, theme,
      step: outcome.step.name, floor, tried, dropped, factCheck, report: opts.report || null,
      floorRate: { cvs: stats.cvs, rate: stats.rate, alert: stats.alert },
    }, null, 2));
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) main();
