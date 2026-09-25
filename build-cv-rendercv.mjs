#!/usr/bin/env node

// CV payload → RenderCV YAML (the Typst twin of build-cv-html.mjs).
//
// The agent tailors cv.md into the same compact JSON payload modes/pdf.md has
// always asked for. This script maps that payload onto RenderCV's input format
// so RenderCV (and the Typst engine it bundles) owns the typography — the
// layout is a maintained, professional theme instead of a hand-written HTML
// template. generate-cv-typst.mjs drives the render and the one-page fit.
//
// Same contract as the other builders: the payload is validated with the
// html vocabulary from lib/cv-payload-schema.mjs (one payload, any renderer),
// the script never reads cv.md, and it never invents content. `**bold**` and
// `*italic*` pass through, because RenderCV reads markdown in every text field.
//
// Usage:
//   node build-cv-rendercv.mjs <input.json> <output.yaml> [--theme=classic]

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { validatePayload, hasRequiredFields } from './lib/cv-payload-schema.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

export const RENDERCV_THEMES = [
  'classic', 'engineeringresumes', 'engineeringclassic', 'sb2nov', 'moderncv',
  'harvard', 'ink', 'opal', 'ember',
];

const STYLES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'cv-rendercv-styles.yml');

/** Named styles (templates/cv-rendercv-styles.yml): a built-in theme + design overrides. */
export function loadStyles(path = STYLES_PATH) {
  try {
    return yaml.load(readFileSync(path, 'utf-8')) || {};
  } catch {
    return {};
  }
}

/** Every name `cv.theme` accepts: built-in themes plus named styles. */
export function listThemes(styles = loadStyles()) {
  return [...RENDERCV_THEMES, ...Object.keys(styles)];
}

/**
 * Resolve a theme or style name to `{theme, design}`.
 * @throws when the name is neither.
 */
export function resolveTheme(name, styles = loadStyles()) {
  if (RENDERCV_THEMES.includes(name)) return { theme: name, design: {} };
  const style = styles[name];
  if (style && RENDERCV_THEMES.includes(style.theme)) return { theme: style.theme, design: style.design || {} };
  throw new Error(`Unknown CV theme or style "${name}". Known: ${listThemes(styles).join(', ')}`);
}

const DEFAULT_SECTION_TITLES = {
  summary: 'Professional Summary',
  competencies: 'Core Competencies',
  experience: 'Work Experience',
  projects: 'Projects',
  education: 'Education',
  certifications: 'Certifications',
  awards: 'Awards & Honors',
  skills: 'Skills',
  interests: 'Interests',
};

// Render order. Matches the "6-second recruiter scan" order in modes/pdf.md.
const SECTION_ORDER = [
  'summary', 'competencies', 'experience', 'projects', 'education',
  'certifications', 'awards', 'skills', 'interests',
];

const PAGE_SIZES = { a4: 'a4', letter: 'us-letter' };

// A number and its "%" never split across lines ("80 %" is French spacing):
// the space becomes a non-breaking one, whoever wrote the text.
const glueUnits = (s) => s.replace(/(\d)[  ](?=%)/g, '$1 ');
const text = (v) => (typeof v === 'string' ? glueUnits(v.trim()) : (typeof v === 'number' ? String(v) : ''));
const joinItems = (items) => (Array.isArray(items) ? items.map(text).filter(Boolean).join(', ') : text(items));
// A bullet is a string, or {text, priority} when the payload is ranked for the
// one-page cut (generate-cv-typst.mjs). The priority never reaches the render.
const bulletText = (b) => (b && typeof b === 'object' && !Array.isArray(b) ? text(b.text) : text(b));
const bullets = (list) => (Array.isArray(list) ? list.map(bulletText).filter(Boolean) : []);

// Sections every CV must carry unless config/profile.yml → cv.required_sections
// says otherwise. Projects are deliberately not here: they are optional, and the
// first thing to drop when a CV runs long.
export const DEFAULT_REQUIRED_SECTIONS = ['summary', 'experience', 'education', 'skills', 'certifications'];

/** Required sections that are absent or empty in the payload. */
export function missingRequiredSections(payload, required = DEFAULT_REQUIRED_SECTIONS) {
  return required.filter((key) => {
    const v = payload?.[key];
    if (Array.isArray(v)) return v.length === 0;
    return !text(v);
  });
}

// ── Dates ────────────────────────────────────────────────────────────────
// Payload dates are free text in any language ("Avr. 2026 – Nov. 2026",
// "Jan 2025 – Aug 2025", "Juin 2020 – Février 2021", "2023 – present").
// Parsed only to keep roles newest-first and to spot the current role.
const MONTHS = {
  jan: 1, janv: 1, janvier: 1, january: 1, feb: 2, fev: 2, fevr: 2, fevrier: 2, february: 2,
  mar: 3, mars: 3, march: 3, apr: 4, avr: 4, avril: 4, april: 4, may: 5, mai: 5,
  jun: 6, juin: 6, june: 6, jul: 7, juil: 7, juillet: 7, july: 7, aug: 8, aou: 8, aout: 8, august: 8,
  sep: 9, sept: 9, septembre: 9, september: 9, oct: 10, octobre: 10, october: 10,
  nov: 11, novembre: 11, november: 11, dec: 12, decembre: 12, december: 12,
};
const PRESENT_RE = /\b(present|présent|aujourd'hui|now|current|ongoing|en cours|actuel(?:lement)?|today)\b/i;
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\./g, ' ');

/** One date point → yyyymm, Infinity for "present", or null. */
function parseDatePoint(s, isEnd) {
  if (PRESENT_RE.test(s)) return Infinity;
  const year = s.match(/\b(19|20)\d{2}\b/);
  if (!year) return null;
  const words = fold(s.slice(0, year.index)).split(/[^a-z]+/).filter(Boolean);
  const month = words.length ? MONTHS[words[words.length - 1]] : undefined;
  return Number(year[0]) * 100 + (month || (isEnd ? 12 : 1));
}

/** "Avr. 2026 – Nov. 2026" → {start: 202604, end: 202611}; null when unreadable. */
export function parseDateRange(dates) {
  const s = text(dates);
  if (!s) return null;
  const parts = s.split(/\s*[–—]\s*|\s+-\s+|\s+(?:to|à|au)\s+/i).filter(Boolean);
  const start = parseDatePoint(parts[0], false);
  const end = parseDatePoint(parts[parts.length - 1], true);
  return start === null || end === null ? null : { start, end };
}

const nowYyyymm = (now = new Date()) => now.getFullYear() * 100 + now.getMonth() + 1;

/** A role whose end date is "present" or not reached yet. */
export function isCurrentRole(role, now = new Date()) {
  const r = parseDateRange(role?.dates || role?.period);
  return Boolean(r) && r.end >= nowYyyymm(now);
}

/**
 * Roles newest-first (end date, then start date). If any role's dates are
 * unreadable, the payload's own order is kept rather than half-sorted.
 */
export function sortNewestFirst(entries) {
  if (!Array.isArray(entries)) return entries;
  const keyed = entries.map((e, i) => ({ e, i, r: parseDateRange(e?.dates || e?.period) }));
  if (keyed.some(k => !k.r)) return entries;
  return keyed.sort((a, b) => (b.r.end - a.r.end) || (b.r.start - a.r.start) || (a.i - b.i)).map(k => k.e);
}

/** Username from a profile URL: linkedin.com/in/<user>, github.com/<user>. */
export function usernameFromUrl(url, network) {
  const raw = text(url);
  if (!raw) return '';
  let path;
  try {
    path = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).pathname;
  } catch {
    return '';
  }
  const parts = path.split('/').filter(Boolean);
  if (network === 'LinkedIn') return parts[0] === 'in' && parts[1] ? parts[1] : '';
  return parts[0] || '';
}

function buildHeader(candidate = {}) {
  const cv = { name: text(candidate.name) };
  if (text(candidate.headline)) cv.headline = text(candidate.headline);
  if (text(candidate.location)) cv.location = text(candidate.location);
  if (text(candidate.email)) cv.email = text(candidate.email);
  if (text(candidate.phone)) cv.phone = text(candidate.phone).replace(/[\s.()-]/g, '');
  const portfolio = candidate.portfolio?.url || candidate.website;
  if (text(portfolio)) cv.website = /^https?:\/\//i.test(text(portfolio)) ? text(portfolio) : `https://${text(portfolio)}`;
  const social = [];
  for (const [key, network] of [['linkedin', 'LinkedIn'], ['github', 'GitHub']]) {
    const username = usernameFromUrl(candidate[key]?.url, network);
    if (username) social.push({ network, username });
  }
  if (social.length) cv.social_networks = social;
  return cv;
}

function buildExperience(entries) {
  return entries.filter(e => hasRequiredFields(e, 'experience', 'html')).map(e => {
    const out = { company: text(e.company), position: text(e.role) };
    if (text(e.location)) out.location = text(e.location);
    const date = text(e.dates) || text(e.period);
    if (date) out.date = date;
    const hl = bullets(e.bullets);
    if (hl.length) out.highlights = hl;
    return out;
  });
}

function buildProjects(entries) {
  return entries.filter(e => hasRequiredFields(e, 'projects', 'html')).map(e => {
    let name = text(e.name);
    if (text(e.url)) name = `[${name}](${text(e.url)})`;
    if (text(e.badge)) name += ` (${text(e.badge)})`;
    const out = { name };
    if (text(e.description)) out.summary = text(e.description);
    const hl = text(e.description) ? [] : bullets(e.bullets);
    if (text(e.tech)) hl.push(`*${text(e.tech)}*`);
    if (hl.length) out.highlights = hl;
    return out;
  });
}

function buildEducation(entries) {
  return entries.filter(e => hasRequiredFields(e, 'education', 'html')).map(e => {
    // EducationEntry needs both an institution and an area; without an org the
    // degree title alone renders as a NormalEntry instead.
    const out = text(e.org)
      ? { institution: text(e.org), area: text(e.title) }
      : { name: text(e.title) };
    if (text(e.location)) out.location = text(e.location);
    if (text(e.year)) out.date = text(e.year);
    if (text(e.description)) out.highlights = [text(e.description)];
    return out;
  });
}

function buildCredentials(entries, section) {
  return entries.filter(e => hasRequiredFields(e, section, 'html')).map(e => ({
    bullet: [text(e.title), text(e.org), text(e.year)].filter(Boolean).join(' · '),
  }));
}

function buildSkills(entries) {
  const kept = entries.filter(e => hasRequiredFields(e, 'skills', 'html'));
  // A section must hold one entry type. Uncategorised lines get a blank-free
  // label rather than switching the whole section to text entries.
  return kept.map(e => ({ label: text(e.category) || 'Other', details: joinItems(e.items) }));
}

/**
 * Map a validated payload to the `cv:` block. Pure; no I/O.
 * @returns {object}
 */
export function buildCv(payload) {
  const cv = buildHeader(payload.candidate);
  const titles = { ...DEFAULT_SECTION_TITLES, ...(payload.sections || {}) };
  const sections = {};
  const put = (key, entries) => {
    if (entries.length) sections[text(titles[key]) || DEFAULT_SECTION_TITLES[key]] = entries;
  };

  // Optional payload.section_order puts the named sections first, in that
  // order; any section it leaves out keeps its default position after them.
  const requested = Array.isArray(payload.section_order)
    ? payload.section_order.filter(k => SECTION_ORDER.includes(k))
    : [];
  const order = [...new Set([...requested, ...SECTION_ORDER])];
  for (const key of order) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    switch (key) {
      case 'summary': if (text(value)) put(key, [text(value)]); break;
      case 'competencies': {
        const items = bullets(value);
        if (items.length) put(key, [items.join(' · ')]);
        break;
      }
      case 'interests': {
        const items = bullets(value);
        if (items.length) put(key, [items.join(', ')]);
        break;
      }
      case 'experience': put(key, buildExperience(sortNewestFirst(value))); break;
      case 'projects': put(key, buildProjects(value)); break;
      case 'education': put(key, buildEducation(value)); break;
      case 'certifications':
      case 'awards': put(key, buildCredentials(value, key)); break;
      case 'skills': put(key, buildSkills(value)); break;
    }
  }
  cv.sections = sections;
  return cv;
}

/**
 * Deep-merge plain objects; `override` wins. Arrays and scalars replace.
 */
export function mergeDesign(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object'
      ? mergeDesign(out[k], v)
      : v;
  }
  return out;
}

/**
 * The full RenderCV document: `cv` + `design`.
 *
 * @param {object} payload - CV payload (modes/pdf.md schema).
 * @param {{theme?: string, design?: object}} [opts] - `theme` is a built-in
 *   RenderCV theme or a named style; `design` is merged over both (the
 *   one-page fit steps pass their overrides here).
 */
export function buildRenderCvDocument(payload, { theme = 'classic', design = {} } = {}) {
  const style = resolveTheme(theme);
  const base = {
    theme: style.theme,
    page: {
      size: PAGE_SIZES[payload.page_format] || 'a4',
      // Both print English strings ("Page 1 of 1", "Last updated in ...") and
      // cost vertical space on a page that must hold everything.
      show_footer: false,
      show_top_note: false,
    },
    header: { connections: { phone_number_format: 'international' } },
  };
  // The payload carries one degree title (mapped to `area`) and no separate
  // degree, so sb2nov's "*DEGREE* *in* *AREA*" line would print "in <title>".
  if (style.theme === 'sb2nov') {
    base.templates = { education_entry: { main_column: ['**INSTITUTION**', '*AREA*', 'SUMMARY', 'HIGHLIGHTS'].join('\n') } };
  }
  return { cv: buildCv(payload), design: mergeDesign(mergeDesign(base, style.design), design) };
}

/** Validate then serialise. Throws with every validation error listed. */
export function payloadToYaml(payload, opts = {}) {
  const { errors, warnings } = validatePayload(payload, 'html');
  if (errors.length) throw new Error(`Invalid CV payload:\n  - ${errors.join('\n  - ')}`);
  const doc = buildRenderCvDocument(payload, opts);
  return { yaml: yaml.dump(doc, { lineWidth: -1, noRefs: true }), warnings };
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter(a => !a.startsWith('--'));
  const theme = (args.find(a => a.startsWith('--theme=')) || '').slice('--theme='.length) || 'classic';
  if (positional.length < 2 || args.includes('--help')) {
    console.error('Usage: node build-cv-rendercv.mjs <input.json> <output.yaml> [--theme=classic]');
    process.exit(args.includes('--help') ? 0 : 1);
  }
  const [input, output] = positional.map(p => resolve(p));
  try {
    const payload = JSON.parse(readFileSync(input, 'utf-8'));
    const { yaml: out, warnings } = payloadToYaml(payload, { theme });
    for (const w of warnings) console.error(`Warning: ${w}`);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, out);
    console.log(JSON.stringify({ status: 'ok', output, theme }));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
