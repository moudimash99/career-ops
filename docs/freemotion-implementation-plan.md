# Free Motion — Implementation Plan

Companion to `docs/freemotion-requirements.md` and `docs/freemotion-architecture.md`
(both read-only source material for this plan — not edited here). Written for a
weaker model to execute without design judgement: every module below has an
exact file path, exact exported signatures, exact on-disk data shapes, and an
acceptance assertion. Where the two briefs conflict with each other or with
reality, that is resolved in Section 1 before anything else — do not skip it
and start coding from Section 4.

Prior art read before writing this plan: `merge-tracker.mjs` (URL-keyed dedup,
`Pass 0`), `url-key.mjs` (`normalizeUrl`), `pipeline-lock.mjs`
(`withPipelineLock`, the generic cross-process directory lock — this is what
Requirement 8's dedup ledger reuses), `followup-seed.mjs`
(`withFollowupsLock` — the same protocol, hand-rolled a second time; read to
confirm the shape and then deliberately NOT copied a third time),
`tracker-utils.mjs` (`writeFileAtomic`, `renameSyncWithRetry`),
`lib/is-main-module.mjs`, `lib/cli-flags.mjs`, `application-answers.mjs`,
`profile-language.mjs` (the `import * as yaml from 'js-yaml'` convention),
`doctor.mjs` (Playwright MCP detection, `MCP_CONFIGS`), `update-system.mjs`
(`SYSTEM_PATHS`/`USER_PATHS`), `templates/states.yml`, `modes/apply.md`
(the interactive sibling mode and its preflight/knockout/blacklist gates),
and two files already sitting in this checkout, untracked and gitignored,
that the previous (now-deleted) per-vendor applier used and that this plan
repurposes rather than replaces: `config/apply-answers.yml` and
`config/apply-essays.yml`.

**Priority weighting note:** the requirements brief's own weighting drives
the level of detail below — throughput of correct submissions, the
deterministic-first fill path (Tier 1), account creation, and the
browser-engine swap seam get the most specification. Auditability is a real,
implemented requirement (§4.8) but is one non-functional requirement among
several in the brief, not the center of this design, and is sized
accordingly: a straightforward append-only record, no query layer, no
review tooling.

---

## 1. Design review — what I changed and why

### 1.1 Requirement 1 — "any employer's site... without vendor-specific code"

**Problem:** Not fully achievable. Cloudflare Enterprise / DataDome /
Turnstile-protected sites, and Workday tenants with bot-detection tuned
aggressively, will defeat even Camoufox on some fraction of postings. The
brief itself concedes this by asking for the Camoufox swap-in, which is an
admission that the default engine cannot reach every site.

**Resolution:** Redefine "reach a submitted state on any site" as the
*target*, not a guarantee, and make failure a first-class, auditable outcome
rather than a silent stop. Every posting Free Motion attempts ends in exactly
one of six recorded outcomes (`submitted`, `validation-failed`, `captcha`,
`blocked-waf`, `account-verification-pending`, `errored`) — see §4.5. A run
that "does not reach 100% of sites" is not a bug in this design; a run that
fails silently or fails to record why is.

### 1.2 Requirement 2 — automatic account creation incl. email verification

**Problem:** "Email verification where it can be automated" already hedges
itself — but the repo has no inbox access anywhere (no IMAP/webmail
integration exists in career-ops today). There is nothing to automate against.

**Resolution:** Account creation (filling a registration form with the
candidate's real email + a generated password, saved locally) is in scope
and specified in §4.6 — this is where the detail belongs, per the brief's
own priorities. Clicking a verification link was descoped from the *initial*
build: the run detects the "check your email" wall, saves the credentials,
records the outcome as `account-verification-pending`, and moves to the next
posting rather than blocking. That was a narrow, explicit descope of one
sub-step, not a silent drop of Requirement 2 — the account-creation flow
itself runs autonomously, start to submitted-registration-form, exactly as
required.

**Status: closed.** The inbox seam that did not exist when this section was
written now does — `lib/freemotion-inbox.mjs`, built in §6 Phase 9 once the
loop was green end-to-end. `account-verification-pending` is a resumable
outcome, not a terminal one. The reason it was worth building second rather
than first is visible in that module's design: reading an inbox for *an
action* is a different security problem from every other untrusted input in
career-ops, and it deserved its own pass rather than being bolted onto the
first build.

### 1.3 Requirements 5 and 6 — answered exactly as written, no abstention anywhere

Requirement 5: *"Answer every question — autonomy over abstention. An
unanswerable-looking required field is never a reason to skip a posting...
inferring where the answer is entailed rather than stated, and choosing the
most probable answer for this candidate where nothing is entailed."*
Requirement 6: the six legally-consequential categories are read from
`config/profile.yml → application_answers`, never inferred; a missing key
falls back to `location.visa_status` / `compensation`, logged as
`answered-from-fallback`, and the run continues.

Both are implemented literally. **There is no review queue, no pause, and no
abstention path anywhere in this design.** Every required field gets a
value, always, in the same turn it is discovered, following one fixed
priority order (full detail in §4.3):

1. Stated directly — a literal field in `cv.md` / `config/profile.yml`, or a
   matching rule in `config/apply-answers.yml` / `config/apply-essays.yml`.
2. For the six Requirement-6 categories specifically: the matching key under
   `application_answers`, then the `location.visa_status` /
   `compensation` fallback when the specific key is absent.
3. Entailed — mechanically derivable from `cv.md` (e.g. years of experience
   computed from date ranges), the same shortcut
   `config/apply-answers.yml`'s existing `{{years_experience}}` token
   already uses.
4. Nothing above resolves it — `agy` (the orchestrator, the only actual
   model in this loop) supplies the most probable answer for this candidate,
   right then, in the same pass, and the answer is written to the form
   immediately. No field is ever left blank on this path.

Every answer, on every one of these four paths, is written to the
per-run audit log with its source (§4.8) — that is the accountability
mechanism the brief asks for, and it is proportionate to the design, not a
gate on it.

### 1.4 Architecture brief — Tier 3: DOM floor plus vision on every gate

**Problem, two-sided.** The architecture brief describes Tier 3 as a
screenshot sent to a multimodal LLM, then names its own failure: multi-page
and inner-scroll forms defeat a screenshot ("I have already tried doing this
before and even an llm wasn't able to take a good screenshot"). But DOM-only
is *also* insufficient, and for the opposite reason: much of what a human
reads off a form in half a second does not survive into HTML — which option a
custom dropdown actually landed on, whether a value is truncated or
overflowing its box, whether text went into the field next to the intended
one, whether a field is visually flagged red by a validator that never sets
`aria-invalid`, whether a step rendered at all. Either signal alone lets a
class of half-filled submission through, and per the requirements brief a
visibly half-filled submission burns that company permanently.

**Resolution: both, at every gate — not DOM-first with vision as a
final-page afterthought.** Every step-advance (each Next, and the final
Submit) runs the deterministic DOM check *and* a vision check, and `agy` may
click only when both pass.

- **DOM check** (`lib/freemotion-validate.mjs`, §4.4) is the free, instant,
  deterministic floor: empty fields, `aria-invalid`, visible `[role="alert"]`,
  unexpected navigation, and — see §4.4 — a diff of what Tier 1/2 *intended*
  to fill against what the DOM actually holds.
- **Vision check** runs on the same gate and answers what the DOM cannot:
  *does this look like a complete, correct application to a human?*

**The screenshot pitfall is solved by changing what is captured, not by
giving up on capture:**

1. **Capture the form container element, not the viewport.**
   `browser_take_screenshot` against an element ref captures that element's
   full box, including content scrolled out of view inside it. The container
   is the nearest common ancestor of the refs in this step's fill plan, which
   Tier 1 already knows. This is the direct answer to the inner-scroll
   failure.
2. **Fall back to sequential scrolled captures** when a container exceeds
   what one image can carry: scroll it in viewport-height steps, capture
   each, hand `agy` the ordered set. Several images of one step is fine; one
   unreadable image of one step is not.
3. **Multi-page stops being a screenshot problem at all.** Validation is
   per-step, at each step's own boundary, so no single image ever has to
   cover a whole wizard. The earlier attempt could not get a good screenshot
   because it was trying to photograph the entire form; this design never
   asks it to.

### 1.5 "Thin Playwright wrappers" vs. "orchestrator drives MCP tools" — decision

**Decision: the orchestrator (`agy`) drives the Playwright MCP tools
directly; every library file in this plan is a pure data transform with zero
browser control of its own.** No script in this plan calls `playwright`,
imports `chromium`/`firefox`/`webkit`, or opens a `Browser`/`Page` object.

**Justification:**
- **One browser-launch site, not two.** The engine-swap requirement (§1.6)
  demands the browser be replaceable "without any knowledge of coding." If a
  Tier-1 script launched its own Playwright browser *and* the MCP server
  launched another, a non-coder swapping Camoufox in would have to edit two
  places (or the two sessions would run against two different browsers
  entirely, defeating Tier 2/3's ability to see what Tier 1 did). Exactly one
  process may own the browser: the MCP server `agy` already connects to.
- **Camoufox doesn't have a stable remote-attach story the way Chromium's CDP
  does.** A second Node process attaching to an already-running Firefox-based
  session to hand control back and forth between "our script" and "agy" is
  extra machinery this design does not need if agy is the only driver.
- **Pure functions are trivially testable without a browser.** Every
  acceptance test in §4 runs against a fixture string or fixture JSON object
  — `node test-all.mjs` never needs Playwright installed to prove these
  modules correct.

Consequently "Tier 1, the fast $0 pass" does not mean "a script that owns a
browser and fills fields in milliseconds without agy in the loop" — agy still
issues every `browser_fill_form`/`browser_click`/`browser_type` call. What
makes Tier 1 "$0 and cheap" is that agy is not *reasoning* about each field —
it is mechanically executing a precomputed plan a deterministic script
produced. The cost saved is LLM *reasoning* tokens per field, not the MCP
tool-call itself, which is unavoidable given the single-driver decision above.

### 1.6 Camoufox / engine-swap seam — concretized

The architecture brief asks for the engine to be swappable "without any
knowledge of coding" but does not say where the swap lives. Concretized as:
a two-field block in `config/profile.yml` plus one sync script that
regenerates the Playwright MCP server's launch arguments in `.mcp.json`
(already gitignored, already the real mechanism `doctor.mjs` scans — see
`MCP_CONFIGS` in `doctor.mjs`). Full spec in §4.7
(`lib/freemotion-engine-config.mjs`) — this is one of the four areas the
brief weights most heavily, and it gets matching detail. A non-coder edits
two YAML values and runs one command; nothing else changes.

### 1.7 Prior art repurposed, not reinvented

`config/apply-answers.yml` and `config/apply-essays.yml` already exist on
disk (untracked, gitignored: see `.gitignore` lines 59 and 165), left behind
by the deleted per-vendor applier (`git show d822b34 --stat`) whose code is
gone but whose data survived. They are hand-tuned, already encode this user's
real answers (Toulouse, Passeport Talent, ISAE-SUPAERO, salary floor,
a `never_auto` list for canned answers to security clearance / criminal
record / salary history / notice-period penalties / AI-authorship
attestations that overlaps Requirement 6's protected-category shape,
arrived at independently before this plan existed), and are reused as-is in
§4.3 rather than replaced by a new format. `config/profile.yml →
application_answers` remains the authoritative source for the six
Requirement-6 categories specifically (structured, single-purpose);
`config/apply-answers.yml` / `config/apply-essays.yml` cover everything else
a form asks, and also supply the first-choice canned answer even inside a
protected category when one of their rules matches (§4.3 step 1 runs before
the category check, since a rule the user already wrote by hand is at least
as authoritative as a structured key). A `never_auto` match in
`config/apply-essays.yml` means "no canned text for this one" — per §1.3
there is no abstention, so it falls through to entailment/most-probable
resolution like anything else unmatched, it does not stop the field from
being answered.

These two files are not currently documented in `AGENTS.md`'s Data Contract
table or `update-system.mjs`'s `USER_PATHS`. §6 Phase 2 adds both.

### 1.8 Minor: a stale cross-reference in the requirements brief

`docs/freemotion-requirements.md` cites `AGENTS.md`'s "Traps that cost real
time" section for context on per-vendor maintenance cost. No such section
exists in the current `AGENTS.md` (verified by full-text read). Harmless —
it does not change anything in this plan — noted only because the review
instruction says to flag what does not check out.

### 1.9 Two pre-existing, unrelated coverage gaps found during research

`modes/apply-freemotion.md` and `modes/auto-apply.md` are both tracked in
git but **neither appears in `update-system.mjs`'s `SYSTEM_PATHS`** today
(`grep -n "apply-freemotion\|auto-apply\.md" update-system.mjs` returns
nothing but the unrelated `modes/apply.md` line). This predates this plan and
is not caused by it, but this plan rewrites `modes/apply-freemotion.md`, so
§6 Phase 7 fixes the registration for both files as part of landing that
rewrite (leaving `auto-apply.md` unregistered while touching its sibling in
the same PR would be an obvious miss to leave for later).

---

## 2. Architecture

### 2.1 Components, one line each

| Component | Kind | Owns a browser? |
|---|---|---|
| `agy` (Antigravity CLI) | orchestrator (Tier 2 + Tier 3 decision-making, and the sole source of "most probable answer" judgment) | drives the Playwright MCP server's tools |
| Playwright MCP server | external process, launched per `.mcp.json` | yes — the only browser in the system |
| `freemotion-run.mjs` | root CLI, work-order resolver + dedup claim | no |
| `lib/freemotion-snapshot.mjs` | pure parser | no |
| `lib/freemotion-tier1.mjs` | pure classifier + fill-plan builder + CLI | no |
| `lib/freemotion-answers.mjs` | pure answer resolver (profile/fallback/entailed, hands off what it can't decide) + CLI | no |
| `lib/freemotion-validate.mjs` | pure DOM-result evaluator + CLI | no |
| `lib/freemotion-submissions.mjs` | durable ledger + CLI | no |
| `lib/freemotion-credentials.mjs` | local credential store for account creation | no |
| `lib/freemotion-engine-config.mjs` | MCP launch-arg sync + CLI | no |
| `lib/freemotion-log.mjs` | append-only audit log | no |

### 2.2 The seam between deterministic code and the orchestrator

Every library file above communicates with `agy` the same way: **JSON in,
JSON out, over stdin/argv/stdout.** `agy` calls `browser_snapshot` or
`browser_evaluate` itself (it holds the MCP session; nothing else can), pipes
the result into one of these scripts as `--snapshot -` (stdin) or a
`--dom-json` file, reads the script's JSON verdict from stdout, and then
issues the next MCP tool calls itself based on that verdict. No script in
this plan ever calls an MCP tool, and no script ever needs Playwright
installed to run. This is the direct implementation of §1.5's decision.

### 2.3 Data flow, one posting, happy path

```
freemotion-run.mjs --report 42
  → claims the URL in data/freemotion-submissions.tsv (outcome: in-progress)
  → prints a work order JSON (url, company, role, reportPath, pdfPath,
    draftAnswers, engineConfig) to stdout, exits 0

agy reads the work order, then for THIS POSTING loops per form step:

  1. browser_navigate(url)                         [Tier 0 — agy, direct]
  2. browser_snapshot()                             [Tier 0 — agy, direct]
  3. echo <snapshot> | node lib/freemotion-tier1.mjs --snapshot -
       → { fillPlan: [...], remaining: [...] }      [Tier 1 — deterministic]
  4. agy executes fillPlan via browser_fill_form / browser_type /
     browser_select_option / browser_click, then logs each fill via
     lib/freemotion-log.mjs (§4.8)                  [Tier 1 execution — agy]
  5. FOR EACH field in `remaining`:
       node lib/freemotion-answers.mjs --question "..." --ref eNN --role ...
         → { status: 'answered', value, source, category }
           | { status: 'needs-model-judgment', category, question }
     agy fills every 'answered' field with the given value. For
     'needs-model-judgment', agy itself decides the most probable answer for
     this candidate right now, fills it, and logs it with source 'inferred'
     plus a one-line reasoning string — never left blank, never deferred.
                                                     [Tier 2 — agy + answers]
  6. Non-standard widgets (file upload, custom multi-select, a CAPTCHA
     challenge) are handled by agy directly via browser_file_upload /
     browser_click / browser_select_option; a CAPTCHA hit STOPS this
     posting (see §4.7 CAPTCHA policy) rather than being solved.
  7. BEFORE clicking Next or Submit on THIS step, BOTH gates must pass
     (§1.4 — neither alone is sufficient):
       a. agy runs browser_evaluate(DOM_VALIDATION_SCRIPT) → domResult
          echo <domResult> | node lib/freemotion-validate.mjs --dom-json - \
            --expected <expected.json> --attempted <refs>
            → { valid: bool, failures: [...] }     [Tier 3a — deterministic]
          `expected` is this step's intended fill set (Tier 1's fillPlan plus
          every field answered in step 5), so the gate checks the application
          is COMPLETE — not merely that `[required]` is non-empty. See §4.4.
       b. agy captures the form container ELEMENT via browser_take_screenshot
          (element ref, not viewport — §1.4) and reads it itself: does this
          look like a complete, correct application to a human? Wrong option
          selected, truncated value, text in the wrong box, a red-flagged
          field the DOM never marked.                  [Tier 3b — vision]
     Either gate failing → agy goes back to step 5 for the named fields, with
     the specific failure reasons handed back as guidance (the architecture
     brief's "guide it there" requirement; 3a's failure list is generated
     deterministically, 3b's is agy's own read of the image).
  8. Both gates pass → agy clicks Next/Submit. If more steps remain, loop to
     1 (skip navigate — same page) / 2. If this was the final Submit and the
     post-submit page confirms (title/URL/confirmation text), continue to 9.
  9. node lib/freemotion-submissions.mjs finalize --url <url> \
       --outcome submitted --report 42 --run-id <id> --notes "..."
  10. node set-status.mjs 42 Applied --note "Free Motion: submitted <ts>"
  11. node followup-seed.mjs 42 --json
```

Any failure branch (CAPTCHA, WAF block, account-verification wall, repeated
Tier-3 failure past a retry budget, an unhandled error) calls step 9's
`finalize` with the matching outcome instead of `submitted`, and skips 10/11.
`freemotion-run.mjs` is invoked again for the next posting; nothing about one
posting's outcome affects the next.

---

## 3. File manifest

| Path | Purpose | Bucket |
|---|---|---|
| `freemotion-run.mjs` | root CLI — resolves a work order, claims the dedup lock | `SYSTEM_PATHS` |
| `lib/freemotion-snapshot.mjs` | parses Playwright MCP accessibility-tree text | `SYSTEM_PATHS` |
| `lib/freemotion-tier1.mjs` | deterministic field classifier + fill-plan builder | `SYSTEM_PATHS` |
| `lib/freemotion-answers.mjs` | priority-order answer resolver (§1.3/§4.3) | `SYSTEM_PATHS` |
| `lib/freemotion-validate.mjs` | DOM-first Tier-3 validator | `SYSTEM_PATHS` |
| `lib/freemotion-submissions.mjs` | durable URL-keyed submission ledger | `SYSTEM_PATHS` |
| `lib/freemotion-credentials.mjs` | local per-site credential store | `SYSTEM_PATHS` |
| `lib/freemotion-engine-config.mjs` | browser-engine seam / `.mcp.json` sync | `SYSTEM_PATHS` |
| `lib/freemotion-log.mjs` | append-only per-run audit log | `SYSTEM_PATHS` |
| `lib/freemotion-inbox.mjs` | verification-mail reader (Phase 9) — Gmail or a pasted file, one guarded link out | `SYSTEM_PATHS` |
| `lib/freemotion-inventory.mjs` | generic form reader (Phase 11) — labels, group questions, options, upload triggers, shadow-DOM piercing, re-render-proof selectors | `SYSTEM_PATHS` |
| `config/mcp.example.json` | template a user copies to `.mcp.json` | `SYSTEM_PATHS` |
| `tests/freemotion-snapshot.test.mjs` | §4.1 acceptance test | `SYSTEM_PATHS` (covered by the `tests/` prefix already in the list) |
| `tests/freemotion-tier1.test.mjs` | §4.2 acceptance test | same |
| `tests/freemotion-answers.test.mjs` | §4.3 acceptance test | same |
| `tests/freemotion-validate.test.mjs` | §4.4 acceptance test | same |
| `tests/freemotion-submissions.test.mjs` | §4.5 acceptance test | same |
| `tests/freemotion-credentials.test.mjs` | §4.6 acceptance test | same |
| `tests/freemotion-engine-config.test.mjs` | §4.7 acceptance test | same |
| `tests/freemotion-log.test.mjs` | §4.8 acceptance test | same |
| `tests/freemotion-run.test.mjs` | §4.9 acceptance test | same |
| `tests/freemotion-inbox.test.mjs` | Phase 9 acceptance test — mostly a security test | same |
| `tests/freemotion-inventory.test.mjs` | Phase 11 acceptance test | same |
| `modes/apply-freemotion.md` | rewritten mode file, §5 | `SYSTEM_PATHS` (already tracked; add the missing entry per §1.9) |
| `data/freemotion-submissions.tsv` | runtime ledger, not created by this plan's code until first run | `USER_PATHS` (covered by the existing `data/` prefix) |
| `data/freemotion-runs/{runId}.jsonl` | runtime audit log | same, `data/` prefix |
| `data/freemotion-credentials/{hash}.json` | runtime local credentials | same, `data/` prefix |
| `config/apply-answers.yml` | **pre-existing**, now load-bearing | `USER_PATHS` — add explicitly (currently gitignored but not in `USER_PATHS`; harmless today since the coverage check only scans tracked files, but add it for documentation parity, see §6 Phase 2) |
| `config/apply-essays.yml` | **pre-existing**, now load-bearing | `USER_PATHS` — same as above |

Two files this plan's build order touches but does **not** create fresh:
`config/profile.example.yml` (gains a `freemotion:` block and documents
`application_answers`, §6 Phase 2) and `update-system.mjs` (gains the
`SYSTEM_PATHS`/`USER_PATHS` entries in the table above, plus the two-file fix
from §1.9).

---

## 4. Per-module specification

Every function below is pure unless stated otherwise (no network, no
browser, no MCP call). Every CLI reads `--flag value` and `--flag=value` via
`lib/cli-flags.mjs`'s `flagValue`/`hasFlag`/`validateFlags`, uses `import *
as yaml from 'js-yaml'` where YAML is read, and ends with the standard guard:

```js
import { isMainModule } from './lib/is-main-module.mjs'; // '../lib/...' from files inside lib/ that import a sibling
if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
```

### 4.1 `lib/freemotion-snapshot.mjs`

Parses the Playwright MCP `browser_snapshot` accessibility-tree text format,
confirmed against real captures in `.playwright-mcp/page-*.yml`:

```
- generic [ref=e3]:
  - textbox "Email Address" [ref=e84]
  - button "Read More" [ref=e795] [cursor=pointer]
  - link [ref=e433] [cursor=pointer]:
    - /url: https://example.com
    - text: apply via our internal career page
```

```js
/**
 * @typedef {Object} SnapshotField
 * @property {string} ref     - MCP element ref, e.g. "e84". Never empty.
 * @property {string} role    - accessibility role, lowercase, e.g. "textbox".
 * @property {string} name    - accessible name (may be '').
 * @property {string[]} attrs - other bracket attributes on the line minus
 *                               `ref=...`, e.g. ["cursor=pointer", "checked"].
 * @property {number} depth   - 0-based indentation depth (2 spaces per level).
 */

/**
 * @param {string} snapshotText - Raw browser_snapshot output.
 * @returns {SnapshotField[]} Every line that both (a) declares a `[ref=...]`
 *   and (b) has a role in FILLABLE_ROLES. Metadata lines (`- /url:`,
 *   `- text:`) and non-interactive containers (generic, heading, paragraph,
 *   list, listitem, link with no form purpose) are dropped. Malformed lines
 *   are skipped, never thrown on — an empty or garbled snapshot returns [].
 */
export function parseAccessibilitySnapshot(snapshotText) { /* ... */ }

export const FILLABLE_ROLES = [
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'button',
  'listbox', 'option', 'switch', 'spinbutton',
];
```

Line-matching rule (implement literally, do not redesign): a field line is
`/^\s*-\s+([a-z][a-z ]*?)(?:\s+"((?:[^"\\]|\\.)*)")?\s*((?:\[[^\]]*\]\s*)*):?\s*$/`
against the line with leading whitespace stripped for `depth` computation
first (`depth = leadingSpaces / 2`, integer). `role` = group 1 trimmed and
lowercased with any trailing modifier words dropped by taking the first
whitespace-delimited token only (`"list item"` → treat as unmatched/skip
rather than guess — role is a single accessibility-tree token in every real
capture seen). `name` = group 2 (unescape `\"` → `"`), default `''`. `attrs`
= every `[...]` in group 3 except one matching `/^ref=(.+)$/`, whose capture
becomes `ref`; a line with no `ref=` attribute is dropped (not returned) —
non-interactive decoration. A line whose role is not in `FILLABLE_ROLES` is
dropped even if it has a ref (e.g. a `link`, `heading`, `generic` container).

**Acceptance assertion** (`tests/freemotion-snapshot.test.mjs`):
```js
const fixture = [
  '- generic [ref=e3]:',
  '  - textbox "Email Address" [ref=e84]',
  '  - button "Read More" [ref=e795] [cursor=pointer]',
  '  - link [ref=e433] [cursor=pointer]:',
  '    - /url: https://example.com',
  '    - text: apply via our internal career page',
].join('\n');
const fields = parseAccessibilitySnapshot(fixture);
assert(fields.length === 2); // textbox + button; link/generic/url/text dropped
assert(fields[0].ref === 'e84' && fields[0].role === 'textbox' && fields[0].name === 'Email Address');
assert(fields[1].ref === 'e795' && fields[1].attrs.includes('cursor=pointer'));
```

### 4.2 `lib/freemotion-tier1.mjs`

This is where most of the throughput comes from — the brief's stated
priority — so it gets first claim on detail among the four "remaining"
modules below.

```js
/**
 * @typedef {Object} FillAction
 * @property {string} ref
 * @property {string} role
 * @property {'fill'|'select'|'click'|'check'|'upload'} action
 * @property {string} value
 * @property {'profile'|'apply-answers'} source
 * @property {string|null} matchedRule - the regex source that matched, for audit.
 */

/**
 * Load every deterministic input source. Throws FreemotionConfigError only
 * when profilePath is missing/unparseable (fatal — nothing else in this
 * pipeline can run without the candidate's own data). A missing
 * apply-answers.yml is NOT fatal: it degrades to the built-in identity-field
 * table only, and STANDARD_FIELD_RULES below still fires.
 * @param {{profilePath: string, applyAnswersPath?: string, cvPath: string}} paths
 * @returns {{profile: object, applyAnswers: {rules: object[]}, cvText: string}}
 */
export function loadDeterministicRules(paths) { /* ... */ }

/** Built into this module, not user-editable — identity fields every ATS asks
 * and that never need per-user tuning beyond what's already in profile.yml. */
export const STANDARD_FIELD_RULES = [
  { match: /^(full |legal )?name$/i, profileKey: 'candidate.full_name' },
  { match: /first name/i, profileKey: 'candidate.full_name', transform: 'firstWord' },
  { match: /last name|surname|family name/i, profileKey: 'candidate.full_name', transform: 'lastWord' },
  { match: /e-?mail/i, profileKey: 'candidate.email' },
  { match: /phone/i, profileKey: 'candidate.phone' },
  { match: /linkedin/i, profileKey: 'candidate.linkedin' },
  { match: /portfolio|personal website|^website$/i, profileKey: 'candidate.portfolio_url' },
  { match: /github/i, profileKey: 'candidate.github' },
  { match: /^city|current city|city of residence/i, profileKey: 'candidate.location', transform: 'cityOnly' },
  { match: /^country|country of residence/i, profileKey: 'location.country' },
  { match: /resume|^cv$|upload.*(resume|cv)/i, action: 'upload', pdfPathFromWorkOrder: true },
];

/**
 * @param {import('./freemotion-snapshot.mjs').SnapshotField[]} fields
 * @param {{profile: object, applyAnswers: {rules: object[]}, cvText: string, pdfPath?: string}} ctx
 * @returns {{fillPlan: FillAction[], remaining: SnapshotField[]}}
 *   `remaining` = every FILLABLE_ROLES field neither STANDARD_FIELD_RULES nor
 *   an apply-answers.yml rule matched. Per §1.3 there is no separate
 *   "skip" outcome any more — a `config/apply-answers.yml` rule with
 *   `skip: true` also lands in `remaining`, exactly like an unmatched field,
 *   so it is answered downstream by `lib/freemotion-answers.mjs` /
 *   `agy` rather than silently dropped. "Required" is NOT decided here — the
 *   accessibility snapshot does not reliably expose `required`; that
 *   judgement is Tier 3's (§4.4), which runs right before every
 *   step-advance regardless of what Tier 1 filled.
 */
export function classifyFields(fields, ctx) { /* ... */ }
```

`config/apply-answers.yml` rule application (reused verbatim, same
first-match-wins order as the file's own header documents): a rule's `match`
is a case-insensitive regex tested against `field.name`; `answer` → `action:
'fill'` (or `'select'` when `field.role === 'combobox'` and `choose` is
present — try each `choose` entry in order as the option label, first that
plausibly matches wins, else fall back to `answer`).

**Acceptance assertion** (`tests/freemotion-tier1.test.mjs`): a fixture
profile with `candidate.email: "jane@example.com"`, a fixture
`config/apply-answers.yml`-shaped object with one rule for `linkedin`, and a
`SnapshotField[]` containing `{ref:'e1', role:'textbox', name:'Email Address'}`,
`{ref:'e2', role:'textbox', name:'LinkedIn'}`, `{ref:'e3', role:'textbox',
name:'Favorite programming language'}` →
`classifyFields(...).fillPlan` has length 2 (email from `profile`, linkedin
from `apply-answers`), `.remaining` has length 1 (`e3`).

### 4.3 `lib/freemotion-answers.mjs`

Implements the priority order from §1.3. This module never abstains and
never invents a "most probable" guess itself — the last step of the
priority order genuinely requires model judgement (Requirement 5's own
words: *"the model answers"*), which this deterministic script cannot
produce. Its job is to resolve everything a fixed set of rules CAN resolve,
and to correctly recognize the one case it cannot, handing that — and only
that — to `agy` for an immediate, same-turn answer. That division of labor is
what makes Tier 1/2 cheap at all: nothing gets sent to the model that a rule
could already answer.

```js
/** @typedef {'work_authorization'|'background'|'credentials'|'compensation'|'availability'|'eeo'} ProtectedCategory */

export const PROTECTED_CATEGORY_PATTERNS = {
  work_authorization: /visa|sponsor|work authoriz|right to work|legally (able|permitted|entitled) to work/i,
  background: /criminal|conviction|felony|background check|arrest record/i,
  credentials: /\bdegree\b|diploma|licen[cs]e|certification\b|security clearance|clearance (level|eligibility)/i,
  compensation: /salary|compensation expectation|desired (pay|salary|comp)|pay expectation/i,
  availability: /notice period|available to start|earliest start|start date/i,
  eeo: /\bgender\b|\brace\b|ethnicity|disability status|veteran status|self.identif|eeo\b/i,
};

/** @param {string} questionText @returns {ProtectedCategory|null} first pattern that matches, in the object's key order. */
export function classifyCategory(questionText) { /* ... */ }

/**
 * Per-category sub-key sniffing. Each entry: {pattern, path} where `path` is
 * a dot-path into `config/profile.yml`'s `application_answers` block. This
 * table is a STARTER set covering every key already present in a real
 * `application_answers` block (work_authorization.{authorized_to_work_in_*,
 * requires_sponsorship_now, requires_sponsorship_future},
 * background.{criminal_record, consent_to_background_check},
 * credentials.{highest_degree, licences, security_clearance},
 * compensation.{expected_annual_gross_eur, minimum_annual_gross_eur,
 * single_figure_answer}, availability.{earliest_start_date,
 * notice_period_days, willing_to_relocate, willing_to_travel},
 * eeo_self_identification.{gender, race_ethnicity, disability_status,
 * veteran_status}). Extend it as new sub-questions are found.
 */
export const PROTECTED_SUBKEY_TABLE = { /* per category, ordered array of {pattern, path} — see inline table in the file */ };

/**
 * @param {ProtectedCategory} category
 * @param {string} questionText
 * @param {object} applicationAnswers - already-yaml.load()'d `application_answers` block, or {} if absent.
 * @param {{visaStatus?: string, compensation?: {target_range?: string, minimum?: string, currency?: string}}} fallback
 * @returns {{status:'answered', value: string, source:'profile'|'fallback', key: string}
 *         | {status:'needs-model-judgment', category: ProtectedCategory}}
 *   Resolution order: (1) PROTECTED_SUBKEY_TABLE match with a non-empty,
 *   non-TODO value at that path → source 'profile'. (2) ONLY for
 *   category === 'work_authorization' or 'compensation': fall back to
 *   `fallback.visaStatus` / `fallback.compensation` when present → source
 *   'fallback', logged by the caller as `answered-from-fallback` per
 *   Requirement 6. (3) Anything else (no sub-key match, and — for the other
 *   four categories — no defined fallback) → 'needs-model-judgment'. This is
 *   NOT a special "protected" abstention: it is the exact same handoff
 *   §1.3 step 4 uses for a non-protected field, just tagged with its
 *   category so the audit log records what kind of question was answered
 *   by inference.
 */
export function resolveProtectedAnswer(category, questionText, applicationAnswers, fallback) { /* ... */ }

/**
 * Conservative, deterministic, NOT an LLM call. Confirms only STRONG,
 * mechanical entailment: (a) a literal fact stated in cv.md/profile.yml
 * ("Are you based in France?" when location.country === "France"), or (b) a
 * computed fact (years of experience derived from cv.md date ranges —
 * mirrors the `{{years_experience}}` token already used by
 * config/apply-answers.yml). Anything subtler returns entailed:false, which
 * is correct: it is not this function's job to guess — that is step 4 of
 * §1.3's order, run by agy, not by this module.
 * @returns {{entailed: boolean, value: string|null, evidenceSnippet: string|null}}
 */
export function checkEntailment(questionText, sourceText) { /* ... */ }

/**
 * @param {{text: string, ref: string, role: string}} question
 * @param {{profile: object, applyAnswers: {rules: object[]}, applyEssays: {essays: object[], fallback: string, never_auto: string[]}, cvText: string, articleDigestText: string}} ctx
 * @returns {{status:'answered', value: string, source: 'profile'|'fallback'|'entailed', category: ProtectedCategory|null}
 *         | {status:'needs-model-judgment', category: ProtectedCategory|null, question: string}}
 */
export function resolveAnswer(question, ctx) {
  // 1. config/apply-answers.yml rule match (answer/choose present, role-
  //    appropriate) → status 'answered', source 'profile'. A rule the user
  //    already wrote by hand is checked FIRST, even for a question that would
  //    also classify into a protected category below — see §1.7.
  // 2. else if role indicates free text and a config/apply-essays.yml
  //    essays[] rule matches (never_auto is NOT a stop here — see §1.7 — it
  //    only means "skip THIS canned rule", so a never_auto match falls
  //    through to step 3 rather than returning anything) → status
  //    'answered', source 'profile'.
  // 3. else: category = classifyCategory(question.text); if category →
  //    resolveProtectedAnswer(...) and return its result directly (mapped
  //    into this function's return shape, category attached either way).
  // 4. else (no category, no rule match): checkEntailment(question.text,
  //    cvText + articleDigestText + profile narrative) → entailed → status
  //    'answered', source 'entailed'; not entailed → status
  //    'needs-model-judgment', category: null.
  // config/apply-essays.yml's own `fallback` string (its documented use:
  // "a required free-text question matching none of the above") is used
  // INSIDE step 2 as the last essays-rule attempt before falling through to
  // step 3/4, exactly as the file's own header already specifies.
}
```

**Acceptance assertions** (`tests/freemotion-answers.test.mjs`, three
required, each a separate `assert`):
1. **Protected, resolvable from `application_answers`:**
   `application_answers.work_authorization.requires_sponsorship_future =
   true`, question text `"Will you now or in the future require visa
   sponsorship?"` → `resolveAnswer(...)` returns `{status:'answered',
   source:'profile', category:'work_authorization', ...}` with the correct
   boolean-derived value.
2. **Protected, resolved via the Requirement-6 fallback:**
   `application_answers` present but missing the specific
   `requires_sponsorship_now` key, `fallback.visaStatus = "No sponsorship
   needed"` → `resolveAnswer(...)` on a matching question returns
   `{status:'answered', source:'fallback', category:'work_authorization',
   ...}` — never `'needs-model-judgment'` when a usable fallback exists.
3. **Correct handoff, not a fabricated guess by the deterministic layer:**
   question text `"What was the annual revenue impact of your last
   project?"`, no matching rule, `cvText` containing no revenue figure →
   `resolveAnswer(...)` returns `{status:'needs-model-judgment', ...}` —
   asserted as `result.status === 'needs-model-judgment'` and,
   separately, that `result.value` is `undefined` (this module produced no
   value at all for this field; only `agy`, one layer up, does).

### 4.4 `lib/freemotion-validate.mjs`

**The gate is completeness, not required-field non-emptiness.** The
requirements brief's failure mode is a submission that reaches an employer
"incomplete, malformed, or visibly half-filled" — and an optional field left
blank because nothing marked it `[required]` is exactly that. So this module
collects *every* visible form control, records which are required, and diffs
the live DOM against what Tier 1/2 intended to fill.

```js
/** Passed verbatim as the `function` string to browser_evaluate. Returns a
 * JSON-serializable object; agy makes that call and hands the return value
 * to evaluateValidation below. This module never calls browser_evaluate
 * itself (§1.5/§2.2). */
export const DOM_VALIDATION_SCRIPT = `() => {
  const controls = [...document.querySelectorAll(
    'input:not([type=hidden]), select, textarea, [contenteditable="true"],' +
    ' [role="checkbox"], [role="radio"], [role="combobox"], [role="listbox"]'
  )];
  const fields = controls.map((el) => ({
    name: el.getAttribute('name') || el.getAttribute('aria-label')
          || el.getAttribute('data-automation-id') || el.id || '',
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || el.getAttribute('role') || '',
    value: 'value' in el ? String(el.value ?? '') : (el.textContent || '').trim(),
    checked: 'checked' in el ? Boolean(el.checked) : undefined,
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    invalid: el.getAttribute('aria-invalid') === 'true',
    disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
    visible: !!(el.offsetParent || el.getClientRects().length),
  }));
  const alerts = [...document.querySelectorAll('[role="alert"]')]
    .filter((el) => el.offsetParent || el.getClientRects().length)
    .map((el) => (el.textContent || '').trim())
    .filter(Boolean);
  return { fields, visibleAlerts: alerts, url: location.href, title: document.title };
}`;

/**
 * @typedef {Object} Failure
 * @property {'empty-required'|'unfilled-expected'|'value-mismatch'|'unfilled-optional'
 *           |'aria-invalid'|'visible-alert'|'unexpected-navigation'} type
 * @property {string} detail
 * @property {string} name    - the field's resolved name, '' when unknown.
 * @property {boolean} blocking
 */

/**
 * The async-render guard (requirements brief, "Lessons": a page that looks
 * empty might just not have rendered yet — the exact bug Workday's
 * resume-parse carry-forward reproduces on every posting). agy captures
 * DOM_VALIDATION_SCRIPT TWICE, ~500ms apart, and passes both. Any field whose
 * value differs between captures is still settling and is reported as
 * `settling`, never as empty.
 * @param {object} captureA @param {object} captureB
 * @returns {{stable: object, settling: string[]}} `stable` has the shape of
 *   one capture, containing only fields that agreed; `settling` lists the
 *   names that did not.
 */
export function reconcileCaptures(captureA, captureB) { /* ... */ }

/**
 * @param {{before: {url:string, title:string}, after: ReturnType of reconcileCaptures().stable}} snapshot
 * @param {{expected?: {ref: string, name: string, value: string}[],
 *          attemptedRefs?: string[], expectedAdvance?: boolean}} [options]
 *   `expected` — every field Tier 1's fillPlan and Tier 2's answers intended
 *     to fill this step, with the value each was given.
 *   `attemptedRefs` — refs agy has already tried to fill on this step. Used
 *     only to demote a stubborn `unfilled-optional` (see below).
 * @returns {{valid: boolean, failures: Failure[]}}
 */
export function evaluateValidation(snapshot, options = {}) {
  // empty-required     visible && required && !disabled && empty
  //                    -> blocking
  // unfilled-expected  a name in `expected` whose DOM field is visible and
  //                    empty. The value did not stick: an async re-render
  //                    wiped it, a React controlled input rejected the
  //                    write, a dropdown closed without committing.
  //                    -> blocking. This is the most important new check —
  //                       the difference between "we filled the form" and
  //                       "the form holds what we filled".
  // value-mismatch     expected value X, DOM holds non-empty Y, and Y is not
  //                    X under trim/case/whitespace-collapse normalization.
  //                    Catches a value landing in the wrong box and a
  //                    dropdown committing a neighbouring option.
  //                    -> blocking
  // unfilled-optional  visible, !required, !disabled, empty, and NOT in
  //                    `expected` — nobody planned to fill it. Per
  //                    Requirement 5 the run answers it rather than leaving
  //                    it blank: agy routes it back through step 5 like any
  //                    other unanswered field.
  //                    -> blocking on first sight; demoted to
  //                       blocking:false once its ref appears in
  //                       `attemptedRefs`, so a genuinely inert or
  //                       conditionally-inapplicable field cannot deadlock
  //                       the posting. Every demotion is logged (§4.8).
  // aria-invalid       one Failure per field with invalid === true -> blocking
  // visible-alert      one Failure per non-empty visibleAlerts entry -> blocking
  // unexpected-navigation
  //                    !expectedAdvance && before.url !== after.url
  //                    -> blocking, detail = `${before.url} -> ${after.url}`
  // valid = failures.every((f) => !f.blocking)
}
```

**Acceptance assertions** (`tests/freemotion-validate.test.mjs`, five cases):

```js
const base = { before: { url: 'https://x.com/apply', title: 'Apply' } };
const after = (fields, extra = {}) => ({
  ...base,
  after: { fields, visibleAlerts: [], url: 'https://x.com/apply', title: 'Apply', ...extra },
});

// 1. empty required field
let r = evaluateValidation(after([
  { name: 'email', tag: 'input', value: '', required: true, visible: true, disabled: false },
]));
assert(r.valid === false);
assert(r.failures.some((f) => f.type === 'empty-required' && f.name === 'email'));

// 2. a value we filled did not stick
r = evaluateValidation(
  after([{ name: 'phone', tag: 'input', value: '', required: false, visible: true, disabled: false }]),
  { expected: [{ ref: 'e9', name: 'phone', value: '+33600000000' }] },
);
assert(r.failures.some((f) => f.type === 'unfilled-expected' && f.name === 'phone'));

// 3. a value landed, but not the one we sent
r = evaluateValidation(
  after([{ name: 'country', tag: 'select', value: 'Francia', required: false, visible: true, disabled: false }]),
  { expected: [{ ref: 'e4', name: 'country', value: 'France' }] },
);
assert(r.failures.some((f) => f.type === 'value-mismatch' && f.name === 'country'));

// 4. optional field nobody planned: blocking first, non-blocking once attempted
const optional = after([
  { name: 'cover_letter', tag: 'textarea', value: '', required: false, visible: true, disabled: false, ref: 'e7' },
]);
assert(evaluateValidation(optional).valid === false);
assert(evaluateValidation(optional, { attemptedRefs: ['e7'] }).valid === true);

// 5. fully filled, no drift -> clean pass
r = evaluateValidation(
  after([{ name: 'email', tag: 'input', value: 'jane@example.com', required: true, visible: true, disabled: false }]),
  { expected: [{ ref: 'e1', name: 'email', value: 'jane@example.com' }] },
);
assert(r.valid === true && r.failures.length === 0);
```

Plus one `reconcileCaptures` assertion: two captures whose `work_history_0`
value differs → that name appears in `settling` and is absent from
`stable.fields`, so it can never be reported as `empty-required`.

### 4.5 `lib/freemotion-submissions.mjs`

Reuses `normalizeUrl` from `url-key.mjs` and `withPipelineLock` from
`pipeline-lock.mjs` directly — no new lock protocol is written (per the task
instruction to reuse, not invent). `withPipelineLock(path, fn)` already
accepts *any* path (`lockDirFor(path) = \`${path}.lock\``), so it needs no
adaptation for a new file.

**On-disk format** — `data/freemotion-submissions.tsv`, append-only, one
header row plus one row per event (a claim AND its later resolution are two
separate rows, sharing `url_key`; readers take the **last row per
`url_key`** as current state, the same "ledger, not a table" contract as
`data/status-log.tsv`):

```
url_key\traw_url\tcompany\trole\treport_num\toutcome\ttimestamp\trun_id\tnotes
```

`outcome` ∈ `{in-progress, submitted, validation-failed, captcha,
blocked-waf, account-verification-pending, errored}`. `report_num` is an
integer or the literal `-` when unknown (ad-hoc `--url` runs, §4.9).
`url_key` is `normalizeUrl(raw_url)`; a row is never written for an
unkeyable URL (`normalizeUrl` returns `''`) — that case is refused by
`claimSubmission` before any write, described below.

```js
export const SUBMISSIONS_LOG_RELATIVE_PATH = 'data/freemotion-submissions.tsv';
export const VALID_OUTCOMES = ['in-progress', 'submitted', 'validation-failed', 'captcha', 'blocked-waf', 'account-verification-pending', 'errored'];
export const IN_PROGRESS_STALE_MS = 30 * 60_000; // 30 minutes

/** @typedef {Object} SubmissionRow
 * @property {string} urlKey @property {string} rawUrl @property {string} company
 * @property {string} role @property {number|null} reportNum
 * @property {string} outcome @property {string} timestamp @property {string} runId @property {string} notes */

/**
 * Read the log (best-effort: a missing file is an empty list, never an
 * error) and fold it to one current SubmissionRow per url_key (last row
 * wins). Unlocked read — matches merge-tracker.mjs's own read-then-locked-
 * write pattern; the authoritative race-closing happens in claimSubmission.
 * @param {{logPath?: string}} [options]
 * @returns {Map<string, SubmissionRow>} keyed by url_key
 */
export function readCurrentState({ logPath } = {}) { /* ... */ }

/**
 * The single entry point that must run BEFORE any browser interaction with
 * a posting (Requirement 8's actual gate — not the post-hoc `finalize`
 * below, which only records history). Locked critical section via
 * withPipelineLock(logPath, ...): reads current state, decides, and — only
 * on a genuine claim — appends the 'in-progress' row, all inside one lock
 * acquisition, closing the two-workers-race-the-same-URL window Requirement
 * 8 exists to prevent.
 * @param {string} url - raw posting URL.
 * @param {{runId: string, company: string, role: string, reportNum: number|null, logPath?: string}} meta
 * @returns {Promise<{claimed: true} | {claimed: false, reason: 'already-submitted'|'in-progress'|'unkeyable', priorRow?: SubmissionRow}>}
 */
export async function claimSubmission(url, meta) { /* ... */ }

/**
 * Appends the final outcome row for a URL this run already claimed. Locked
 * the same way. Does NOT re-check dedup (that already happened in
 * claimSubmission) — this only records history, so it always writes.
 * @param {string} url @param {'submitted'|'validation-failed'|'captcha'|'blocked-waf'|'account-verification-pending'|'errored'} outcome
 * @param {{runId: string, reportNum: number|null, notes: string, logPath?: string}} meta
 * @returns {Promise<void>}
 */
export async function finalizeSubmission(url, outcome, meta) { /* ... */ }
```

CLI: `node lib/freemotion-submissions.mjs claim --url <u> --run-id <id>
--company <c> --role <r> [--report N]` (prints the claim result JSON, exit 0
on `claimed:true`, exit 3 on `claimed:false`) and `node
lib/freemotion-submissions.mjs finalize --url <u> --outcome <o> --run-id <id>
[--report N] [--notes "..."]`.

**Acceptance assertion** (`tests/freemotion-submissions.test.mjs`, against a
temp-dir log path so the real `data/` is never touched):
```js
const logPath = join(tmpDir, 'submissions.tsv');
const a = await claimSubmission('https://x.com/jobs/1', { runId: 'r1', company: 'X', role: 'Eng', reportNum: 1, logPath });
assert(a.claimed === true);
const b = await claimSubmission('https://x.com/jobs/1', { runId: 'r2', company: 'X', role: 'Eng', reportNum: 1, logPath });
assert(b.claimed === false && b.reason === 'in-progress');
await finalizeSubmission('https://x.com/jobs/1', 'submitted', { runId: 'r1', reportNum: 1, notes: 'ok', logPath });
const c = await claimSubmission('https://x.com/jobs/1', { runId: 'r3', company: 'X', role: 'Eng', reportNum: 1, logPath });
assert(c.claimed === false && c.reason === 'already-submitted');
```

### 4.6 `lib/freemotion-credentials.mjs`

Implements Requirement 2's account-creation half (§1.2) — one of the four
areas the brief weights most heavily.

```js
import { createHash, randomBytes } from 'crypto';

/** @param {string} domain - hostname only, e.g. "boards.greenhouse.io". */
export function credentialsPath(domain, { root } = {}) {
  const hash = createHash('sha256').update(domain.toLowerCase()).digest('hex').slice(0, 16);
  return join(root ?? process.cwd(), 'data', 'freemotion-credentials', `${hash}.json`);
}

/** @returns {{domain: string, email: string, password: string, createdAt: string} | null} null if never created for this domain. */
export function loadCredentials(domain, { root } = {}) { /* readFileSync + JSON.parse; ENOENT -> null; any other error rethrows */ }

/** Atomic write (writeFileAtomic from tracker-utils.mjs), creates data/freemotion-credentials/ if absent (mkdirSync recursive:true). Overwrites any prior file for the same domain. */
export function saveCredentials(domain, { email, password }, { root } = {}) { /* ... */ }

/** Cryptographically random, guarantees at least one lower/upper/digit/symbol
 * so it passes typical password-policy validators without retry.
 * @param {{length?: number}} [options] default length 20.
 * @returns {string} */
export function generatePassword({ length = 20 } = {}) { /* ... */ }
```

`data/freemotion-credentials/*.json` is under the `data/` prefix, already
gitignored and covered by `USER_PATHS`. The registration email is always
`config/profile.yml → candidate.email` (the candidate's real inbox — never a
throwaway address, because a verification link has to be readable by a human
per §1.2's descope).

**Account-creation flow** (driven by `agy`, no new library function needed
beyond the two above): on detecting a login/register wall (a snapshot
containing "Sign Up"/"Create Account"/"Register" and no visible job-form),
`agy` calls `loadCredentials(domain)`; if `null`, generates one with
`generatePassword()` and immediately `saveCredentials(domain, {email,
password})` BEFORE submitting the registration form (credentials must be
durable even if the registration submit itself then fails). The registration
form itself is filled and validated through the exact same Tier 1 → Tier 2 →
Tier 3 loop as any other form — a registration form is not a special case
structurally, only in what triggers it.

**Acceptance assertion** (`tests/freemotion-credentials.test.mjs`): `save`
then `load` round-trips exactly; `load` for a domain never saved returns
`null`; `generatePassword()` called 100 times never repeats and every result
matches `/[a-z]/ && /[A-Z]/ && /\d/ && /[^A-Za-z0-9]/`.

### 4.7 `lib/freemotion-engine-config.mjs`

Implements §1.6 — the other of the four areas the brief weights most
heavily.

```js
export const DEFAULT_ENGINE_CONFIG = { name: 'playwright-default', browser: 'chromium', executablePath: null, headless: true };
export const VALID_BROWSERS = ['chromium', 'firefox', 'webkit'];

/**
 * Reads `config/profile.yml -> freemotion.browser_engine`, applies defaults
 * for any missing key, THROWS FreemotionEngineConfigError if `browser` is
 * present but not in VALID_BROWSERS (fail fast rather than silently
 * launching the default engine when the user typo'd their swap).
 * @param {string} profilePath
 * @returns {{name: string, browser: string, executablePath: string|null, headless: boolean}}
 */
export function readEngineConfig(profilePath) { /* ... */ }

/**
 * @param {ReturnType<typeof readEngineConfig>} engineConfig
 * @returns {string[]} args appended after the fixed `-y @playwright/mcp@latest` prefix.
 *   e.g. firefox + executablePath set → ['--browser','firefox','--executable-path','/opt/camoufox/camoufox','--headless']
 */
export function buildPlaywrightMcpArgs(engineConfig) { /* ... */ }

/**
 * Read-modify-write .mcp.json (starting from config/mcp.example.json if the
 * target file does not exist yet), preserving every key this function does
 * not own (only mcpServers.playwright.args is replaced; mcpServers.playwright.command
 * and any OTHER server entries are left untouched). Atomic write via
 * writeFileAtomic from tracker-utils.mjs.
 * @param {{profilePath?: string, mcpConfigPath?: string, templatePath?: string}} [options]
 * @returns {{written: boolean, path: string, args: string[]}}
 */
export function syncMcpConfig({ profilePath = 'config/profile.yml', mcpConfigPath = '.mcp.json', templatePath = 'config/mcp.example.json' } = {}) { /* ... */ }
```

`config/profile.example.yml` documents the new block (added in §6 Phase 2,
not by this module):
```yaml
freemotion:
  browser_engine:
    name: playwright-default   # or "camoufox" — a label only, informational
    browser: chromium          # chromium | firefox | webkit — camoufox is a firefox build
    executable_path: ""        # empty = engine default binary; set to swap engines
    headless: true
```

This is the entire non-coder swap: change `browser: chromium` to `browser:
firefox`, put the Camoufox binary path in `executable_path`, run `node
lib/freemotion-engine-config.mjs --apply`. Nothing else in the system
references the engine choice — every other module in this plan is
browser-agnostic by construction (§1.5).

CLI: `node lib/freemotion-engine-config.mjs --apply [--profile path]
[--mcp-config path]` (writes, prints the result JSON) and `--show` (computes
and prints without writing — safe to run to preview a swap before applying).

**Acceptance assertion** (`tests/freemotion-engine-config.test.mjs`): a
fixture profile YAML string with
`freemotion.browser_engine.browser: firefox` and
`.executable_path: /opt/camoufox/camoufox` →
`buildPlaywrightMcpArgs(readEngineConfig(...))` returns an array containing,
in order, `'--browser'`, `'firefox'`, `'--executable-path'`,
`'/opt/camoufox/camoufox'`. A fixture with `browser: netscape` →
`readEngineConfig` throws `FreemotionEngineConfigError`.

### 4.8 `lib/freemotion-log.mjs`

The audit trail — a normal non-functional requirement, sized proportionately:
one append-only file per run, no query layer, no index, no separate review
tooling. Every filled field (Tier 1 or Tier 2) and every outcome event gets
one line.

```js
/** @returns {string} data/freemotion-runs/{runId}.jsonl, resolved under root. */
export function runLogPath(runId, { root } = {}) { /* ... */ }

/** @typedef {Object} LogEntry
 * @property {string} ts - ISO timestamp.
 * @property {string} event - 'answer' | 'submitted' | 'outcome' | free-form.
 * @property {string} [ref] @property {string} [question] @property {string} [value]
 * @property {'profile'|'fallback'|'entailed'|'inferred'} [source]
 * @property {string} [reasoning] - required when source === 'inferred'; agy's
 *   own one-line explanation of why this was the most probable answer.
 * @property {string} [url] @property {string} [detail] */

/** Appends one JSON line. Creates data/freemotion-runs/ (mkdirSync recursive)
 * if absent. NOT locked — single-writer-per-runId is an explicit assumption
 * (one agy process owns one runId; concurrent runs use distinct runIds, so
 * there is no cross-run contention to guard against). */
export function appendLogEntry(runId, entry, { root } = {}) { /* ... */ }

/** Reads and JSON.parses every line; a malformed line (a crashed process's
 * torn last write) is collected into the returned `warnings` array instead
 * of throwing — a post-hoc audit read must survive a crash mid-run.
 * @returns {{entries: LogEntry[], warnings: string[]}}
 */
export function readRunLog(runId, { root } = {}) { /* ... */ }
```

CLI: `node lib/freemotion-log.mjs append --run-id ID --event answer --ref
e42 --question "..." --value "..." --source inferred --reasoning "..." --url
<u>` — the one call `agy` makes after filling any field. Every field, on
every source path, is logged the same way: this is what makes the log the
record of "what was said on the candidate's behalf," per the brief's own
framing, without adding anything beyond an append per field.

**Acceptance assertion** (`tests/freemotion-log.test.mjs`): `appendLogEntry`
called twice with a temp `root` then `readRunLog` returns
`{entries: [...2 objects in order...], warnings: []}`; a log file with one
corrupted trailing line still returns the 2 good entries plus one warning,
never throws.

### 4.9 `freemotion-run.mjs` (root)

```
Usage:
  node freemotion-run.mjs --report N [--run-id ID]
  node freemotion-run.mjs --url <url> --company <c> --role <r> [--run-id ID]
  node freemotion-run.mjs --next [--min-score X] [--run-id ID]
```

```js
/**
 * @param {{report?: number, url?: string, company?: string, role?: string, next?: boolean, minScore?: number, runId?: string, root?: string}} args
 * @returns {Promise<
 *   { ok: true, workOrder: { runId: string, url: string, company: string, role: string,
 *       reportNum: number|null, reportPath: string|null, pdfPath: string|null,
 *       draftAnswers: object|null, engineConfig: object } }
 *   | { ok: false, reason: 'blacklisted'|'already-submitted'|'in-progress'|'unkeyable'|'no-eligible-row'|'not-found', detail?: string }
 * >}
 */
export async function resolveWorkOrder(args) {
  // 1. runId = args.runId || `fm-${Date.now()}-${randomUUID().slice(0,8)}`
  // 2. Resolve {url, company, role, reportNum, reportPath} by mode:
  //    --report N: read data/applications.md via tracker-utils.mjs's row
  //      reader, find the row whose Report cell links #N; url/company/role
  //      from the row; reportPath = `reports/${N}-*.md` resolved the same
  //      way jd-capture.mjs resolves padded/unpadded report prefixes.
  //    --url: url/company/role taken directly from args; reportNum = null;
  //      reportPath = null.
  //    --next: read every tracker row with status 'Evaluated' (see
  //      templates/states.yml canonical labels), PDF column '✅', a
  //      resolvable URL, score >= (args.minScore ?? 0); sort by score desc;
  //      for each candidate IN ORDER, call claimSubmission — the first one
  //      that returns claimed:true is the work order; if all candidates are
  //      already claimed/submitted/blacklisted, return
  //      {ok:false, reason:'no-eligible-row'}.
  // 3. Blacklist check (mirrors modes/apply.md's own Step 5 gate): if
  //    data/blacklist.md exists and `company` matches an entry
  //    (case/punctuation-insensitive), return
  //    {ok:false, reason:'blacklisted', detail: <blacklist reason text>}
  //    WITHOUT calling claimSubmission (never claim a URL this run refuses
  //    to attempt).
  // 4. (--report / --url modes only; --next already claimed inside its own
  //    loop in step 2) claimSubmission(url, {runId, company, role, reportNum}).
  //    Not claimed -> {ok:false, reason: <claim's reason>}.
  // 5. pdfPath: read from the tracker row's PDF column / output/ convention
  //    when a report exists; null for ad-hoc --url runs.
  // 6. draftAnswers: when reportPath is non-null, shell out to
  //    `node application-answers.mjs --report <reportPath> --read-draft`
  //    and JSON.parse its stdout; null on any failure (never fatal — draft
  //    answers are an optimization, not a requirement).
  // 7. engineConfig: readEngineConfig('config/profile.yml') from
  //    lib/freemotion-engine-config.mjs (DEFAULT_ENGINE_CONFIG if the block
  //    is absent — readEngineConfig already defaults missing keys).
  // 8. Return {ok:true, workOrder: {...}}.
}
```

CLI prints the return value as JSON on stdout. Exit codes: `0` for `ok:true`;
`2` for `ok:false` with `reason` in `{'already-submitted','in-progress',
'unkeyable','no-eligible-row'}` (expected, non-error outcomes agy should
just move to the next posting on); `1` for `reason:'not-found'` (a `--report
N` naming a row that does not exist — a real usage error) and for any
unexpected exception.

**Acceptance assertion** (`tests/freemotion-run.test.mjs`, against fixture
`data/applications.md` and `data/freemotion-submissions.tsv` under a temp
root): `--report 1` on a row not yet claimed/submitted → `ok:true`, exit 0,
`workOrder.url` matches the fixture row's URL. Immediately calling
`resolveWorkOrder` again with the same `--report 1` (same temp root, so the
same submissions log) → `ok:false, reason:'in-progress'`, exit 2.

---

## 5. Rewritten `modes/apply-freemotion.md`

Replace the entire current file (which references the deleted
`lib/tier0-navigate.mjs` / `lib/tier1-autofill.mjs` / `lib/tier2-execute.mjs`
/ `lib/tier3-validate.mjs`) with the following:

```markdown
# Mode: apply-freemotion — Free Motion Autonomous Applier

> Apply `voice-dna.md` (if present) to free-text answers via
> config/apply-essays.yml's tone rules — see `_writing.md` -> Voice DNA.

You are the Tier 2/3 orchestrator for Free Motion. You hold the ONLY
Playwright MCP session in this system — no script in this repo launches its
own browser. Every `lib/freemotion-*.mjs` script is a pure data transform:
you pipe it JSON, it prints JSON, you act on what it says using your own
MCP tool calls (`browser_navigate`, `browser_snapshot`, `browser_fill_form`,
`browser_click`, `browser_type`, `browser_select_option`, `browser_evaluate`,
`browser_file_upload`, `browser_take_screenshot`).

**This mode never pauses to ask the user, and never leaves ANY field blank —
required or not.** A form is not "done" when its asterisked fields are full;
it is done when a human looking at it would call it a complete application. Every question gets an answer, in the same turn it is found — from
`config/profile.yml` / `cv.md` / `config/apply-answers.yml` /
`config/apply-essays.yml` where one exists, from `application_answers` (or
its `location.visa_status`/`compensation` fallback) for the legally-sensitive
categories, and from your own best judgement — the most probable answer for
this candidate — for anything else. The one thing you always do regardless
of which of those it was: log it (see step 4 below).

## Per-run setup (once)

1. `node lib/freemotion-engine-config.mjs --show` — confirm which browser
   engine is configured (`config/profile.yml -> freemotion.browser_engine`).
   If it does not match what you expect, stop and tell the user; do not
   silently proceed on a mismatched engine.
2. Pick a `runId` for this whole session (e.g. `fm-<date>-<short-id>`) and
   reuse it for every posting you process in this run.

## Per posting

1. **Get a work order.**
   `node freemotion-run.mjs --report <N> --run-id <runId>` (or `--next
   --run-id <runId>` to pull the highest-scored eligible row, or `--url
   <u> --company <c> --role <r> --run-id <runId>` for an ad-hoc target).
   - Exit 2 with `reason` in `already-submitted` / `in-progress` /
     `blacklisted` / `no-eligible-row`: this posting is not for you right
     now. Move to the next one silently (no need to report each skip to the
     user unless the whole run finds nothing).
   - Exit 1: a real usage error. Stop and report it.
   - Exit 0: you have a `workOrder` JSON. Proceed.

2. **Tier 0 — reach the form.**
   `browser_navigate(workOrder.url)`, then `browser_snapshot()`. Record the
   resulting `{url, title}` as `before` for step 5's validation call. If the
   page shows an account wall (Sign In / Create Account / Register with no
   visible job-application form), go to **Account creation** below before
   continuing.

3. **Tier 1 — deterministic fill.**
   Pipe the snapshot text to
   `node lib/freemotion-tier1.mjs --snapshot - --profile config/profile.yml
   --apply-answers config/apply-answers.yml --cv cv.md` (add
   `--pdf-path <workOrder.pdfPath>` when non-null, for the resume-upload
   action). Execute every action in `fillPlan` via the matching MCP tool
   (`browser_fill_form` for a batch of text/select fields, `browser_click`
   for checkbox/radio, `browser_file_upload` for the resume action), then
   log each one (step 4's logging call, `source: 'profile'`).

4. **Tier 2 — every remaining field, always answered.**
   For each field in `remaining` (Tier 1's leftover list), run
   `node lib/freemotion-answers.mjs --question "<accessible name / nearby
   label text>" --ref <ref> --role <role> --profile config/profile.yml
   --apply-answers config/apply-answers.yml --apply-essays
   config/apply-essays.yml --cv cv.md --article-digest article-digest.md`.
   - `status: 'answered'` → fill it via the matching MCP tool call, using
     `value`. Log it: `node lib/freemotion-log.mjs append --run-id <runId>
     --event answer --ref <ref> --question "<text>" --value "<value>"
     --source <source> --url <workOrder.url>`.
   - `status: 'needs-model-judgment'` → decide the most probable answer for
     this candidate yourself, right now, grounded in whatever cv.md /
     profile.yml / article-digest.md context is closest to the question —
     fill it, then log it the same way with `--source inferred --reasoning
     "<one line: why this was the most probable answer, and what it drew
     on>"`. Never leave the field empty, never stop this posting to ask the
     user.
   - A CAPTCHA challenge anywhere in this step: see **CAPTCHA policy** below
     — stop this posting immediately, do not attempt to solve it.
   - A non-standard widget you can operate directly (a date picker, a
     multi-select chip input) — operate it with your own judgement using the
     answer `value` as the target; this is exactly the "genuinely
     form-specific remainder" the architecture exists to hand you.

5. **Tier 3 — TWO gates before EVERY step advance.** Both must pass before
   any Next or Submit. Neither alone is enough (§1.4): the DOM cannot see
   what a form looks like, and a screenshot cannot see what a form holds.

   **5a — DOM gate.** Run `browser_evaluate` with the exact function body in
   `lib/freemotion-validate.mjs`'s exported `DOM_VALIDATION_SCRIPT` constant
   — copy it verbatim, do not paraphrase it. Run it **twice, ~500ms apart**
   (`browser_wait_for` between) and pass both captures: a field that differs
   between them is still rendering, not empty. This is the carry-forward
   trap — Workday pre-fills work history asynchronously after the CV upload,
   and a check that fires too early reads it as blank and writes a duplicate
   on top.

   Pipe `{before, captureA, captureB}` (using the `before` you captured in
   step 2, or the previous step's `after` as this step's `before`), plus the
   full list of what you intended to fill this step, to
   `node lib/freemotion-validate.mjs --dom-json - --expected <expected.json>
   --attempted <refs>`. `expected` is Tier 1's `fillPlan` **plus** every
   field you answered in step 4, each with the value you sent — that is what
   turns this from "the required fields are non-empty" into "the application
   is complete and holds what we actually typed."

   **5b — Vision gate.** Take a screenshot of the **form container element**
   (`browser_take_screenshot` against the element ref — the nearest common
   ancestor of this step's fields), never the bare viewport: an element
   capture includes content scrolled out of view inside a scrollable
   container, which is what defeated earlier attempts. If the container is
   too tall for one image, scroll it in viewport-height steps and take
   several. Then read them yourself and answer one question: *would a human
   call this a complete, correctly-filled application?* Look for what the
   DOM cannot report — the wrong dropdown option visibly selected, a value
   truncated or overflowing, text sitting in the field next to the intended
   one, a field flagged red by a validator that never set `aria-invalid`, a
   section that did not render at all.

   - **Both gates pass** → click Next/Submit. If more form steps remain,
     treat the new page as this step's `before` and loop to step 3. If this
     was the final Submit, go to step 6.
   - **Either gate fails** → go back to step 4 for each named field.
     `empty-required` / `unfilled-expected` / `value-mismatch` /
     `aria-invalid` name the field directly; `unfilled-optional` is a field
     nobody planned to fill — answer it like any other question rather than
     leaving it blank, and if it still will not take a value after one real
     attempt, pass its ref in `--attempted` so an inert field cannot
     deadlock the posting. `unexpected-navigation` means something in step
     3/4 already advanced the page — re-snapshot and re-run step 3 from
     scratch. Never click Next/Submit while `valid` is false.

6. **Final review page — extra scrutiny.** If the page immediately before
   the real final Submit is a review/summary showing every entered value,
   run step 5b once more against it. This is the only point where the whole
   application is visible in one place, so it is the last chance to catch a
   cross-field problem no single step could show — a name and email that
   belong to different people, a work-history block that silently lost a
   row, an answer that contradicts another. If anything looks wrong, go back
   to step 4 for that field before submitting.

7. **Record the outcome.**
   - Success: `node lib/freemotion-submissions.mjs finalize --url
     <workOrder.url> --outcome submitted --run-id <runId> --report
     <workOrder.reportNum|-> --notes "<one line>"`, then, only when
     `workOrder.reportNum` is not null:
     `node set-status.mjs <reportNum> Applied --note "Free Motion:
     submitted <timestamp>"` and `node followup-seed.mjs <reportNum>
     --json`.
   - Any failure branch (CAPTCHA, WAF block, account-verification pending,
     a Tier-3 failure that does not clear after 3 retries, an unhandled
     error): `node lib/freemotion-submissions.mjs finalize --url
     <workOrder.url> --outcome <matching outcome> --run-id <runId> --report
     <workOrder.reportNum|-> --notes "<what happened>"`. Do not call
     `set-status.mjs`/`followup-seed.mjs` on a non-`submitted` outcome.
   - Continue to the next posting either way.

## Account creation

Triggered when step 2 finds an account wall. Fill it using
`config/profile.yml -> candidate.email` (the real inbox — never a
throwaway address). Check for an existing password first:
`node lib/freemotion-credentials.mjs load --domain <hostname>`; if none,
`node lib/freemotion-credentials.mjs generate --domain <hostname>` (generates
and saves a new one). Submit the registration form via the normal Tier
1/2/3 loop above (a registration form is just another form).

If, after registering, the site requires clicking an emailed verification
link before the application form is reachable: this is out of scope for
this build (career-ops has no inbox access). Finalize this posting with
outcome `account-verification-pending` and a note that credentials were
saved to `data/freemotion-credentials/`. Move on.

## CAPTCHA policy (unchanged from AGENTS.md's existing "Ethical Use" section)

- **Proactive skip:** before starting a run, skip URLs on ATS platforms
  known to trigger CAPTCHAs heavily (e.g. Lever) unless explicitly told
  otherwise.
- **Reactive skip:** a CAPTCHA appearing unexpectedly aborts THIS posting
  immediately (`finalize --outcome captcha`) and adds the domain to your
  in-run skip list — do not attempt any other posting on that same ATS
  domain for the rest of this run.
- Log the URL to `output/captcha_links.txt` (append, one URL per line) in
  addition to the submissions ledger, matching the existing convention.

## Never

- Never leave a field `lib/freemotion-answers.mjs` marked
  `status: 'needs-model-judgment'` blank — always decide and fill it, and
  always log the decision.
- Never click Submit (or a step's Next) on the DOM gate alone. Both 5a
  (`valid: true` from `lib/freemotion-validate.mjs`) and 5b (your own read of
  the form-container screenshot) must pass immediately before that specific
  click.
- Never trust a single DOM capture that reports a field empty — take two,
  ~500ms apart, and treat any disagreement as "still rendering".
- Never solve a CAPTCHA.
- Never launch your own browser — the Playwright MCP session is the only one.
- Never pause the run to ask the user mid-posting.
```

---

## 6. Build order

Each phase ends in a command that can actually be run and that either passes
or fails cleanly — no phase depends on live network access or a real MCP
session except Phase 8's manual smoke test.

**Phase 1 — Foundations (no dependencies on anything else in this plan).**
Create `lib/freemotion-snapshot.mjs`, `lib/freemotion-submissions.mjs`,
`lib/freemotion-log.mjs`, `lib/freemotion-credentials.mjs`, plus their four
test files. Add all four `lib/` paths (and nothing else yet) to
`update-system.mjs`'s `SYSTEM_PATHS` array.
*Check:* `node test-all.mjs --only freemotion-snapshot` and the three
sibling `--only` runs each report all-pass; `node
validate-system-paths-coverage.mjs` exits 0.

**Phase 2 — Answer sourcing.** Create `lib/freemotion-answers.mjs` and its
test. Edit `config/profile.example.yml` to add the `freemotion:
browser_engine:` block from §4.7 and a documented, empty-by-default
`application_answers:` block (mirroring the shape already live in the real
`config/profile.yml`, so a fresh user sees the six categories to fill in).
Edit `update-system.mjs`: add `lib/freemotion-answers.mjs` to
`SYSTEM_PATHS`; add `config/apply-answers.yml` and `config/apply-essays.yml`
to `USER_PATHS` (documentation parity per §1.7 — harmless no-op today since
both are already gitignored and untracked). Edit `AGENTS.md`'s Data Contract
list (User Layer) to name both files alongside `article-digest.md`.
*Check:* `node test-all.mjs --only freemotion-answers` passes; the three
acceptance assertions in §4.3 are present and green individually.

**Phase 3 — Tier 1.** Create `lib/freemotion-tier1.mjs` and its test
(depends on Phase 1's snapshot parser and Phase 2's answer-adjacent
`config/apply-answers.yml` loading). Register in `SYSTEM_PATHS`.
*Check:* `node test-all.mjs --only freemotion-tier1` passes.

**Phase 4 — Tier 3.** Create `lib/freemotion-validate.mjs` and its test
(no dependency on Phases 1-3). Register in `SYSTEM_PATHS`.
*Check:* `node test-all.mjs --only freemotion-validate` passes.

**Phase 5 — Engine seam.** Create `lib/freemotion-engine-config.mjs`,
`config/mcp.example.json`, and the engine-config test. Register both new
files in `SYSTEM_PATHS`.
*Check:* `node test-all.mjs --only freemotion-engine-config` passes;
`node lib/freemotion-engine-config.mjs --show` runs cleanly against the
repo's real `config/profile.yml` even before the user has added a
`freemotion:` block (defaults apply).

**Phase 6 — Run driver.** Create `freemotion-run.mjs` and its test (depends
on Phases 1 and 5). Register in `SYSTEM_PATHS`.
*Check:* `node test-all.mjs --only freemotion-run` passes.

**Phase 7 — Mode + registration fixes.** Overwrite `modes/apply-freemotion.md`
with §5's content. Fix the §1.9 gap: add both `modes/apply-freemotion.md`
and `modes/auto-apply.md` to `SYSTEM_PATHS`.
*Check:* `node validate-system-paths-coverage.mjs` exits 0; `node
test-all.mjs` (full suite, no `--only`) passes at the previous 7313-plus-new
count with zero regressions.

**Phase 8 — Live smoke test: Workday first** (not part of `node test-all.mjs`;
requires a live Playwright MCP session and `agy`). **Workday is the first real
target, not deferred work.** It is the tenant family already in hand from
AirBusAutoApplier, and one Workday posting exercises the hardest generic path
in the whole design at once:

- a **multi-step wizard**, so the per-step Tier 3 gate is tested at every
  boundary rather than once at the end;
- **resume-parse carry-forward**, which asynchronously pre-fills work history
  after the CV upload — precisely the "a page that looks empty might just not
  have rendered yet" bug named in the requirements brief's Lessons, and where
  §4.4's two-capture `reconcileCaptures` rule earns its place;
- **validation errors that render only after a Next click**, testing the
  `unexpected-navigation` and `visible-alert` paths;
- **generated / unstable attribute names**, testing that the snapshot parser
  and DOM_VALIDATION_SCRIPT's `data-automation-id` fallback hold up with no
  vendor-specific selectors — the whole premise of Requirement 1.

Run it against a Workday tenant already known from the previous applier.
Confirm: Tier 1 fills identity fields with zero model reasoning visible in the
transcript; at least one Tier 2 field reaches `needs-model-judgment` and is
answered and logged with a reasoning string; the vision gate (§1.4) catches at
least one thing the DOM gate did not; Tier 3 blocks at least one premature
advance (intentionally leave a field empty once to prove the gate fires); and
`data/freemotion-submissions.tsv` / `data/freemotion-runs/*.jsonl` /
`data/applications.md` end up consistent with what actually happened.

A simple Greenhouse posting is a useful warm-up before this, but it is not the
acceptance target — Greenhouse passing proves very little that Workday passing
does not.

**Phase 9 — Automatic email verification. BUILT.** The descope named in §1.2
is closed: `lib/freemotion-inbox.mjs` reads the verification mail arriving at
`config/profile.yml → candidate.email`, extracts the confirmation link, and
hands the orchestrator one link to navigate to — turning
`account-verification-pending` from a terminal outcome into a resumable one
(`node lib/freemotion-inbox.mjs pending` is the resume list, wired into the
mode's per-run setup).

Two sources, one decision path: Gmail over the API using the same three
`GMAIL_*` environment variables the bundled gmail plugin documents, or
`--from-file` for a pasted email when no OAuth is set up. Both normalize to
one record shape and go through the identical classifier, so the offline path
carries the same guard rails and the whole test suite runs without a network.

**The security design is the point of this module, and it is not negotiable
by config.** Everywhere else in career-ops an untrusted string is read for
*content*; an email would be read here for an *action* — navigate to this
address — and an inbox is the only input channel a stranger can write to
unprompted. Three rules, in the file header and each covered by tests:
recency plus addressee (only mail inside the window, addressed to the
candidate); same-site or nothing automatically (a link is auto-clickable only
when its registrable site equals the site the account was created on —
generic, with no ATS name anywhere in the file, per Requirement 1); and
nothing in the email chooses (ranking runs against a fixed token list over
URLs, so persuasive anchor text can reorder same-site candidates but can
never promote a cross-site one). A cross-site link is reported with its host
spelled out and left for the user; `--trust-cross-site` /
`freemotion.email_verification.trust_cross_site` is the user's opt-in after
looking at it, and the mode is told never to pass it on its own initiative.

Registered in `SYSTEM_PATHS`; documented in `config/profile.example.yml`.
*Check:* `node test-all.mjs --only freemotion-inbox` passes (90 assertions).

**Phase 10 — resume a real verification wall end-to-end** (not part of `node
test-all.mjs`; needs a live session and a site that actually gates its form
behind registration). The unit tests prove the classifier; what they cannot
prove is that a real ATS's confirmation mail lands inside the window, is
addressed to the candidate rather than a list address, and puts its link on
the domain the account was created on. Run it against one registration-walled
posting and confirm: `pending` lists the parked row, `check` returns `ready`,
the navigate lands on a logged-in application form, and the row finalizes
`submitted` rather than being parked a second time. A `cross-site-only`
result here is a finding about that ATS, not a bug — record the host.


**Phase 11 — cross-ATS hardening. BUILT (2026-09-06/07).** Phase 8 proved the
loop against one tenant. This phase ran the loop as a no-submit dry run across
six structurally different ATS families — a career site proxying Workday, Ashby,
Greenhouse (both native and iframe-embedded), Workable, SmartRecruiters and
Lever — filling every field including optional ones, screenshotting the finished
form, and never submitting. Every defect it surfaced was fixed generically, with
no vendor branch anywhere.

The headline finding: **`freemotion-snapshot.mjs` and `DOM_VALIDATION_SCRIPT`
between them never answer "what is this field asking me?"** A field's name is a
UUID on one ATS and a dotted path on another; a radio group's options are all
labelled "Yes". That gap is now `lib/freemotion-inventory.mjs` — one
`browser_evaluate` returning every control with its rendered label, every group
with the question that lives on an ancestor, select and ARIA-combobox options,
upload triggers, errors tied to their field, and a selector that survives a
re-render. 70 assertions, all fixtures built from shapes seen live.

What it fixes that nothing else did, each found on a real page:

- **Shadow DOM.** One form exposed 1 input at document level and held the real
  13 behind 1814 open shadow roots. Piercing traversal, plus per-root id
  uniqueness (ids repeat across roots and between a component and the control
  it wraps) and labels projected from the host.
- **Iframes, consent walls and entry links** — the three separate reasons a
  rendered page reports zero fields, now named individually (`frames`,
  `consentWall`, `entryPoints`) instead of all looking like a broken posting.
- **Label pollution** from inline SVG fallbacks and from `<label>` elements
  that wrap the field itself along with its live widget state.
- **Writes through `browser_evaluate`**, which look applied and leave the
  form in a state its own validator rejects — the failure that cost the most
  time to diagnose, now a rule in the mode.

Also fixed in `lib/freemotion-answers.mjs`: `textarea` was not a free-text role,
so every hand-written essay in `config/apply-essays.yml` was unreachable from a
DOM-driven caller and silently improvised instead.

Full evidence, per-vendor notes and the generic rules G1-G17 are in
`docs/freemotion-ats-findings.md`.
*Check:* `node test-all.mjs --only freemotion-inventory` passes (70
assertions); the full suite is at 8309 passing with no new failures.

---

## 7. Explicitly out of scope / deferred

- ~~**Email verification link automation**~~ — **no longer deferred: built in
  Phase 9** (`lib/freemotion-inbox.mjs`). §1.2's descope is closed. What
  remains open is narrower and is Phase 10: confirming against a real
  registration-walled posting that a live ATS's confirmation mail satisfies
  the three safety rules, rather than only the fixtures.
- **Guaranteed WAF/CAPTCHA defeat.** Camoufox is wired as a swappable engine
  (§1.6/§4.7); this plan does not claim it defeats every anti-bot system,
  and the CAPTCHA policy in §5 is skip-and-log, not solve.
- **Parallel/multi-worker runs.** §1.3's design keeps the ledger in §4.5
  race-safe for this already (locked claim-then-record), but the
  orchestration of running several `agy` + MCP sessions concurrently, and
  any per-worker rate-limiting against a single ATS domain, is not designed
  here.
- **`config/apply-answers.yml` / `config/apply-essays.yml` schema
  evolution.** This plan reuses both files exactly as they exist today
  (§1.7). Formalizing them (a JSON Schema, a validator script akin to
  `validate-portals.mjs`) is future work, not blocking this build.
- **The `PROTECTED_SUBKEY_TABLE` in §4.3 is a starter set**, covering only
  the sub-questions already visible in a real, populated
  `application_answers` block. Extending it for sub-questions not yet seen
  is ongoing maintenance, not a one-time build step — an unmatched
  sub-question correctly falls through to the same "most probable answer"
  handoff as any other unmatched field, per §1.3, never blocking the build.
- **A query/browse layer over the audit log.** §4.8 is intentionally just an
  append + read-back-whole-file pair. Searching it by company or field is
  left to whatever the user already has (grep, a spreadsheet import) rather
  than new tooling.
- **The long tail of ATS-specific quirks beyond Workday.** Workday is NOT in
  this bucket — it is Phase 8's primary acceptance target (§6). What stays
  deferred is real-world hardening against the rest of the tail
  (SuccessFactors' iframe-heavy layout, one-off custom career sites), handled
  generically by the same DOM+vision gate and snapshot-driven loop with no
  vendor-specific code, but not tested tenant-by-tenant as part of this build.
