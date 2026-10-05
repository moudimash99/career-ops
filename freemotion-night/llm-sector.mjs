#!/usr/bin/env node
// @ts-check
/**
 * freemotion-night/llm-sector.mjs — which sector a job's WORK is for, and
 * whether it needs a security clearance (user, 2026-10-04). Defence,
 * government and clearance jobs get score 0 (off the night list); space jobs
 * rank 1 lower. What happens to each sector is config/targets.yml `sectors:`.
 *
 * The question is part of the fit score (llm-score.mjs): the same call that
 * rates the five factors also answers
 *   sector     evidence first, then none | defence | space | government
 *   clearance  true when the job needs a clearance, eligibility for one, or a nationality
 * and llm-score.mjs appends the answer here, to data/llm-sector.tsv (one row
 * per same-job key, the last row wins). This file holds the wording of the
 * question, that store, and applySectors() for the night list.
 *
 * Why a model. Words in the posting text are too blunt (counted on the
 * 2026-10-04 pool of 2,390 jobs): consultancies list the sectors they serve
 * ("aéronautique, spatial, défense") in every posting, "souveraineté" is a
 * sovereign-cloud selling point, "état" is mostly "état de l'art". Title and
 * company words stay as free rules (pool-rules.mjs DEFENCE / GOVERNMENT); the
 * clearance words here ("habilitable", "habilitation secret"…) need no model.
 *
 * The wording was checked on 2026-10-04 against 100 postings (60 with sector
 * words in the text), Flash as the reference, every disagreement judged by
 * hand: before the worked examples, Flash-Lite took consultancies' sector
 * lists for the job's sector (3 of 10); with them, 3.1 Flash-Lite wrongly
 * zeroed 2 of 100 (cyber "défense", "France 2030" funding: the two rules
 * below), 3.5 Flash-Lite 3 (client lists). Gemma is not checked yet (#14).
 *
 *   node freemotion-night/llm-sector.mjs --status   answers stored, by sector
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { companyKey, rankScore, titleKey } from './pool-rules.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

export const SECTOR_PATH = join(getCareerOpsRoot(), 'data/llm-sector.tsv');
export const MODEL_SECTORS = ['none', 'defence', 'space', 'government'];
const COLUMNS = ['key', 'title', 'company', 'sector', 'clearance', 'evidence', 'model', 'version', 'at'];
const keyOf = (job) => `${companyKey(job.co || '')}|${titleKey(job.title || '')}`;

// Needs a clearance or a nationality: the posting says so in so many words.
// Accents are stripped before matching.
const CLEARANCE = /\bhabilitable\b|habilitation (secret|confidentiel|defense|sd\b|cd\b)|\bsecret defense\b|\bconfidentiel defense\b|security clearance|clearance (is )?required|nationalite francaise (est )?(requise|exigee|obligatoire|indispensable|imperative)|\b(etre|etant) de nationalite (francaise|europeenne)|ressortissant (francais|europeen|de l.union)/;
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The clearance words found in a job's title or text, or null. */
export function clearanceRule({ title = '', text = '' } = {}) {
  const m = deaccent(`${title} ${text}`).match(CLEARANCE);
  return m ? m[0] : null;
}

// ── The question (part of the fit-score instructions) ────────────────────

export const SECTOR_GUIDE = `sector — who THIS job's work is done for: the employer, or, when a consultancy or agency posts it, the client or project the posting names for this job. FIRST write "evidence", THEN "value":
  defence     armed forces, military or weapons programs, military drones or counter-drone, defence ministry, defence industry work
  space       satellites, launchers, space agencies, space missions, the ground segment of space systems
  government  a public administration: ministry, local authority (city, department, region), state agency or public body, police; or a project for one
  none        anything else, including civil aviation, airports, banks, hospitals, telecoms and ordinary companies
How to decide: find what THIS job works on (the title, the mission, the project, the product, the client). Only that decides. A sector word in the job title decides ("Ingénieur Counter-UAS" is defence).
A sentence that names SEVERAL sectors the company works in ("présents dans l'aéronautique, le spatial, la défense, l'énergie") is the company's description, not this job: it is never evidence, whatever sectors it names. The same for a list of clients ("nos clients : banques, organismes publics, industrie").
Cybersecurity is not defence: "cyber-défense", "défense des systèmes d'information" or "capacités de défense" of an information system is "none".
Public funding is not government: a project funded by France 2030, Bpifrance, the EU or a grant is "none"; only a public body as employer or client is "government".
When nothing says what this job is for, the value is "none". "Sovereign cloud" or "souveraineté numérique" alone is "none". When several apply, give the main one.
clearance — true only when the posting asks for a security clearance, for being eligible for one ("habilitable", "habilitation secret défense"), or for a nationality.`;

// Made-up postings (2026-10-04): Flash-Lite took a consultancy's list of
// sectors for the job's sector until it was shown the difference.
export const SECTOR_EXAMPLES = `Worked examples for "sector" (made up, for calibration):
"Altiva accompagne ses clients dans l'aéronautique, le spatial, la défense, l'énergie et le ferroviaire. Vous rejoindrez l'équipe qui développe la plateforme de paiement d'une grande banque." → sector {evidence "plateforme de paiement d'une grande banque", value "none"}, clearance false.
"Acteur reconnu de la défense, du spatial et de la santé, Novatek recrute un ingénieur DevOps pour industrialiser ses chaînes CI/CD." → sector {"not stated", "none"}, clearance false (the company's sectors; nothing says what this job's work is for).
"Au sein d'un programme de frégates de la Marine nationale, vous validez le système de combat." → sector {"programme de frégates de la Marine nationale", "defence"}, clearance false.
"Vous développez le logiciel de contrôle bord d'un satellite d'observation de la Terre." → sector {"logiciel de contrôle bord d'un satellite", "space"}, clearance false.
"Pour le compte d'une métropole, vous concevez l'entrepôt de données des services de la ville. Profil habilitable." → sector {"pour le compte d'une métropole", "government"}, clearance true.`;

/** The answer fields, for the fit-score schema (llm-score.mjs RESPONSE_SCHEMA). */
export const SECTOR_SCHEMA_FIELDS = {
  sector: {
    type: 'object',
    properties: { evidence: { type: 'string' }, value: { type: 'string', enum: MODEL_SECTORS } },
    required: ['evidence', 'value'],
    propertyOrdering: ['evidence', 'value'],
  },
  clearance: { type: 'boolean' },
};

/**
 * The sector part of one model answer, or null when it is missing or not one
 * of MODEL_SECTORS (the fit score still counts; the sector is asked again later).
 * @returns {{ sector: string, clearance: boolean, evidence: string } | null}
 */
export function parseSectorAnswer(j) {
  const value = j?.sector?.value;
  if (!MODEL_SECTORS.includes(value) || typeof j?.clearance !== 'boolean') return null;
  return { sector: value, clearance: j.clearance, evidence: String(j.sector.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

// ── Store: data/llm-sector.tsv ────────────────────────────────────────────

const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

/**
 * Every stored answer, the last row per key.
 * @returns {Map<string, { sector: string, clearance: boolean, evidence: string }>}
 */
export function readSectors(path = SECTOR_PATH) {
  const out = new Map();
  if (!existsSync(path)) return out;
  const [head, ...lines] = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const cols = head.split('\t');
  for (const line of lines) {
    const r = Object.fromEntries(line.split('\t').map((v, i) => [cols[i], v]));
    if (r.key) out.set(r.key, { sector: r.sector || 'none', clearance: r.clearance === 'yes', evidence: r.evidence || '' });
  }
  return out;
}

/** Append one answer for a job ({ title, co }). */
export function appendSector(job, answer, { model, version, at = new Date(), path = SECTOR_PATH }) {
  if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${COLUMNS.join('\t')}\n`); }
  appendFileSync(path, `${[keyOf(job), job.title, job.co || '', answer.sector, answer.clearance ? 'yes' : 'no', answer.evidence, model, version, at.toISOString()].map(cell).join('\t')}\n`);
}

// ── The night list ────────────────────────────────────────────────────────

/**
 * Apply targets.yml `sectors:` to the night list's candidates. A sector in
 * `drop` sets the job's score to 0 (the model's answer), so it leaves the
 * list; so does needing a clearance when `clearance` is in `drop` (the model's
 * answer, or the clearance words in the text, which need no answer). A sector
 * in `penalty` is added to the job's rank. A job with no answer yet keeps its place.
 * @param {object[]} candidates - scored rows (applyScores kept)
 * @param {Map<string, { sector: string, clearance: boolean, evidence: string }>} answers
 * @param {Map<string, string>} texts - url → posting text
 * @param {{ drop: string[], penalty: Record<string, number> }} config
 * @returns {{ kept: object[], dropped: Array<{ row: object, why: string }>, unanswered: number }}
 */
export function applySectors(candidates, answers, texts, config) {
  const drop = new Set(config?.drop || []);
  const penalty = config?.penalty || {};
  const kept = [];
  const dropped = [];
  let unanswered = 0;
  for (const x of candidates) {
    const a = answers.get(keyOf(x));
    if (!a) unanswered++;
    if (drop.has('clearance')) {
      const words = clearanceRule({ title: x.title, text: texts.get(x.url) });
      if (words || a?.clearance) { dropped.push({ row: { ...x, fit: 0 }, why: `score 0: needs a clearance (${words ? 'text' : 'model'})` }); continue; }
    }
    const sector = a?.sector && a.sector !== 'none' ? a.sector : null;
    if (sector && drop.has(sector)) { dropped.push({ row: { ...x, fit: 0 }, why: `score 0: ${sector} (model)` }); continue; }
    const p = sector ? penalty[sector] || 0 : 0;
    if (!p) { kept.push(sector ? { ...x, sector } : x); continue; }
    kept.push({ ...x, sector, sectorPenalty: p, score: +(x.score + p).toFixed(2), ...(x.rank != null && { rank: rankScore({ ...x, sectorPenalty: p }) }) });
  }
  return { kept, dropped, unanswered };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function main(argv) {
  if (!argv.includes('--status')) { console.log('usage: node freemotion-night/llm-sector.mjs --status'); return; }
  const all = [...readSectors().values()];
  const by = {};
  for (const a of all) { const k = a.clearance ? `${a.sector}+clearance` : a.sector; by[k] = (by[k] || 0) + 1; }
  console.log(`llm-sector: ${all.length} jobs answered ${JSON.stringify(by)}`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
