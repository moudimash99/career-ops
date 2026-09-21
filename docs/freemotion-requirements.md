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



## Why generalize instead of writing another vendor module

AirBusAutoApplier's model — one hand-written page-object module per ATS vendor
(`app/pages.py` for Workday, `app/capgemini.py` for SuccessFactors) — does not
scale past a small, fixed roster. Every new employer is another module, another
set of selectors to keep working as the vendor's UI changes, another set of
tenant-specific traps to relearn (see `AGENTS.md`'s "Traps that cost real time"
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
   the candidate's actual data (`cv.md`, `config/profile.yml`,
   `article-digest.md`), inferring where the answer is entailed rather than
   stated, and choosing the most probable answer for this candidate where
   nothing is entailed. Every inferred answer is logged.
6. **One class of question is read, never inferred.** Work authorization / visa
   / sponsorship, criminal-record and background checks, EEO and demographic
   self-identification, education credentials, licences and clearances, and
   salary expectations are answered from the `application_answers` block in
   `config/profile.yml`. These are pre-answered once precisely so the run stays
   autonomous without guessing on anything carrying legal or immigration
   consequences for the candidate — a wrong answer here can cost a rescinded
   offer or the Passeport Talent permit. Missing key → safest legally-accurate
   fallback from `location.visa_status` / `compensation`, logged as
   `answered-from-fallback`, run continues.
7. **Validate hard before submitting.** A visual or structural check must
   confirm the form is correctly filled — no visible validation errors, no
   empty required fields, no obviously wrong values — before any Submit fires.
   This is the gate that makes high volume safe; see "Lessons" below.
8. **Never submit twice for the same posting.** A durable, checkable record of
   what has already been applied to, keyed on normalized posting URL (or
   requisition ID where exposed) — not session state, which does not survive a
   restart or a second run.


## Non-functional requirements

- **Throughput.** Tens of applications per hour sustained. Per-posting latency
  and per-posting model cost are both first-class design variables.
- **Cost-aware by default.** The deterministic pass (no model) handles the large
  majority of any form's fields; only the genuinely form-specific remainder
  reaches a paid or rate-limited call.

- **Auditable.** Every attempted posting needs a record of what happened —
  submitted, filled-and-validated, validation-failed, CAPTCHA hit, or errored —
  plus every answer given and its source (`profile` / `inferred` / `fallback`),
  in the same spirit as `tools/run_all.py`'s per-run logs and
  `output/**/applications.json` in AirBusAutoApplier. A run that submitted
  nothing and says nothing happened is indistinguishable from one that silently
  failed. At this volume the log is the only way the user knows what was said on
  their behalf.

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


- Does not need to curate or score postings. Targeting is upstream
  (`scan` / `triage`); Free Motion applies to what it is handed.

## TEchnichal REquirments

in architechture file