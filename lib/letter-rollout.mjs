/**
 * letter-rollout.mjs — a changed letter prompt reaches applications gradually.
 *
 * Every letter prompt (the "Letter writing" rules + voice-dna.md + tone
 * examples) has an id: a hash of its text. letter-write.mjs snapshots each
 * version under data/letter-prompts/<id>.json, so an older version can keep
 * writing while a new one ramps up.
 *
 * When the prompt changes, the new version becomes the CANDIDATE and writes
 * 20% of letters, then 50%, then takes over (becomes STABLE). It moves up a
 * step after every STAGE_SIZE letters it has written. Callbacks are ~1 in 100,
 * so the ramp is by volume, not by statistics; the one brake: if the stable
 * version got a callback during the ramp and the candidate got none, the
 * ramp holds at its current step and says so.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CALLBACK_STATES, loadTrackerRows, statusFor } from './cv-experiment.mjs';
import { LETTER_LOG_RELATIVE_PATH } from './letter-check.mjs';

export const STAGES = [20, 50];     // candidate share (%) per step; after the last it takes over
export const STAGE_SIZE = 20;       // letters the candidate writes per step
const DIR = 'data/letter-prompts';

const statePath = (root) => join(root, DIR, 'state.json');
const snapPath = (root, id) => join(root, DIR, `${id}.json`);

export function loadState(root) {
  try { return JSON.parse(readFileSync(statePath(root), 'utf8')); } catch { return null; }
}
export function saveState(root, state) {
  mkdirSync(join(root, DIR), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(state, null, 2));
}
export function saveSnapshot(root, id, parts) {
  mkdirSync(join(root, DIR), { recursive: true });
  if (!existsSync(snapPath(root, id))) writeFileSync(snapPath(root, id), JSON.stringify(parts, null, 2));
}
export function loadSnapshot(root, id) {
  try { return JSON.parse(readFileSync(snapPath(root, id), 'utf8')); } catch { return null; }
}

/**
 * Register the prompt as it is in the files now. First run: it becomes
 * stable. A different, unseen version becomes the candidate at step 0
 * (replacing any earlier candidate). Pure apart from `now`.
 */
export function registerCurrent(state, id, now = new Date().toISOString()) {
  if (!state || !state.stable) return { stable: id, candidate: null, stage: 0, written: 0, startedAt: null, held: null };
  if (id === state.stable || id === state.candidate) return state;
  return { ...state, candidate: id, stage: 0, written: 0, startedAt: now, held: null };
}

/** Which version writes this letter. */
export function chooseVersion(state, rng = Math.random) {
  if (!state.candidate) return state.stable;
  return rng() * 100 < STAGES[state.stage] ? state.candidate : state.stable;
}

/** Callbacks per prompt version among letters logged since `since`. */
export function callbacksByVersion(letterRows, trackerRows, since) {
  const out = {};
  for (const r of letterRows) {
    if (since && r.timestamp < since) continue;
    const status = statusFor({ company: r.company, role: r.role }, trackerRows);
    if (status && CALLBACK_STATES.has(status)) out[r.promptVersion] = (out[r.promptVersion] || 0) + 1;
  }
  return out;
}

/**
 * Count a letter written by `id`; advance, promote or hold the ramp.
 * `callbacks` is callbacksByVersion(...) for the ramp window.
 */
export function recordWritten(state, id, callbacks = {}) {
  if (!state.candidate || id !== state.candidate) return state;
  const next = { ...state, written: state.written + 1 };
  if (next.written < STAGE_SIZE) return next;
  const stableCb = callbacks[state.stable] || 0;
  const candCb = callbacks[state.candidate] || 0;
  if (stableCb > 0 && candCb === 0) {
    return { ...next, held: `held at ${STAGES[state.stage]}%: the previous version got ${stableCb} callback(s) during the ramp, the new one none yet` };
  }
  if (state.stage + 1 < STAGES.length) return { ...next, stage: state.stage + 1, written: 0, held: null };
  return { stable: state.candidate, candidate: null, stage: 0, written: 0, startedAt: null, held: null, promotedAt: new Date().toISOString(), previous: state.stable };
}

/** Letter-log rows ({timestamp, company, role, promptVersion}) for the brake. */
export function readLetterLogRows(root) {
  const path = join(root, LETTER_LOG_RELATIVE_PATH);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.split('\t'))
    .filter((p) => p.length >= 5 && p[0] !== 'timestamp')
    .map((p) => ({ timestamp: p[0], company: p[1], role: p[2], promptVersion: p[4] }));
}

export function rampCallbacks(root, state) {
  if (!state?.candidate) return {};
  return callbacksByVersion(readLetterLogRows(root), loadTrackerRows(root), state.startedAt);
}
