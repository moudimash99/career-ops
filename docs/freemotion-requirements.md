# Free Motion — requirements brief

Written 2026-08-29, to hand to Claude Fable for architecture design. This is
requirements, not design — Fable decides how; this states what and why.

## Goal

Free Motion is an auto-applier that can attack **any** website. Given an
application page, it finds the apply button, fills in the information, and
presses submit. It is fully autonomous: if the site requires an account and
none exists, it creates one and continues. Throughput target is **tens of
applications per hour, hundreds per run** — volume is the point, not a
side-effect.

The binding constraint on that volume is submission quality. A submission that
reaches an employer incomplete, malformed, or visibly half-filled is worse than
no submission at all: it burns that company permanently and risks the candidate
being flagged for low-effort applications. So Free Motion optimizes for
*throughput of correct submissions*, and every Submit is gated on a validation
pass.

"Quality" here means a tailored CV and cover letter per posting, and a
correctly-filled form. It does not mean hand-curating a shortlist, and it does
not mean pausing to ask the user.

## Scope

**In scope:** any application form on any employer's site — Workday tenants,
SuccessFactors instances, Greenhouse / Lever / Ashby / SmartRecruiters
postings, and one-off custom career sites.

**Out of scope:** the seven employers AirBusAutoApplier already covers (Airbus,
Accenture, Capgemini, Thales, Sanofi, NTT, NXP). Those keep running on their
existing, proven vendor-specific Python/Selenium code — Free Motion does not
touch or replace them. It exists so that "company #8" never again means writing
a new few-hundred-line vendor module by hand before Mohammad can apply
anywhere.

## Why generalize instead of writing another vendor module

AirBusAutoApplier's model — one hand-written page-object module per ATS vendor
(pp/pages.py for Workday, pp/capgemini.py for SuccessFactors) — does not
scale past a small, fixed roster. Every new employer is another module, another
set of selectors to keep working as the vendor's UI changes, another set of
tenant-specific traps to relearn (see AGENTS.md's "Traps that cost real time"
for how much of that accumulated for just seven tenants). Free Motion trades
per-vendor code for a general read-the-page, decide, act loop, at the cost of
needing a model in the loop for anything a deterministic parser can't
confidently classify.

## Functional requirements

1. **Given any employer's application-form URL, reach a submitted state**
   without vendor-specific code. This covers: locating the apply entry point,
   standard identity fields (name, email, phone, address), resume/CV generation
   and upload, work history and education entry, free-text and multiple-choice
   custom questions, and the submit action itself.
2. **Create an account when the site requires one.** Registration, email
   verification where it can be automated, and credential persistence are part
   of the flow, not a manual prerequisite. Credentials are stored locally and
   never committed.
3. **Fill what can be filled deterministically, cheaply, first.** Standard
   fields (name, email, phone, resume upload) should not cost an LLM call — a
   fast, free, non-agentic pass handles the obvious majority of any form,
   leaving only what's actually ambiguous or form-specific for the model.
4. **Escalate to a model only for what the deterministic pass could not
   confidently map**: custom screening questions, non-standard widgets,
   free-text prompts.
5. **Answer every question — autonomy over abstention.** An unanswerable-looking
   required field is never a reason to skip a posting. The model answers from
   the candidate's actual data (cv.md, config/profile.yml,
   rticle-digest.md), inferring where the answer is entailed rather than
   stated, and choosing the most probable answer for this candidate where
   nothing is entailed. Every inferred answer is logged.
6. **One class of question is read, never inferred.** Work authorization / visa
   / sponsorship, criminal-record and background checks, EEO and demographic
   self-identification, education credentials, licences and clearances, and
   salary expectations are answered from the \pplication_answers\ block in
   \config/profile.yml\. These are pre-answered once precisely so the run stays
   autonomous without guessing on anything carrying legal or immigration
   consequences for the candidate — a wrong answer here can cost a rescinded
   offer or the Passeport Talent permit. Missing key ? safest legally-accurate
   fallback from \location.visa_status\ / \compensation\, logged as
   \nswered-from-fallback\, run continues.
7. **Validate hard before submitting.** A visual or structural check must
   confirm the form is correctly filled — no visible validation errors, no
   empty required fields, no obviously wrong values — before any Submit fires.
   This is the gate that makes high volume safe; see "Lessons" below.
8. **Never submit twice for the same posting.** A durable, checkable record of
   what has already been applied to, keyed on normalized posting URL (or
   requisition ID where exposed) — not session state, which does not survive a
   restart or a second run.
9. **CAPTCHA: skip, never solve.** Proactively skip application flows on
   platforms known to trigger CAPTCHAs heavily; on an unexpected CAPTCHA, abort
   that one posting, log it to \output/captcha_links.txt\, and skip the rest of
   that platform for the run. Never attempt to solve or bypass one. This is the
   one place where skipping is correct behaviour, not a gap.

## Non-functional requirements

- **Throughput.** Tens of applications per hour sustained. Per-posting latency
  and per-posting model cost are both first-class design variables.
- **Cost-aware by default.** The deterministic pass (no model) handles the large
  majority of any form's fields; only the genuinely form-specific remainder
  reaches a paid or rate-limited call.
- **Browser backend swappable without touching application logic.** A plain
  local browser for most sites, and a pluggable path to a more resilient
  backend (e.g. a CDP-connected stealth browser such as Camoufox) for sites with
  aggressive anti-bot protection — selected by configuration, not by branching
  application code per site. Application logic runs unchanged over either.
- **Auditable.** Every attempted posting needs a record of what happened —
  submitted, filled-and-validated, validation-failed, CAPTCHA hit, or errored —
  plus every answer given and its source (\profile\ / \inferred\ / \allback\),
  in the same spirit as \	ools/run_all.py\'s per-run logs and
  \output/**/applications.json\ in AirBusAutoApplier. A run that submitted
  nothing and says nothing happened is indistinguishable from one that silently
  failed. At this volume the log is the only way the user knows what was said on
  their behalf.
- **One active session per candidate profile at a time.** Two concurrent
  submission attempts against the same candidate data or browser session must
  not be possible. Parallelism, if any, is across isolated profiles/contexts.

## Lessons from AirBusAutoApplier worth carrying over

Light-touch — proven failure modes, not a mandate to mirror that codebase's
design:

- **A page that "looks empty" might just not have rendered yet.** A real bug: a
  check for "is this field already filled" ran before an async-loaded
  carry-forward value had rendered, read zero, and wrote a duplicate on top of
  what was about to appear. Any "is X already present" check must tell
  "genuinely absent" apart from "hasn't rendered yet," or repeated runs quietly
  accumulate duplicates. Directly relevant since Free Motion's whole premise is
  reading page state before acting — and at volume this failure multiplies.
- **Scope any model-in-the-loop step narrowly, with explicit constraints.** An
  open-ended "go fill out this form" prompt gives a model room to improvise past
  what's asked (it once decided to install a package and parallelize a slow
  step). Tier 2's job should be described as narrowly as the ambiguous fields it
  is actually meant to handle.
- **A durable, url-keyed submission record beats a session-only one.** Restated
  functional requirement 8: without it, a restarted or re-run process re-applies
  to what it already submitted — which at this volume means duplicate
  applications to the same employer.

## Explicit non-goals

- Does not need to handle or improve on the seven employers AirBusAutoApplier
  already covers.
- Does not need to solve CAPTCHAs — skipping is correct, not a gap to close.
- Does not need a UI beyond whatever CLI/log output makes a run auditable.
- Does not need to curate or score postings. Targeting is upstream
  (\scan\ / \	riage\); Free Motion applies to what it is handed.

## Open questions for the architecture design

- How is "confidently mapped" (requirement 3) actually decided — what is the
  deterministic pass's own confidence signal for "this is clearly the email
  field" versus "this needs the model"?
- What is Tier 2's actual sandboxing — arbitrary shell, or only the narrow
  TYPE/CLICK/SELECT/UPLOAD vocabulary sketched in \lib/tier2-execute.mjs\?
- How does the validator (requirement 7) get chosen and configured per the
  user's cost tier (\spend_tier\ in \config/profile.yml\), and what does it do
  on a *disagreement* — retry the field, or abandon the posting?
- Where does the submission record (requirement 8) live, and does it
  interoperate with career-ops' own tracker (\data/applications.md\) the way
  AirBusAutoApplier's does via \pp/careerops.py\, or stay separate?
- Account creation (requirement 2): where do credentials live, how is email
  verification handled, and what happens when a site requires a phone/OTP?
- At tens-per-hour, what is the rate-limiting and backoff policy per ATS host,
  so the system does not get IP-blocked mid-run?
