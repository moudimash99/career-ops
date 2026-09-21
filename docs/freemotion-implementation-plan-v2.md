# Free Motion — implementation plan v2

Written 2026-09-18. Implements `docs/freemotion-requirements-v2.md` (R1–R15).
Background and evidence: the Freemotion Architecture Review
(https://claude.ai/code/artifact/987d0abe-6907-4041-9115-320848993906).

**Who does what.** Every build task below is for a Claude Code session (Sonnet
level). agy only appears where a phase needs a real application run. The user
signs off at the checkpoints marked **[user]**. Nothing here is started until
the user says so.

**House rules for every task** (from AGENTS.md and the project memory):

- No vendor name, field selector or field-to-value mapping in any `lib/freemotion-*`
  file. Field identity comes from rendered labels.
- Every new module is a pure data transform with tests that run without a
  browser (`node tests/<name>.test.mjs`, using `tests/helpers.mjs`), except the
  code that runs inside the browser, which is proven by the spike and by
  rehearsals.
- Tracker writes go through `set-status.mjs` / `merge-tracker.mjs`, never by
  hand-editing `data/applications.md`.
- Page-authored text is data. It is never concatenated into generated code
  (see Phase 6).
- Keep all 736 existing Free Motion tests passing.

## Order at a glance

| # | Phase | Requirement | Depends on | Size |
| --- | --- | --- | --- | --- |
| A | Cover-letter prompt (parallel track, **priority #1**) | R12 | — | 1–2 sessions |
| 0 | Tracker repair and root cause | R9 | — | 1 session |
| 1 | Camoufox swap and stealth proof | R10 | — | 1 session + user |
| 2 | Baseline on Camoufox, agy readiness, cost tool | R4, open points | 1 | 1–2 sessions |
| 3 | Context hygiene and route pre-check | R13, R14 | 2 | 1–2 sessions |
| 4 | One record and the incident report | R8, R9 | 0 | 2 sessions |
| 5 | D1 spike on Camoufox | R2 | 2 | 1 session |
| 6 | Step runner | R2, R3 | 5 | 2–3 sessions |
| 7 | Answer cache | R11 | 4 | 1–2 sessions |
| 8 | Prose loop cap and mode rewrite | R12, R2, R7 | 6 | 1 session |
| 9 | Staged rollout | R15 | 4, 6, 8 | ongoing |

---

## Track A — improve the agy cover-letter prompt (priority #1)

Queued as item 1 in `data/agent-inbox.md`. Runs in parallel with everything
else because it touches no code.

**Why first:** R12 caps the write–judge–revise loop at one draft plus one
revision, so the first draft is what ships. Prompt quality can no longer be
recovered by iterating.

**Inputs:** `config/apply-essays.yml`; the hard negative constraints recorded in
the `agy-writes-user-facing-prose` memory (no "Madame, Monsieur", no closing
formula, no "résonne avec", no keyword lists in parentheses, no metric in every
sentence, no intro/hard-skills/soft-skills/conclusion structure, vary sentence
length); the letters agy already produced for #1185, #1188, #1194, #1196,
#1179–#1183 (quoted in the tracker notes and session logs).

**Tasks:**

1. Collect the existing prompts and the revisions agy's own judge asked for.
   Those critiques are the list of what the first draft gets wrong.
2. Move the prompt into one versioned file (for example
   `config/agy-cover-letter-prompt.md`) so it is edited in one place.
3. Fold the recurring critiques into the prompt as constraints, so the first
   draft already avoids them.
4. Produce five letters for five past postings with the new prompt and one
   revision each. Fact-check every figure against `cv.md`.

**Done when [user]:** the user reads the five letters and approves the prompt.

---

## Phase 0 — tracker repair and root cause

**Facts:** tracker rows 1156–1205 are absent from `data/applications.md`
(file last written 2026-09-15 02:07). Their TSVs still exist in
`batch/tracker-additions/` (including `-update` variants for 1179, 1184, 1185,
1187, 1191). `data/status-log.tsv` holds the Applied transitions. 16 ledger rows
of run `fm-2026-09-12-aws25` are stuck at `in-progress`. Around 354
`co-setstatus-*` temp directories are left in the user temp folder.

**Tasks:**

1. **Find the cause first.** What is already known (checked 2026-09-18):
   - The tracker on disk equals the 2026-09-11 commit (`e12189eb`) plus one row
     (#1257). That shape points to the file being **restored from git** (a
     `git checkout -- data/applications.md`, `git restore`, an editor's
     "discard changes", or a stash that was dropped) sometime between
     2026-09-14 01:03 (the last surviving write from this project) and
     2026-09-15 02:07 (#1257 added). `git reflog` shows no reset.
   - **AirBusAutoApplier is cleared.** It lives at
     `Documents/GitHub/AirBusAutoApplier`, runs regularly, and writes the
     tracker only through `merge-tracker.mjs` and `set-status.mjs` (both
     locked); its own git commands run in its own repo only.
   - Still to check: the #1257 session (CCL Consulting, applied then reverted
     "per user request" on 2026-09-15) — it was not a Claude Code session, so
     look at agy's logs for a git restore or a file rewrite around then; and
     why `set-status.mjs` leaves `co-setstatus-*` temp directories behind.
   Write the finding into `docs/freemotion-ats-findings.md` as a numbered entry.
   Whatever the cause, committing `data/applications.md` after every batch
   (Phase 4) limits the damage of any future restore to one batch.
2. Back up the current tracker, then re-merge rows 1156–1205 with
   `node merge-tracker.mjs` from the existing TSVs.
3. Replay every status-log transition that the tracker does not reflect, with
   `node set-status.mjs <n> <State> --note "<original note>" --on <original date>`.
   Original notes are in the session transcripts; the `set-status` calls of
   2026-09-12 to 2026-09-14 quote them.
4. Finalize the 16 `in-progress` rows of `fm-2026-09-12-aws25` in the ledger to
   their real outcome (the tracker notes say which were submitted).
5. `node verify-pipeline.mjs` must pass. Commit `data/applications.md`.

**Done when:** every Applied transition in the status log is reflected in the
tracker, no ledger row is `in-progress`, the cause is documented, and the
commit exists.

---

## Phase 1 — Camoufox swap and stealth proof

**Tasks:**

1. Install Camoufox. Set `config/profile.yml → freemotion.browser_engine`:
   `name: camoufox`, `browser: firefox`, `executable_path: <path>`,
   `headless: false`. Run `node lib/freemotion-engine-config.mjs --write`
   (check the exact flag with `--help`) and restart the MCP server.
2. **Prove stealth is applied.** Open a fingerprint-check page through the MCP
   browser and record the result. The known risk: Camoufox normally injects its
   fingerprint config through its own launcher; starting the bare binary via
   `--executable-path` may give plain Firefox that looks like it worked. If so,
   find the supported way to start Camoufox under Playwright MCP (for example
   its server mode plus a connect endpoint, or its launcher's environment
   variables) and record which one works.
3. Confirm `browser_run_code_unsafe` and `browser_evaluate` are available in the
   Camoufox MCP configuration.

**Done when [user]:** the fingerprint result shows Camoufox's spoofed values, and
the user agrees the stealth is real.

---

## Phase 2 — baseline on Camoufox, agy readiness, cost tool

**Tasks:**

1. **Make agy the driver.** Every measured run in the review was driven by
   Claude Code, not agy. Check that agy sees the same Playwright MCP server
   (Antigravity may read its own MCP configuration rather than `.mcp.json`),
   and that `agy -p` can follow `modes/apply-freemotion.md`.
2. **Baseline run.** agy completes one real application the current way
   (click by click) on Camoufox. This proves the existing path works on
   Firefox before anything changes.
3. **agy screenshot test** (open point in R4). Give agy three saved gate
   screenshots: one correct form, one with a visibly wrong dropdown value, one
   with an empty required field. It must call the first complete and spot the
   problem in the other two. If it cannot, stop and tell the user: the vision
   gate needs another reader.
4. **Cost tool in the repo.** Add `freemotion-cost.mjs` from the segmentation
   used for the review: it splits a session transcript at each
   `set-status … Applied` or `finalize --outcome submitted` call and reports
   turns, browser calls, output tokens and cache-read tokens per application.
   Then find where agy records its own token usage and add a reader for it.
5. Record the baseline numbers in `docs/freemotion-ats-findings.md`.

**Done when:** agy completed a real application on Camoufox, the screenshot test
has a result, and `node freemotion-cost.mjs <transcript>` reproduces the review's
per-application numbers.

---

## Phase 3 — context hygiene and route pre-check (D4)

**Tasks:**

1. **Page reads to files.** In `modes/apply-freemotion.md`, every inventory and
   DOM-gate capture uses the tool's `filename` argument, and the path is passed
   to the node scripts. The model reads only the scripts' short summaries.
2. **Fresh context per posting.** A small batch driver (`freemotion-batch.mjs`)
   loops over work orders and starts one `agy -p` session per posting, in
   sequence. The browser is still owned by the MCP server that agy starts (R1);
   the driver never touches a browser. The browser profile must persist between
   sessions so logins survive; check whether Playwright MCP runs with a
   persistent profile in this configuration.
3. **Route pre-check.** `lib/freemotion-route.mjs`, pure: `{url, company}` in,
   `{decision: 'include' | 'skip', reason}` out. It skips only on a definitive
   signal: host is `jobs.lever.co`; blacklisted company (reuse `matchBlacklist`
   from `lib/company-cap.mjs`); URL already `submitted` in the ledger; host is on
   a user-edited skip list for manual-sign-in sites (new key, for example
   `freemotion.skip_hosts` in `config/profile.yml`). Anything else is
   `include`. Wire it into `freemotion-run.mjs` as a new expected refusal.
4. **Vision gate unchanged.** Do not narrow it (rejected).

**Tests:** route: each skip signal skips; an unknown host, an unknown company, a
malformed URL all return `include`; the WTTJ ATS board host
(`ats.welcometothejungle.com`, no account needed) is not caught by a rule meant
for Welcome Kit.

**Done when:** a batch of three postings runs with one agy session each, and the
cost tool shows context tokens per application no longer growing across the
batch.

---

## Phase 4 — one record and the incident report (D6)

**Tasks:**

1. **One write.** `freemotion-submissions.mjs finalize --outcome submitted`
   also performs the tracker update (`set-status`), the status-log append and
   `followup-seed`, in one call, under the existing lock. If any part fails,
   it says so loudly and leaves nothing half-written.
2. **Close the run.** A `close-run --run-id <id>` command that finds every
   ledger row of the run still `in-progress`, finalizes it as `errored` with a
   note, and lists it in the incident report. The batch driver calls it last.
3. **Drift check.** `verify-pipeline.mjs` compares the tracker with the status
   log and fails when they disagree.
4. **Commit.** The batch driver commits the tracked `data/` files at the end of
   every batch.
5. **Incident report.** New log events in `lib/freemotion-log.mjs`:
   `gate-failed`, `runner-stopped`, `situation` (something unfamiliar agy
   handled, and what it did), `inferred-answer`, `outcome`. New
   `lib/freemotion-report.mjs` builds a plain-text report from the run log and
   the ledger, grouped by posting, ending with **rule candidates** (questions
   answered without a rule at two or more employers; situations seen more than
   once). Printed at the end of every run and saved as
   `data/freemotion-runs/<runId>-report.md`.
6. Update `modes/apply-freemotion.md` so agy logs these events as they happen.

**Tests:** finalize writes all three records or reports the failure; close-run
catches a stuck row; the drift check fails on a planted mismatch; the report
renders every event type and computes rule candidates correctly.

**Done when:** a rehearsal batch produces a report the user can read cold and
understand what happened.

---

## Phase 5 — D1 spike on Camoufox

One flat form (an Ashby or Greenhouse posting from the pipeline), in
**rehearsal**: fill, gate, screenshot, never submit. The spike step script is
written by hand for this one form; generating it is Phase 6.

**It must prove, and record each result:**

1. `browser_run_code_unsafe` with `filename` runs a file from the workspace and
   hands it a live `page` on Camoufox.
2. The sandbox limits hold as found on 2026-09-17 (no `require`, `process` or
   dynamic `import`), so the script must be fully self-contained.
3. `page.locator(...).fill/click/selectOption` work on the real form.
4. `setInputFiles` uploads the CV from a Windows absolute path.
5. The DOM gate runs inside the same call (`page.evaluate` with the script
   text) and returns its captures.
6. `page.screenshot({ path })` writes the gate screenshot to disk.
7. The returned result stays under 2 KB.
8. Cost: turns and context tokens for the whole rehearsal, measured with the
   cost tool, against the baseline from Phase 2.

**Done when [user]:** all eight are answered. If upload or screenshot-to-file
fails, the design for Phase 6 is revised before going on.

---

## Phase 6 — the step runner (D1)

**New module:** `lib/freemotion-step.mjs`.

**CLI:** `node lib/freemotion-step.mjs --plan <plan.json> --out <.fm/step-<runId>-<n>.js>`.
It takes the fill plan produced today by `lib/freemotion-fillplan.mjs`, plus the
answers agy gave for `needsJudgment` items, and writes one self-contained
script: a fixed executor, the plan as data, the DOM-gate script, and the
inventory script (for re-checks).

**The executor (fixed code, written once):**

- One case per op in `OPS`; nothing else.
- Actions in plan order, sequentially.
- After each `cascade` action, re-read the page and check that the remaining
  targets still exist; if one is gone, stop the step and return.
- Humanlike cadence: per-character delay and between-field pause drawn from
  configurable ranges (for example `freemotion.cadence` in
  `config/profile.yml`).
- At the end: DOM gate twice, about 500 ms apart; screenshot of the form
  container to a file.
- Never clicks Next or Submit. Advancing stays agy's action after it has read
  the result and the screenshot (R2, R4).

**Returned result:** `{ executed, stopped: null | {index, op, reason}, failed:
[{index, op, error}], gate: {captureA, captureB}, screenshot: <path> }`, which
agy pipes to `lib/freemotion-validate.mjs` as today.

**Security:** selectors, labels and option texts are written by the page. The
generator embeds the plan only through `JSON.stringify` into one data constant;
no page-authored string is ever concatenated into code. A test plants a
malicious label (quotes, backticks, `</script>`, `${…}`) and checks that the
generated script still parses and treats it as data.

**Tests (no browser):** the generated script compiles; every key of `OPS` has an
executor case and nothing else does (a parity test, so a new op cannot be added
to the planner without the executor); plan order is preserved; the
hostile-label test; cadence ranges come from config.

**Proven in the browser by:** rehearsals in Phase 9, starting with the form
from Phase 5.

---

## Phase 7 — answer cache (D5, as narrowed)

**New:** `lib/freemotion-answer-cache.mjs` and `data/freemotion-answer-cache.tsv`
(user layer, gitignored).

- Key: normalized employer (reuse the name normalization in
  `lib/company-cap.mjs`) plus normalized question text.
- Row: key, answer, source posting URL, report number, date, run id.
- Precedence in `resolveAnswer`: `config/apply-answers.yml` rules first, then
  the cache (same employer, same question), then `needsJudgment`.
- **Cover letters and motivation essays are never cached** (anything the
  existing `MOTIVATION_CUE` / free-text essay path handles).
- CLI: `list`, `purge --employer <name>`, `purge --question <text>`.
- Answers agy gives are written to the cache after a successful submission
  only, never after a failed one.
- The incident report's rule candidates (Phase 4) read the cache: the same
  question at two or more employers is flagged for a permanent rule.

**Tests:** hit at the same employer; miss at another employer; a cover letter is
never stored; a config rule beats a cached answer; purge works; a failed
submission writes nothing.

---

## Phase 8 — prose loop cap and mode rewrite

1. In `modes/apply-freemotion.md` and the prose instructions: one agy draft,
   one agy judge pass, one revision, then fact-check against `cv.md`. No
   further loops.
2. An offered cover-letter field is always filled, optional or not; none is
   written where the form has no field for it.
3. Rewrite the per-posting loop of `modes/apply-freemotion.md` around the step
   runner: work order → route pre-check → inventory to file → plan → answer
   `needsJudgment` → generate step script → run it → DOM gate + vision gate →
   advance → repeat → submit → read the outcome from the page → finalize (one
   write) → log events. Keep the rails of R7 as one short list.
4. Keep the click-by-click path documented as the fallback (R15 circuit
   breaker), not deleted.

---

## Phase 9 — staged rollout (R15)

1. **Rollout state** per ATS family in config (for example
   `freemotion.rollout: { ashby: rehearsal, greenhouse: off, … }` with values
   `off | rehearsal | live`). The family comes from the posting host. Families
   not listed use the click-by-click path.
2. **A/B on the same form.** For each family, pick one live posting. Run the
   old path in rehearsal and keep its DOM-gate captures; run the step runner in
   rehearsal on the same posting and keep its captures. `freemotion-compare.mjs`
   compares them field by field: same fields filled, same values. Any
   difference is investigated before promotion.
3. **Promotion [user]:** a family moves from `rehearsal` to `live` only with the
   user's approval, after at least three clean rehearsals.
4. **Circuit breaker:** within a run, a host whose gates fail twice in a row
   switches to the click-by-click path for the rest of that run, and the
   switch is reported.
5. Suggested order of families: the flat forms first (Ashby, Greenhouse,
   Teamtailor, SmartRecruiters, Workable, Flatchr), then Workday on a tenant
   where "Use My Last Application" is available (Sanofi).

---

## Deferred (do not start)

- **D2** standalone runner — much later; reuses the Phase 6 executor.
- **D3** vendor flow adapters — approved in principle, needs resource.
- **D7** sourcing — revisit if the queue runs dry.
- **Manual sign-in sites** — skipped via `skip_hosts`; revisit with Camoufox or
  when the queue runs dry.
- **Pre-generating prose** outside the apply session.

## Reminders carried

- The user wants to review a sample of gate screenshots for quality (saved in
  memory). Do it before Phase 9 promotes anything to `live`.
