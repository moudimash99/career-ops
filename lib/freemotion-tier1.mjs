#!/usr/bin/env node

/**
 * freemotion-tier1.mjs — the deterministic pass. Turn a parsed snapshot into a
 * fill plan, and hand back only what genuinely needs deciding.
 *
 * This is where the throughput comes from. Every field this module resolves is
 * a field `agy` does not have to reason about — it just executes a precomputed
 * action. What makes Tier 1 "$0" is NOT that it avoids an MCP call (it cannot;
 * `agy` owns the only browser, §1.5), but that it avoids a model REASONING
 * token per field. On the real Greenhouse form captured in this repo, that is
 * the difference between thinking about 40 fields and thinking about 6.
 *
 * PURE. No browser, no network, no MCP call. In, a `SnapshotField[]` and some
 * parsed config; out, a plan. `agy` executes it.
 *
 * ── RULE PRECEDENCE ───────────────────────────────────────────────────────
 * A hand-written `config/apply-answers.yml` rule beats the built-in
 * {@link STANDARD_FIELD_RULES}, for the same reason §1.7 gives: a rule the user
 * wrote by hand is at least as authoritative as anything shipped, and usually
 * more specific. It is also load-bearing here — `config/profile.yml` stores
 * `linkedin` WITHOUT a scheme ("linkedin.com/in/…"), which some URL validators
 * reject, while the user's own rule carries the full `https://` form. Built-ins
 * second means the better value wins without special-casing.
 *
 * ── BUTTONS ARE NEVER IN THE FILL PLAN ────────────────────────────────────
 * The single most dangerous thing this module could emit is a click on
 * "Submit application" — the fill plan is executed BEFORE Tier 3 validates
 * anything (§2.3 step 4 vs step 7), so a submit action here would send a
 * half-filled application to an employer and bypass the entire gate. Buttons
 * therefore never produce a FillAction. They are returned separately in
 * `controls`, classified, so `agy` can find Attach / Next / Submit and click
 * them at the point in the loop where clicking is correct.
 *
 * ── AN EMPTY VALUE IS NOT AN ANSWER ───────────────────────────────────────
 * The live `config/profile.yml` has `github: ""` and `wechat: ""`. Treating
 * those as resolved would emit a fill action writing an empty string, which
 * Tier 3 then reports as `unfilled-expected` — a self-inflicted validation
 * failure on every posting with a GitHub field. An empty profile value, an
 * empty rule `answer`, and a `skip: true` rule all mean the same thing here:
 * this rule offers nothing, send the field onward (§1.3 — there is no skip).
 *
 * ── WHAT THIS MODULE DOES NOT DECIDE ──────────────────────────────────────
 * Whether a field is REQUIRED. The accessibility snapshot does not reliably
 * expose it, and guessing would either block on optional fields or wave
 * through empty required ones. That judgement is Tier 3's (§4.4), which runs
 * before every step-advance regardless of what was filled here.
 *
 * Usage:
 *   node lib/freemotion-tier1.mjs --snapshot - [--profile config/profile.yml]
 *     [--apply-answers config/apply-answers.yml] [--cv cv.md] [--pdf-path output/cv.pdf]
 */

import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import * as yaml from 'js-yaml';

import { flagValue, validateFlags } from './cli-flags.mjs';
import { isMainModule } from './is-main-module.mjs';
import { parseAccessibilitySnapshot } from './freemotion-snapshot.mjs';
// One implementation of the year computation, shared with the answer resolver,
// so a token expanded here and one expanded there can never disagree.
import { computeYearsExperience, isStructuralSubfield } from './freemotion-answers.mjs';
import { getCareerOpsRoot } from '../path-resolver.mjs';

/** Raised when the candidate's own data is missing or unreadable. */
export class FreemotionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FreemotionConfigError';
  }
}

/**
 * One executable step of the plan.
 *
 * @typedef {Object} FillAction
 * @property {string} ref - MCP element ref, passed back verbatim.
 * @property {string} role
 * @property {'fill'|'select'|'check'|'upload'} action - The MCP tool family to
 *   use. Never `click`: see the header note on buttons.
 * @property {string} value
 * @property {string[]} [choices] - For `select`, the ordered option labels to
 *   try against the widget's real options, best first.
 * @property {'profile'|'apply-answers'} source
 * @property {string|null} matchedRule - The rule that produced this, for audit.
 * @property {string} name - The field's accessible name, so the log reads.
 */

/**
 * Identity fields every ATS asks for, that need no per-user tuning beyond what
 * `config/profile.yml` already holds.
 *
 * Ordered: `first name` / `last name` are tested before the bare `name`
 * pattern, or "First Name" resolves to the full name and the form gets
 * "Mohammad Machaka" in a field expecting "Mohammad".
 */
export const STANDARD_FIELD_RULES = [
  { match: /first name|given name|prénom|prenom/i, profileKey: 'candidate.full_name', transform: 'firstWord' },
  // Bare "Nom" is the surname on a French form (it sits beside "Prénom").
  // Matched ONLY as a standalone label: "Nom de l'entreprise" and "Nom du
  // poste" are a company and a job title, and an unanchored /^nom/ fills
  // the candidate's surname into both (seen on VISEO's form).
  { match: /last name|surname|family name|nom de famille|^nom\s*[*:]?\s*$/i, profileKey: 'candidate.full_name', transform: 'lastWord' },
  { match: /^(full |legal |your )?name$|full name|legal name/i, profileKey: 'candidate.full_name' },
  { match: /e-?mail|courriel/i, profileKey: 'candidate.email' },
  { match: /phone|mobile|telephone|téléphone/i, profileKey: 'candidate.phone', transform: 'phoneCompact' },
  { match: /linkedin/i, profileKey: 'candidate.linkedin' },
  { match: /github/i, profileKey: 'candidate.github' },
  { match: /portfolio|personal website|^website$|personal site/i, profileKey: 'candidate.portfolio_url' },
  { match: /^city|current city|city of residence|ville/i, profileKey: 'candidate.location', transform: 'cityOnly' },
  { match: /^country|country of residence|pays/i, profileKey: 'location.country' },
  { match: /resume|^cv$|curriculum|upload.*(resume|cv)|(resume|cv).*upload|attach.*(resume|cv)/i, action: 'upload', pdfPathFromWorkOrder: true },
];

/**
 * Buttons whose click submits or advances the form.
 *
 * Classified, not filtered, because `agy` needs to FIND them — it just must not
 * be handed them as part of a plan that runs before validation.
 */
const BUTTON_KINDS = [
  { kind: 'submit', match: /^(submit|apply|send)\b|submit application|apply now|envoyer/i },
  { kind: 'next', match: /^(next|continue|save (and|&) (continue|next))\b|suivant/i },
  { kind: 'attach', match: /attach|upload|browse|choose file|parcourir/i },
];

/** Roles that carry a question and can hold a value. */
const VALUE_ROLES = ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'spinbutton'];

/** Roles that are never an independent question. */
const NON_QUESTION_ROLES = ['button', 'option'];

/**
 * Values that mean "tick this box". Anything else is a text answer that
 * happened to match a checkbox's label, and must NOT become a tick.
 *
 * Found live on Thales/Workday (#594): the hand-written `preferred name` rule
 * matched the checkbox "I have a preferred name" and Tier 1 turned the answer
 * "Mohammad" into `check`. Ticking that box opens a preferred-name sub-form the
 * candidate never asked for — a field written into an employer's record on the
 * strength of a substring match. A checkbox is boolean; only a boolean answers
 * it.
 */
const AFFIRMATIVE_VALUES = /^(y|yes|true|1|on|oui|si|ja|checked?|agree[d]?|i agree|accept(ed)?|i accept|consent|i consent)$/i;


/**
 * Would executing this action write the wrong KIND of value into the control?
 *
 * Applied to whichever rule won — hand-written or built-in — because the defect
 * is in the pairing of answer and control, not in where the answer came from.
 *
 * @param {{action: string, value: unknown}|null} action
 * @returns {boolean}
 */
function actionSuitsControl(action) {
  if (!action) return false;
  if (action.action !== 'check') return true;
  return AFFIRMATIVE_VALUES.test(String(action.value ?? '').trim());
}

/**
 * The MCP action family a role needs.
 *
 * @param {string} role
 * @returns {'fill'|'select'|'check'}
 */
function actionForRole(role) {
  if (role === 'combobox' || role === 'listbox') return 'select';
  if (role === 'checkbox' || role === 'radio' || role === 'switch') return 'check';
  return 'fill';
}

/**
 * Read a dot-path without throwing on a missing branch.
 *
 * @param {object} obj
 * @param {string} path
 * @returns {unknown}
 */
function readPath(obj, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

/**
 * Apply a named transform to a profile value.
 *
 * @param {string} value
 * @param {string|undefined} transform
 * @returns {string}
 */
function applyTransform(value, transform) {
  const text = String(value).trim();
  if (!transform) return text;
  if (transform === 'firstWord') return text.split(/\s+/)[0] ?? '';
  // Last WORD, not "everything after the first": a middle name would otherwise
  // end up in the surname field.
  if (transform === 'lastWord') return text.split(/\s+/).filter(Boolean).pop() ?? '';
  // "Toulouse, France" -> "Toulouse".
  if (transform === 'cityOnly') return text.split(',')[0].trim();
  // Strip the spaces a human writes into a phone number. Thales/Workday (#594)
  // rejected "+33 7 53 37 78 23" with "Enter a valid format for Phone Number";
  // the same digits with no spaces are accepted. Only whitespace goes — the
  // digits and any leading + are the number, and are never rewritten here.
  if (transform === 'phoneCompact') return text.replace(/[\s.-]/g, '');
  return text;
}

/**
 * Load every deterministic input.
 *
 * A missing or unparseable `config/profile.yml` is fatal — nothing downstream
 * can run without the candidate's own data. A missing `apply-answers.yml` is
 * not: the run degrades to {@link STANDARD_FIELD_RULES} alone and sends more
 * questions onward, which is a slower run, not a wrong one.
 *
 * @param {{profilePath?: string, applyAnswersPath?: string, cvPath?: string, root?: string}} [paths]
 * @returns {{profile: object, applyAnswers: {rules: object[], resume?: string}, cvText: string}}
 * @throws {FreemotionConfigError}
 */
export function loadDeterministicRules(paths = {}) {
  const root = paths.root ?? getCareerOpsRoot();
  const at = (p, fallback) => {
    const chosen = p ?? fallback;
    return isAbsolute(chosen) ? chosen : join(root, chosen);
  };

  const profilePath = at(paths.profilePath, 'config/profile.yml');
  if (!existsSync(profilePath)) {
    throw new FreemotionConfigError(`missing required file: ${profilePath}`);
  }
  let profile;
  try {
    profile = yaml.load(readFileSync(profilePath, 'utf-8'));
  } catch (err) {
    throw new FreemotionConfigError(`unparseable YAML in ${profilePath}: ${err.message}`);
  }
  if (!profile || typeof profile !== 'object') {
    throw new FreemotionConfigError(`${profilePath} did not parse to an object`);
  }

  let applyAnswers = { rules: [] };
  const answersPath = at(paths.applyAnswersPath, 'config/apply-answers.yml');
  if (existsSync(answersPath)) {
    try {
      applyAnswers = yaml.load(readFileSync(answersPath, 'utf-8')) ?? { rules: [] };
    } catch {
      // A hand-edited file with a YAML typo degrades to the built-ins rather
      // than taking down the run.
      applyAnswers = { rules: [] };
    }
  }

  const cvPath = at(paths.cvPath, 'cv.md');
  return { profile, applyAnswers, cvText: existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '' };
}

/**
 * Classify a button by what clicking it does.
 *
 * @param {string} name
 * @returns {'submit'|'next'|'attach'|'other'}
 */
export function classifyButton(name) {
  const text = String(name ?? '');
  for (const { kind, match } of BUTTON_KINDS) {
    if (match.test(text)) return kind;
  }
  return 'other';
}

/**
 * Build the fill plan.
 *
 * @param {import('./freemotion-snapshot.mjs').SnapshotField[]} fields
 * @param {{profile: object, applyAnswers?: {rules?: object[], resume?: string},
 *          cvText?: string, pdfPath?: string}} ctx
 * @returns {{fillPlan: FillAction[],
 *            remaining: import('./freemotion-snapshot.mjs').SnapshotField[],
 *            controls: {ref: string, role: string, name: string, kind: string}[]}}
 *   `remaining` is every value-bearing field no rule resolved — each needs an
 *   answer from `lib/freemotion-answers.mjs` or the model, and none may be left
 *   blank. `controls` is buttons and dropdown options: never questions, never
 *   fill actions, but `agy` needs them to operate the form. Splitting them out
 *   is a deviation from the plan's two-key return, and it is load-bearing: the
 *   real captured Greenhouse form carries 8 "Toggle flyout" buttons and a
 *   "Submit application" button, and routing those into `remaining` would send
 *   them to the answer resolver as though they were interview questions.
 */
export function classifyFields(fields, ctx) {
  const fillPlan = [];
  const remaining = [];
  const controls = [];
  const context = ctx ?? {};
  const profile = context.profile ?? {};
  const rules = Array.isArray(context.applyAnswers?.rules) ? context.applyAnswers.rules : [];
  const resumePath = context.pdfPath ?? context.applyAnswers?.resume ?? '';
  const seen = new Set();

  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field.ref !== 'string' || field.ref === '') continue;
    // One action per ref. A snapshot can list the same element twice when a
    // form re-renders mid-capture, and two writes to one field is the
    // duplicate-value bug the requirements brief's Lessons section names.
    if (seen.has(field.ref)) continue;
    seen.add(field.ref);

    const role = String(field.role ?? '').toLowerCase();
    const name = String(field.name ?? '');

    if (NON_QUESTION_ROLES.includes(role)) {
      controls.push({ ref: field.ref, role, name, kind: role === 'option' ? 'option' : classifyButton(name) });
      continue;
    }
    if (!VALUE_ROLES.includes(role)) continue;

    // A field with no accessible name carries no question to match on. It is
    // not droppable — it is exactly the kind of unlabelled widget Tier 2
    // exists for — so it goes onward rather than being guessed at here.
    if (name.trim() === '') { remaining.push(field); continue; }

    // Checked BEFORE any rule runs: the guard exists because the rules match,
    // not because they fail to.
    if (isStructuralSubfield(name)) { remaining.push(field); continue; }

    const action = fromUserRules(rules, field, name, role, context)
      ?? fromStandardRules(field, name, role, profile, resumePath);

    // A rule that matched but produced the wrong kind of value for this control
    // sends the field onward, exactly like a rule that matched nothing.
    if (actionSuitsControl(action)) fillPlan.push(action);
    else remaining.push(field);
  }

  return { fillPlan, remaining, controls };
}

/**
 * First matching hand-written rule, as a FillAction.
 *
 * @returns {FillAction|null} `null` when no rule matches, or the matching rule
 *   offers no usable value (`skip: true`, or an empty `answer` with no
 *   `choose` — both of which mean "send this onward", never "leave it blank").
 */
function fromUserRules(rules, field, name, role, context) {
  for (const rule of rules) {
    if (!rule || typeof rule.match !== 'string') continue;
    let re;
    try { re = new RegExp(rule.match, 'i'); } catch { continue; }
    if (!re.test(name)) continue;

    // First match wins, exactly as the file's own header documents — including
    // when the winning rule turns out to offer nothing. Continuing to a later
    // rule here would silently override the user's ordering.
    if (rule.skip === true) return null;

    const choices = Array.isArray(rule.choose) ? rule.choose.filter((c) => typeof c === 'string' && c.trim() !== '') : [];
    const answer = typeof rule.answer === 'string' ? expandTokens(rule.answer, context).trim() : '';
    if (answer === '' && choices.length === 0) return null;

    const act = actionForRole(role);
    return {
      ref: field.ref,
      role,
      action: act,
      value: answer !== '' ? answer : choices[0],
      ...(act === 'select' && choices.length ? { choices } : {}),
      source: 'apply-answers',
      matchedRule: rule.match,
      name,
    };
  }
  return null;
}

/**
 * First matching built-in rule, as a FillAction.
 *
 * @returns {FillAction|null} `null` when nothing matches or the profile value
 *   is empty — the live profile has `github: ""` and `wechat: ""`, and writing
 *   an empty string into a form is a validation failure, not a fill.
 */
function fromStandardRules(field, name, role, profile, resumePath) {
  for (const rule of STANDARD_FIELD_RULES) {
    if (!rule.match.test(name)) continue;

    if (rule.pdfPathFromWorkOrder) {
      // No CV to upload is not something to improvise around: the field goes
      // onward so agy can generate or locate one first.
      if (!resumePath) return null;
      return { ref: field.ref, role, action: 'upload', value: resumePath, source: 'profile', matchedRule: String(rule.match), name };
    }

    const raw = readPath(profile, rule.profileKey);
    if (raw === null || raw === undefined) return null;
    const value = applyTransform(raw, rule.transform);
    if (value === '') return null;

    return { ref: field.ref, role, action: actionForRole(role), value, source: 'profile', matchedRule: String(rule.match), name };
  }
  return null;
}

/**
 * Expand the tokens `config/apply-answers.yml` supports.
 *
 * Delegates to `lib/freemotion-answers.mjs`'s computation, so both paths agree.
 *
 * @param {string} answer
 * @param {{cvText?: string}} context
 * @returns {string}
 */
function expandTokens(answer, context) {
  if (!answer.includes('{{')) return answer;
  return answer.replace(/\{\{\s*years_experience\s*\}\}/g, () => {
    const years = computeYearsExperience(context.cvText ?? '');
    return years === null ? '' : String(years);
  });
}

const USAGE = `Usage:
  node lib/freemotion-tier1.mjs --snapshot -            # read snapshot from stdin
  node lib/freemotion-tier1.mjs --snapshot <path>

Options:
  --profile <path>         default config/profile.yml   (required to exist)
  --apply-answers <path>   default config/apply-answers.yml   (optional)
  --cv <path>              default cv.md                      (optional)
  --pdf-path <path>        the tailored CV to upload for THIS posting; falls
                           back to apply-answers.yml's own \`resume:\` key
  --root <path>            data root override (tests)

Prints {"fillPlan":[...],"remaining":[...],"controls":[...]}.

Execute every fillPlan action, then answer every \`remaining\` field — none may
be left blank. \`controls\` is buttons and options: never fill them from the
plan, and never click a submit/next control until Tier 3 has passed.`;

const VALUE_FLAGS = ['--snapshot', '--profile', '--apply-answers', '--cv', '--pdf-path', '--root'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--help', '-h'];

/**
 * CLI entry.
 *
 * @returns {void}
 */
function main() {
  const argv = process.argv.slice(2);
  validateFlags(argv, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const snapshotArg = flagValue(argv, '--snapshot');
  if (!snapshotArg) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // `-` is stdin, which is how agy pipes a browser_snapshot straight in
  // without staging it through a file.
  const snapshotText = snapshotArg === '-' ? readFileSync(0, 'utf-8') : readFileSync(snapshotArg, 'utf-8');

  const ctx = loadDeterministicRules({
    root: flagValue(argv, '--root'),
    profilePath: flagValue(argv, '--profile'),
    applyAnswersPath: flagValue(argv, '--apply-answers'),
    cvPath: flagValue(argv, '--cv'),
  });

  const fields = parseAccessibilitySnapshot(snapshotText);
  const result = classifyFields(fields, { ...ctx, pdfPath: flagValue(argv, '--pdf-path') });
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
