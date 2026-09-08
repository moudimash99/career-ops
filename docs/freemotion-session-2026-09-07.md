# Free Motion — overnight session, 2026-09-06 → 07

Read this first; `docs/freemotion-ats-findings.md` has the evidence behind
every claim, and `docs/freemotion-implementation-plan.md` §6 Phases 9 and 11
have the design rationale.

---

## What you asked for, and what happened

1. **"Continue the Free Motion project"** → Phases 1-8 were already done, so I
   built **Phase 9: automatic email verification**, the last descope from the
   original plan.
2. **"Test with real-world cases, try to submit"** → one real application
   went out, full auto.
3. **"Go the distance but don't submit, try as many different websites as
   possible, fill in as much as possible even if not required"** → five more
   ATS families driven to a complete form and stopped, with every defect found
   fixed generically.

**Nothing was submitted after that instruction arrived.** One application was
sent before it, at 23:47 on the 6th.

---

## The one live submission

**Thales — Ingénieur Cloud & DevSecOps (H/F), Toulouse** (report #502, scored
4.9/5). Submitted through `careers.thalesgroup.com`, a 4-step wizard in front
of Workday. Fully automatic: no pauses, no captcha.

- `status=success`, `Job_Application_ID=72dd06632cb99000802991ac7fc40000`,
  `candidateId=CAND7462746`
- CV: `output/cv-mohammad-machaka-thales-cloud-devsecops.pdf` — retargeted from
  the earlier FinOps CV by swapping two lines (competency tag and skills
  header) to DevSecOps framing. Every security claim in it is evidenced in
  `cv.md`: least-privilege IAM, Secrets Manager, JWT→PASETO, rate limiting.
- Salary answered "44 000 EUR brut annuel" from `config/apply-answers.yml`;
  gender "Je préfère ne pas répondre" from `application_answers.demographics`.
- Tracker row #502 is now `Applied`.

A second Thales role (#1112, DevOps cloud) could not be applied to: the tenant
**dedupes by candidate email across requisitions** and short-circuited to
`status=alreadyApplied` at step 1. Nothing was sent.

## Dry runs — filled completely, screenshotted, not submitted

Screenshots in `output/freemotion-dryruns/`.

| ATS | Posting | Result |
|---|---|---|
| Ashby | Alan — Senior Platform Engineer (Data Retention & Privacy) | 100% filled: every optional field, 2 essays from `apply-essays.yml`, 4 radio groups, CV |
| Greenhouse | Artefact — Senior Software Engineer, Paris | 100% filled incl. optional CV + a written cover letter, 2 ARIA comboboxes, 2 consents |
| SmartRecruiters | Ubisoft — Team Lead, Bordeaux | 100% filled through **shadow DOM**, CV uploaded, message written |
| Workable | Hugging Face — Low-level SWE, Xet Storage | **Deliberately not filled** — see below |
| Lever | Swile — Senior SWE, Toulouse | **Deliberately not filled** — hCaptcha on load |

### The two I refused, and why

**Hugging Face (Workable).** The form required (a) attesting *"everything in
this application is true and your own, including your experience and
identity"* and (b) confirming the first answer began with an exact phrase
planted in the job description — a deliberate automation tripwire. It also
required a **GitHub profile URL**, which does not exist anywhere in your user
layer. Filling it would have meant signing an authorship statement on your
behalf, defeating a check the employer put there on purpose, and inventing a
URL. It was also a poor fit on the merits (low-level Rust/storage).

**Swile (Lever).** hCaptcha is present before any interaction. AGENTS.md
already names Lever a proactive skip; this confirms the vendor.

---

## What got built

### `lib/freemotion-inbox.mjs` — Phase 9, email verification (90 assertions)

Turns `account-verification-pending` from a dead end into a resumable state.
Reads the confirmation mail from Gmail (the same three `GMAIL_*` env vars the
bundled gmail plugin documents) or from a pasted file, and returns the one
link to click. `node lib/freemotion-inbox.mjs pending` lists parked postings.

The security design is the point: an inbox is the only input channel a
stranger can write to, and here a message would be read for an *action*. Three
rules, all tested — recency + addressee, same-registrable-site or nothing
automatically, and nothing in the email influences the choice. A cross-site
link is reported with its host spelled out and left for you.

### `lib/freemotion-inventory.mjs` — Phase 11, the generic form reader (74 assertions)

The gap the live runs exposed: **nothing in the system answered "what is this
field asking me?"** A field's name is a UUID on one ATS and a dotted path on
another, and every radio option is labelled "Yes". One `browser_evaluate` now
returns labels, ancestor-resolved group questions, options, upload triggers,
errors tied to their field, and selectors that survive a re-render.

Biggest find: **shadow DOM**. One form showed 1 input at document level and
held the real 13 behind 1814 open shadow roots — a non-piercing reader calls
that page "no form". Also: the three separate reasons a page reports zero
fields (iframe / consent wall / you're on the ad not the form) are now
distinguished instead of all looking like a broken posting.

Verified live, as shipped, against a real Greenhouse form: 9 fields, 0
unlabelled, correct required count.

### Fixed in existing code

- `lib/freemotion-answers.mjs`: `textarea` was not a free-text role, so **every
  hand-written essay in `config/apply-essays.yml` was unreachable** from a
  DOM-driven caller and got silently improvised instead.
- `modes/apply-freemotion.md`: the inventory step, the widget mechanics that
  cost the most time, and two new hard "never" rules.

### 17 generic rules (G1-G17) in `docs/freemotion-ats-findings.md`

The one that cost the most time, and the most useful to know:

> **Never write to a page through `browser_evaluate`.** An injected
> `el.click()` ticks the box visually but does not run the page framework's
> change handling. A Thales consent pair looked answered and the form refused
> to advance with an error naming a field that was plainly filled. Two real
> clicks fixed it instantly.

---

## Tests

`8314 passed, 8 failed` — the **same 8** that were failing before this session
started (they are all pre-existing fork divergence: your own untracked debug
scripts, `prune-pipeline.mjs`, the English README's removed HITL marker, and
batch-prompt drift from the upstream merge). No regressions; +168 assertions.

---

## Three things that need you

1. **`config/apply-answers.yml` has no street address and no GitHub URL.** You
   asked me to fill every field even when optional; I filled everything I
   could source truthfully and left these, because a home address and a
   profile URL are facts about you, not inferences. Two lines in that file and
   they never block again. (If you have no GitHub, saying so there is also an
   answer — it stops the run stalling on it.)

2. **French level.** A Greenhouse form asked, on a four-point scale, and
   `config/profile.yml` records `french: "B2"` as your own confirmed CEFR
   self-assessment. I answered **Intermediate**, not Fluent — I would not
   upgrade a self-assessment you confirmed. If you consider yourself fluent
   (you work in French at Airbus and studied in French at ISAE), change the
   profile line and it will answer Fluent everywhere from then on.

3. **The submissions ledger has no honest outcome for two things that
   happened.** `alreadyApplied` was recorded as `errored` (nothing errored —
   the employer said no), and the no-submit dry runs are recorded as
   `validation-failed` (nothing failed validation). Adding `already-applied`
   and `rehearsal` to `VALID_OUTCOMES` would stop both from polluting the
   failure statistics.

## Suggested next

**Phase 10** — resume a real verification wall end-to-end. The Phase 9
classifier is proven against fixtures; what is unproven is whether a real
ATS's confirmation mail lands inside the window, is addressed to you rather
than a list address, and puts its link on the domain the account was created
on. That needs one registration-walled posting and about ten minutes.

---

# Session 2 — 2026-09-07 evening / 09-08

## The correction that mattered: the writing read as AI

`modes/_writing.md` and `voice-dna.md` specified the rules the whole time. I
did not follow them. An audit of my own parked text found **3 em dashes** (a
HARD ban in voice-dna §2), **7 concession-pivot constructions** (the §3F
"trench coat" disguise: `rather than`, `instead of X-ing`), and a 21-word mean
sentence length with low variance, which is the metronome rhythm §4I names.

The fix is not a reminder. It is **`lib/voice-check.mjs`**, a gate (37 tests):

    node lib/voice-check.mjs --file draft.txt [--register conversational|ats]

Exit 1 means a hard rule broke. It **parses `voice-dna.md` at run time** rather
than copying it, so editing that file changes the check and nothing drifts —
88 banned words and 42 phrases come straight from your file. The checks that
cannot be a word list live in code: em dashes, the §3F skeletons, copulative
avoidance, meta commentary, participle padding, rule-of-three and metronome
rhythm.

Two refinements it needed once it was running against real text: rule-of-three
now ignores factual enumerations ("French, English and Arabic" is not the same
tell as "speed, efficiency and innovation"), and the conversational checks are
language-aware, because a French letter has no English contractions and no "I"
and was being told to add both.

Wired into `modes/_writing.md` and `modes/apply-freemotion.md` as mandatory
before any free-text answer is typed.

**Every text block in every parked tab was rewritten and re-linted.** 14 blocks
across 10 tabs, all passing. Mean sentence length on the rewritten project
essay dropped from 21 words to 11, with the variance a human actually writes
with. It caught me once mid-rewrite, on "I'd rather you judge the fit than have
me filter myself out" — exactly the construction it exists to stop.

## 10 applications parked, ready for you to submit

Six from before, plus four new companies:

| Tab | Role | Notes |
|---|---|---|
| 0 | Artefact — Senior Software Engineer, Paris | French level now answers **Fluent** |
| 1 | Artefact — Senior Data Consultant, Paris | FR cover letter, education, consulting = Yes |
| 2 | Alan — Internal Agentic AI Platform | 3 essays rewritten |
| 3 | Alan — Global Billing Platform | 3 essays rewritten |
| 4 | Alan — Care Expert Copilot | 5-year question now **Yes** |
| 5 | Alan — Data Retention & Privacy | strongest fit of the Alan four |
| 6 | **Doctolib — Senior Data Engineer, Paris** | new company |
| 7 | **Doctolib — Staff DataOps Engineer, Paris** | letter is candid about the seniority gap |
| 8 | **Doctolib — Senior MLOps Engineer, Paris** | new company |
| 9 | **Pennylane — Senior Data Engineer Analytics** | remote France; visa position stated plainly |

Nothing was submitted. Every tab sits on its submit button.

On Pennylane: the posting says it cannot sponsor. You have French work
authorisation today, so "right to work in your country of residence" is
answered Yes, and the free-text explains the Passeport Talent transition
openly rather than leaving them to discover it.

## Two more ATS families characterised

- **iCIMS** — nested same-host iframes, a GDPR consent gate before the form,
  and hCaptcha. Its frame **strips the marker parameter** if you open it
  top-level, so G16's "navigate to the frame src" fails here. The inventory
  now descends into **same-origin iframes**, which took the readable field
  count from 2 to 7 on the live page.
- **SuccessFactors** — the public search UI returned zero jobs for every
  query while `scan.mjs` pulled 28 live postings from the same tenant in the
  same minute. The board is bot-gated, the feed is not. Never conclude a
  company has no openings from its rendered careers page.

`lib/freemotion-inventory.mjs` is now at 78 tests. Findings are G1-G18 in
`docs/freemotion-ats-findings.md`.

## Config now carries your answers

Address, apartment, postcode 31300, GitHub, French = Fluent, salary 42K with a
40-43.5K band and the 40K Passeport Talent floor, and a years-of-experience
rule that counts **career span from June 2020** (6+ years) rather than summing
contract months. The standing policy behind those is in `modes/_custom.md`.

Tests: **8377 passing, 8 failing** — the same 8 pre-existing fork failures.
