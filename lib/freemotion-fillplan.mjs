#!/usr/bin/env node

/**
 * freemotion-fillplan.mjs — turn an inventory plus resolved answers into an
 * ORDERED list of typed actions, so filling a form stops being improvised.
 *
 * WHY THIS EXISTS. Requirement 1 is "any employer's site, no vendor-specific
 * code", and until now only half of that was true. `freemotion-inventory.mjs`
 * reads any form generically. Filling one was still a script written per ATS,
 * by hand, in the moment — six of them in one night, each re-deriving the same
 * mechanics and each free to forget one. The mechanics are not the hard part;
 * remembering all of them under time pressure is. So they get encoded once.
 *
 * WHAT THIS IS NOT. It performs nothing. It returns a plan: `{op, target,
 * value}` records the orchestrator executes with its own MCP calls. Every rule
 * that made a live run fail is baked into the OP CHOICE and the ORDER, both of
 * which are pure functions of the inventory and therefore testable without a
 * browser. The rules, with the failure each one prevents:
 *
 *   - **No op writes through injected JS** (G1). `el.click()` from
 *     `browser_evaluate` ticks a box without running the page framework's
 *     change handling; a consent pair then read as answered while the form
 *     refused to advance, naming a field that was plainly filled. Every op
 *     here maps to a real input event.
 *   - **An ARIA combobox is `expand_then_pick`, never `fill`**.
 *     Typing filters the list; it does not commit. A typed-only
 *     combobox reads back empty and fails validation.
 *   - **Uploads go through the trigger, not the input** (G6). The real input
 *     is 1x1px behind a dropzone that swallows the click.
 *   - **A CV upload that auto-fills runs FIRST** (G5), because it overwrites
 *     fields filled before it.
 *   - **Cascade parents go one at a time, early** (G4). Choosing a value
 *     re-renders everything below it and invalidates later targets in the same
 *     batch.
 *   - **Mutually-exclusive consent pairs go LAST** (G2). Answering one
 *     disables its partner, so any plan built before that point still lists
 *     the partner as an open question.
 *   - **`type_slow` is the retry for a field that reads back empty** (G14).
 *     Autocomplete and masked inputs ignore a programmatic fill silently.
 *
 * NO VENDOR NAME APPEARS IN THIS FILE and none may be added.
 *
 * Usage:
 *   node lib/freemotion-fillplan.mjs --inventory inv.json --answers ans.json
 *   node lib/freemotion-fillplan.mjs --inventory - --answers ans.json --summary
 */

import { readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

import { flagValue, hasFlag, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { pendingWork } from './freemotion-inventory.mjs';
import { loadAnswerContext, resolveAnswer } from './freemotion-answers.mjs';

/**
 * Every operation a plan can ask for, and the MCP call it maps to.
 *
 * A closed set: an unknown op reaching an orchestrator is a silent no-op, and
 * a form that looks planned but was never filled is worse than one that
 * refused to plan.
 */
export const OPS = Object.freeze({
  fill: 'browser_fill_form / browser_type — one programmatic write',
  type_slow: 'browser_type with slowly:true — per-character, for inputs that ignore fill',
  click: 'browser_click — a real trusted click',
  select_option: 'browser_select_option — a native <select>',
  expand_then_pick: 'browser_click the control, re-read options, browser_click the option',
  upload: 'browser_click the trigger, then browser_file_upload',
});

/** Phases, in execution order. The order IS the safety property. */
export const PHASES = Object.freeze([
  'autofill-upload',   // G5: overwrites anything filled before it
  'cascade',           // G4: re-renders the fields below it
  'text',              // safe once the cascades have settled
  'choice',            // radio / single checkbox groups
  'upload',            // remaining attachments
  'consent',           // G2: disables its partner, so it goes last
]);

const PHASE_RANK = Object.fromEntries(PHASES.map((p, i) => [p, i]));

/** Questions whose answer is a consent rather than information. */
const CONSENT_RE = /consent|agree|accept|acknowledge|privacy|gdpr|terms|retain|i have read|notice d.information/i;

/**
 * Uploads that can rewrite the rest of the form.
 *
 * A CV is the document ATS parsers read, and many parse it on upload without
 * announcing it, so the safe generic rule is that ANY CV-shaped upload goes
 * first — not only one whose label admits to autofilling. A cover letter or a
 * portfolio is an attachment and never rewrites a field.
 */
const AUTOFILL_UPLOAD_RE = /resume|cv|curriculum|autofill|auto.fill|prefill|pre.fill|parse|remplir/i;

/**
 * Does this control re-render its neighbours when answered?
 *
 * A select or combobox with a long option list is the shape that drives a
 * dependent field (country to region, region to city). Judged on the control
 * kind and option count rather than on the label, so it holds in any language.
 *
 * @param {object} item
 * @returns {boolean}
 */
function isCascadeParent(item) {
  if (item.kind !== 'field') return false;
  if (item.role !== 'combobox' && item.role !== 'listbox') return false;
  // An unknown option list means a collapsed ARIA combobox, which is exactly
  // the picklist kind that cascades; a short explicit list is a plain choice.
  return item.options === undefined || (Array.isArray(item.options) && item.options.length > 8);
}

/**
 * Which phase an item belongs to.
 *
 * @param {object} item
 * @returns {string} one of {@link PHASES}
 */
export function phaseOf(item) {
  if (item.kind === 'upload') {
    return AUTOFILL_UPLOAD_RE.test(item.question || '') ? 'autofill-upload' : 'upload';
  }
  if (CONSENT_RE.test(item.question || '')) return 'consent';
  if (item.kind === 'group') return 'choice';
  if (item.role === 'checkbox') return 'choice';
  if (isCascadeParent(item)) return 'cascade';
  // A short picklist is a choice, not free text: planning it as text would
  // emit a `fill` for a control that only accepts a listed value.
  if (item.role === 'combobox' || item.role === 'listbox') return 'choice';
  return 'text';
}

/**
 * The operation for one item.
 *
 * @param {object} item
 * @returns {string} a key of {@link OPS}
 */
export function opFor(item) {
  if (item.kind === 'upload') return 'upload';
  if (item.kind === 'group') return 'click';
  if (item.role === 'checkbox') return 'click';
  if (item.role === 'radio') return 'click';
  // A native <select> takes a value directly; an ARIA combobox does not exist
  // as a value at all until an option is clicked.
  if (item.role === 'listbox') return 'select_option';
  if (item.role === 'combobox') {
    return Array.isArray(item.options) && item.options.length && item.tag === 'select'
      ? 'select_option'
      : 'expand_then_pick';
  }
  return 'fill';
}

/** Normalize a question for matching: case, punctuation and the required star. */
function normalizeQuestion(q) {
  return String(q ?? '')
    .toLowerCase()
    .replace(/[*✱]/g, ' ')
    .replace(/[^a-z0-9à-ÿ ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match a resolved answer to a pending item.
 *
 * Exact normalized equality first, then containment in either direction: a
 * form's rendered label carries decoration ("Email*", "Adresse e-mail") that an
 * answer rule's key will not, and an answer keyed on a short phrase should
 * still match the longer question that contains it.
 *
 * @param {object} item
 * @param {Array<{question: string, value?: string, choices?: string[]}>} answers
 * @returns {object|null}
 */
export function matchAnswer(item, answers) {
  const q = normalizeQuestion(item.question);
  if (!q) return null;
  const list = answers ?? [];
  const exact = list.find((a) => normalizeQuestion(a.question) === q);
  if (exact) return exact;
  const contains = list.find((a) => {
    const k = normalizeQuestion(a.question);
    return k.length > 3 && (q.includes(k) || k.includes(q));
  });
  return contains ?? null;
}

/**
 * Pick the option label an answer should land on.
 *
 * `choices` from the answer resolver is a RANKED preference list, matched
 * against the widget's real option labels — that is what makes one rule work
 * across a form that says "Male" and one that says "Homme". When the control's
 * options are not yet known (a collapsed combobox), the ranked list is passed
 * through for the orchestrator to match after expanding.
 *
 * @param {object} item
 * @param {{value?: string, choices?: string[]}} answer
 * @returns {{value: string|null, ranked: string[]|null, matched: boolean}}
 */
export function resolveChoice(item, answer) {
  const ranked = Array.isArray(answer.choices) && answer.choices.length ? answer.choices : null;
  const options = Array.isArray(item.options) ? item.options : null;
  const wanted = ranked ?? (answer.value != null ? [String(answer.value)] : []);

  if (!options) return { value: wanted[0] ?? null, ranked: wanted.length ? wanted : null, matched: false };

  const norm = (s) => String(s).toLowerCase().trim();
  for (const w of wanted) {
    const hit = options.find((o) => norm(o) === norm(w))
             || options.find((o) => norm(o).startsWith(norm(w)))
             || options.find((o) => norm(o).includes(norm(w)));
    if (hit) return { value: hit, ranked: wanted, matched: true };
  }
  return { value: null, ranked: wanted, matched: false };
}

/**
 * Resolve every pending question through the existing answer engine.
 *
 * This is the glue that was missing. The inventory could describe any form and
 * the resolver could answer any question, but nothing joined them, so each run
 * ended with a hand-written filler that knew both halves and generalised to
 * neither. Joining them here means one command reads a form it has never seen
 * and comes back with an executable plan plus a SHORT list of what genuinely
 * needs judgment.
 *
 * A question the resolver hands back is not skipped and not guessed: it is
 * reported so the caller answers it and fills it in the same pass. Silence on
 * a question is the one outcome that is never acceptable, because the form
 * will simply refuse to advance and say nothing useful about why.
 *
 * @param {object} inventory
 * @param {object} ctx - from `loadAnswerContext()`.
 * @param {{includeOptional?: boolean}} [options]
 * @returns {{answers: object[], needsJudgment: object[]}}
 */
export function autoAnswers(inventory, ctx, options = {}) {
  const { includeOptional = true } = options;
  const work = pendingWork(inventory);
  const items = includeOptional
    ? [...work.required, ...work.optional]
    : work.required;

  const answers = [];
  const needsJudgment = [];
  for (const item of items) {
    const question = String(item.question ?? '').trim();
    if (!question) continue;
    const role = item.kind === 'group' ? item.role : item.role;
    const res = resolveAnswer({ text: question, role }, ctx);
    if (res.status === 'answered') {
      answers.push({ question, value: res.value, ...(res.choices ? { choices: res.choices } : {}), source: res.source });
    } else {
      needsJudgment.push({
        question,
        selector: item.selector,
        role: item.role,
        kind: item.kind,
        category: res.category ?? null,
        reason: res.reason ?? 'no rule matched',
        ...(Array.isArray(item.options) && item.options.length ? { options: item.options.slice(0, 12) } : {}),
      });
    }
  }
  return { answers, needsJudgment };
}

/**
 * Build the plan.
 *
 * @param {object} inventory - parsed FORM_INVENTORY_SCRIPT output.
 * @param {Array<{question: string, value?: string, choices?: string[], file?: string}>} [answers]
 * @param {{resumePath?: string, includeOptional?: boolean}} [options] -
 *   `includeOptional` defaults TRUE: a form is done when a human would call it
 *   complete, not when its asterisks are satisfied.
 * @returns {{actions: object[], unanswered: object[], noOptionMatch: object[],
 *   phases: string[], counts: object}}
 */
export function buildFillPlan(inventory, answers = [], options = {}) {
  const { resumePath, includeOptional = true } = options;
  const work = pendingWork(inventory);
  const items = includeOptional
    ? [...work.required, ...work.optional, ...work.uploads]
    : [...work.required, ...work.uploads.filter((u) => u.required)];

  const actions = [];
  const unanswered = [];
  const noOptionMatch = [];

  for (const item of items) {
    const phase = phaseOf(item);
    const op = opFor(item);

    if (item.kind === 'upload') {
      const answer = matchAnswer(item, answers);
      const file = answer?.file ?? (/resume|cv/i.test(item.question) ? resumePath : undefined);
      if (!file) { unanswered.push({ ...item, phase, reason: 'no file for this upload' }); continue; }
      actions.push({
        op, phase, target: item.clickSelector || item.selector, file,
        question: item.question,
        note: 'click the trigger, then browser_file_upload; confirm by finding the FILENAME in the page, not via input.files',
      });
      continue;
    }

    const answer = matchAnswer(item, answers);
    if (!answer) { unanswered.push({ ...item, phase, reason: 'no answer resolved' }); continue; }

    if (op === 'click' || op === 'select_option' || op === 'expand_then_pick') {
      const choice = resolveChoice(item, answer);
      if (!choice.value && !choice.ranked) { unanswered.push({ ...item, phase, reason: 'answer has no value' }); continue; }
      if (Array.isArray(item.options) && item.options.length && !choice.matched) {
        noOptionMatch.push({ ...item, phase, wanted: choice.ranked, available: item.options.slice(0, 8) });
        continue;
      }
      // A group's target is the specific option, not the group.
      let target = item.selector;
      if (item.kind === 'group' && Array.isArray(item.choices)) {
        const norm = (s) => String(s).toLowerCase().trim();
        const pick = item.choices.find((c) => (choice.ranked ?? [choice.value]).some((w) => norm(c.label) === norm(w)))
                  || item.choices.find((c) => (choice.ranked ?? [choice.value]).some((w) => norm(c.label).includes(norm(w))));
        if (!pick) {
          noOptionMatch.push({ ...item, phase, wanted: choice.ranked, available: item.choices.map((c) => c.label) });
          continue;
        }
        target = pick.selector;
      }
      actions.push({
        op, phase, target, value: choice.value, ranked: choice.ranked,
        question: item.question,
        note: op === 'expand_then_pick'
          ? 'real click to expand, re-read [role=option], then click the option — typing filters but never commits'
          : 'a real trusted click; never el.click() from browser_evaluate',
        ...(phase === 'consent' ? { verify: 'after this, the partner control must read disabled:true, required:false' } : {}),
      });
      continue;
    }

    if (answer.value == null || String(answer.value) === '') {
      unanswered.push({ ...item, phase, reason: 'answer resolved to empty' });
      continue;
    }

    actions.push({
      op, phase, target: item.selector, value: String(answer.value),
      question: item.question,
      ...(item.maxLength ? { maxLength: item.maxLength } : {}),
      note: 'if it reads back empty, retry with type_slow — autocomplete and masked inputs ignore fill silently',
      retryOp: 'type_slow',
    });
  }

  actions.sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase]);

  return {
    actions,
    unanswered,
    noOptionMatch,
    phases: [...new Set(actions.map((a) => a.phase))],
    counts: {
      actions: actions.length,
      unanswered: unanswered.length,
      noOptionMatch: noOptionMatch.length,
      // One at a time: each of these re-renders the block beneath it, so a
      // caller batching them loses every target after the first.
      cascadeOneAtATime: actions.filter((a) => a.phase === 'cascade').length,
    },
  };
}

const USAGE = `Usage:
  node lib/freemotion-fillplan.mjs --inventory <file|-> [--answers <file>]
       [--resume <path>] [--required-only] [--resolve] [--summary]

Turns a form inventory plus resolved answers into an ordered list of typed
actions. Performs nothing: the orchestrator executes the ops with its own MCP
calls. The ORDER is the safety property — autofill upload, then cascading
picklists one at a time, then text, then choices, then remaining uploads, then
consent pairs last.

--answers is a JSON array of {question, value?, choices?, file?}.
--resolve answers every question through config/apply-answers.yml, the profile
  and the CV first, and reports only what still needs judgment.`;

function readJson(spec, label) {
  const text = spec === '-' ? readFileSync(0, 'utf-8')
    : readFileSync(isAbsolute(spec) ? spec : join(getCareerOpsRoot(), spec), 'utf-8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label}: could not parse JSON — ${err.message}`);
  }
}

function main(argv) {
  validateFlags(argv, ['--inventory', '--answers', '--resume', '--required-only', '--resolve', '--summary', '--help', '-h'], USAGE,
    { valueFlags: ['--inventory', '--answers', '--resume'] });

  const invSpec = flagValue(argv, '--inventory');
  if (!invSpec) { console.error(USAGE); return 2; }

  const inventory = readJson(invSpec, '--inventory');
  const includeOptional = !hasFlag(argv, '--required-only');
  const ansSpec = flagValue(argv, '--answers');
  let answers = ansSpec ? readJson(ansSpec, '--answers') : [];
  let needsJudgment = [];
  if (hasFlag(argv, '--resolve')) {
    const auto = autoAnswers(inventory, loadAnswerContext(), { includeOptional });
    // A file passed with --answers wins: it is the caller having already
    // decided, usually on the very questions the resolver handed back.
    const given = new Set(answers.map((a) => String(a.question).toLowerCase()));
    answers = [...answers, ...auto.answers.filter((a) => !given.has(String(a.question).toLowerCase()))];
    needsJudgment = auto.needsJudgment.filter((n) => !given.has(String(n.question).toLowerCase()));
  }

  const plan = buildFillPlan(inventory, answers, {
    resumePath: flagValue(argv, '--resume'),
    includeOptional,
  });
  plan.needsJudgment = needsJudgment;

  if (!hasFlag(argv, '--summary')) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    for (const phase of PHASES) {
      const inPhase = plan.actions.filter((a) => a.phase === phase);
      if (!inPhase.length) continue;
      console.log(`\n${phase}${phase === 'cascade' ? '  (one at a time — each re-renders the fields below it)' : ''}`);
      for (const a of inPhase) {
        console.log(`  ${a.op.padEnd(17)} ${String(a.question).slice(0, 46).padEnd(48)} ${a.value ?? a.file ?? ''}`);
      }
    }
    for (const n of plan.needsJudgment ?? []) {
      console.log(`\nNEEDS JUDGMENT  ${String(n.question).slice(0, 70)}`);
      console.log(`  ${n.role}${n.category ? ` · ${n.category}` : ''} · ${n.reason}${n.options ? ` · options ${JSON.stringify(n.options)}` : ''}`);
    }
    for (const u of plan.unanswered) console.log(`\nUNANSWERED  ${String(u.question).slice(0, 60)}  (${u.reason})`);
    for (const n of plan.noOptionMatch) {
      console.log(`\nNO OPTION MATCH  ${String(n.question).slice(0, 50)}`);
      console.log(`  wanted ${JSON.stringify(n.wanted)} — available ${JSON.stringify(n.available)}`);
    }
    console.log(`\n${plan.counts.actions} actions, ${plan.counts.unanswered} unanswered, ${plan.counts.noOptionMatch} unmatched`);
  }
  return plan.unanswered.length || plan.noOptionMatch.length || (plan.needsJudgment?.length ?? 0) ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exitCode = 1;
  }
}
