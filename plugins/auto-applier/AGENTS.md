# Repository Guidelines

This repository automates applying to Airbus roles on Workday via Selenium.

## Roadmap

1. **Stage 1** — make the flow work for *normal* (non-student) jobs. Done for
   Airbus, Accenture and Capgemini.
2. **Stage 2** — scores each posting against the CV (1-100) and reports which
   are worth applying to. `tools/score_postings.py`, on a local model via
   Ollama. Not yet run on a daily schedule, and Ollama is not installed here.
3. **Stage 3** — per-job CV and cover-letter generation, back in the apply
   path. **Letters are wired in** (`tools/build_letters.py`); per-job CV
   generation is not, and the four family CVs are still chosen by keyword.

## Project Structure

- `main.py` — the apply flow. Three modes: `--inspect` (record wizard fields,
  submit nothing), `--dry-run` (drive everything, stop before Submit), and the
  default real run. Results append to `output/succ_links.txt` and
  `output/missed_links.txt`.
- `scrap_jobboard.py` — board scanner. Writes dated JSON chunks under
  `job_scrapper/output/{successes,misses}/`. No browser required.
- `job_scrapper/workday_api.py` — client for the public Workday CXS JSON API.
  Listings and full job descriptions come from here; run it as a module to
  re-dump the live facet taxonomy when a filter stops matching.
- `app/config.py` — `SeleniumConfig`, `JobSearchConfig`, `CandidateData`,
  `ApplicationFiles`. All tunables live here.
- `app/employers.py` — the roster. An employer is data (Workday tenant or not,
  credentials env prefix, its own Chrome profile, its own output dir), not a
  code path. Airbus and Accenture are both Workday; Sopra Steria is not.
- `app/relevance.py` — which postings are worth applying to, and how old they
  are. An explicit keyword model over the title, not an LLM: every pick has to
  be defensible, so `score_title` returns the reason alongside the score.
- `app/record.py` — `output/applications.json`, keyed by url. The `*_links.txt`
  files are **derived views**, rewritten from it. See "Recording outcomes".
- `app/smartrecruiters.py` — read-only client for Sopra Steria's board. Mirrors
  `workday_api.JobPosting` field-for-field so the shortlist tooling does not
  care which board a posting came from.
- `app/capgemini_board.py` — read-only client for careers.capgemini.com. No
  JSON API behind it, but `/search/` renders server-side, so a plain GET is
  enough. Mirrors `workday_api.JobPosting` field-for-field.
- `app/letters.py` — one cover letter per posting, rendered by calling
  career-ops' `generate-cover-letter.mjs`. Content is
  `data/capgemini-letters.json`, keyed by **requisition id**: these letters
  print their own reference number, so one is never reused on another posting. A
  letter **sells the fit**: strengths and evidence only, never a missing skill,
  never the years asked measured against the years held. See "Letter voice".
- `app/llm_score.py` — stage 2. Scores a posting against the CV 1-100 with a
  local model through Ollama, and falls back to `relevance.score_title`,
  labelled as such, when the daemon is not running.
- `app/capgemini.py` — the Capgemini apply flow. SAP SuccessFactors, not
  Workday, so it shares nothing with `app/pages.py` beyond `app/ux.py`. Ported
  from `career-ops/scripts/apply-capgemini.mjs`; that file stays the reference
  for why each selector is what it is.
- `app/pages.py` — page objects for the application wizard.
- `app/inspector.py` — reads every form control on the current page. Read-only.
- `app/ux.py`, `app/driver.py`, `app/path.py`, `app/file_uploader.py`,
  `app/link_getter.py` — interaction helpers, Chrome setup, locators, uploads,
  and bookmark parsing.
- `CV_Generator/` — LaTeX + OpenAI generation. **Not wired into `main.py`**;
  parked until stage 3.
- `job_scrapper/scrap_job_board.py` — the old Selenium board scraper,
  superseded by `workday_api.py`. Kept only as reference.

## Tools

```
tools/login.py --employer Accenture        # establish a session, by hand, once
tools/shortlist.py --employer Airbus       # pick postings -> shortlist.json
tools/apply_shortlist.py --employer Airbus # apply to them (Workday only)
tools/assist_apply.py --employer "Sopra Steria"  # open each one for a human
tools/scrape_capgemini.py --limit 5 --dry-run    # Capgemini board -> shortlist
tools/build_letters.py --only 4,14              # a cover letter per posting
tools/apply_capgemini.py --dry-run --limit 1    # Capgemini (SuccessFactors)
tools/score_postings.py --check                 # stage 2 scorer (local Ollama)
tools/reconcile.py --dry-run               # rebuild the record from the site
tools/run_all.py                           # all three employers, one command
```

## Running everything at once

`tools/run_all.py` is the unattended entry point: it drives the per-employer
pipelines above in sequence — search, then (Capgemini) letters, then apply —
and writes down what happened.

```
tools/run_all.py --search-only    # refresh the shortlists, open no browser
tools/run_all.py --dry-run        # drive every form, submit nothing
tools/run_all.py                  # for real
tools/run_all.py --employers Capgemini --limit 10
```

It orchestrates; it does not re-decide anything. The picks still come from
`tools/shortlist.py` and `tools/scrape_capgemini.py`, and `--min-score` is
**not** passed through unless it is given explicitly — each board's search tool
already has a floor chosen for it (3 on Workday, 1 on Capgemini), and forcing
one number on both put "IT Support Technician Level 2" on the Airbus shortlist.
What it does override is `--max-picks`, which defaults to 40 in
`tools/shortlist.py`: a run meant to apply to everything has to say so.

Employers run **in sequence, never in parallel** — two ChromeDriver suites at
once fight over the same profile, and the loser's postings all fail without
being attempted. A failure fences one employer rather than ending the run.

Sopra Steria is deliberately not in the roster: DataDome blocks its apply form,
so listing it would produce a column of meaningless failures every run.

The preflight runs before any browser opens and prints the CV it will attach —
see "The default CV". An employer that cannot run is skipped with its reason
rather than failing one posting at a time deep inside the wizard.

### What the daily routine reads

A real run ends by exporting three files under `data/`, committing them and
pushing to `master`:

- **`submitted-urls.json`** — urls only, no titles or notes.
- **`last-runs.json`** — the last ten runs' *failures*: stage exit codes,
  tracebacks trimmed to the last frame plus the exception, and every posting
  left `draft` or `failed`. Successes are not carried; they would bury the one
  row worth reading.
- **`cv.md`** — a snapshot of career-ops' `cv.md`, which is the CV the scorer
  and every letter are written against. Refreshed on every run so the two
  cannot drift; a missing source leaves the old snapshot rather than deleting
  it, because an old CV still scores and no CV scores nothing.

They exist for the daily cloud routine, which only ever sees what is in git.
`output/` is gitignored, so without the export the routine looks at a
200-posting board with no idea which ones have been applied to, reports
weeks-old jobs as new every morning, has no failures to diagnose, and nothing
to score a posting against.

The push is the point, not a convenience. An export written but never pushed is
*worse* than no export: the routine answers confidently off a list that stopped
being true, where a recency heuristic at least fails honestly. So a run that
cannot push says so in `errors.log` and counts it as a problem.

`last-runs.json` is written on **every** run, dry ones included — a traceback
raised while driving a form is a real bug whether or not anything was
submitted. Only the push is conditional, and `--push` forces it from a
`--dry-run` when the failures are worth getting to the routine tonight.

Three things it will not do: commit anything but those pathspecs (a run that
just submitted a hundred applications must not sweep up half-finished edits),
force-push, or raise. By the time it runs the applications are already
submitted, and losing that outcome to a git error would be absurd — every
failure comes back as a message. `--no-push` skips it; a `--dry-run` does not
reach it either unless `--push` is given, since nothing was submitted and the
url export would otherwise be committed saying the same thing twice.

### The daily routine

A scheduled task on this laptop runs **agy** (Gemini's agent CLI) every
morning at 07:00. It reads `agy/daily-report.md`, which is the job; `agy/SETUP.md`
is the one-time setup that registers the task. It writes `reports/YYYY-MM-DD.md`
and pushes that one path to `master`.

It scans the boards, scores the freshest unapplied postings against
career-ops' `cv.md`, diagnoses whatever `data/last-runs.json` says broke, and
recommends. It never opens a browser and never submits: applying stays a
deliberate act, and the Chrome profile it would need is one a person may be
sitting in.

Scoring is the interesting part. `app/llm_score.py` wants a local Ollama daemon
that is not installed on this machine, so stage 2 has never run here as
designed — but the routine is itself a language model reading the CV, so it
does the scoring directly. Stage 2 works because the runner replaced the
scorer, not because the scorer started working.

**This was a cloud routine first, and that failed.** A Claude scheduled agent
was set up on 2026-08-24 and is disabled. Its sandbox has no outbound network:
every board, and `www.google.com` with them, answered `403 Forbidden` on
CONNECT from its egress proxy, so it fetched nothing. `reports/2026-08-24.md`
is that run, reporting an empty shortlist and saying plainly why. Worth
keeping in mind before moving any part of this repo into a sandbox: the boards
are the product, and a host that cannot reach them cannot do the job.

Running locally also makes most of `data/` redundant for the routine itself —
it can read `output/` directly. The exports stay because they are cheap, they
are what makes a report reproducible off a clone, and `last-runs.json` is a far
smaller thing to read than a tree of stage logs.

### Where to look afterwards

Each run writes `output/runs/<timestamp>/` with one log per stage, plus
`errors.log` and `summary.json`. `output/runs/latest-errors.log` and
`latest-summary.json` are copies of the newest, so there is a fixed path to
read. The exit code is 1 when something needs a human, 0 otherwise — a run with
nothing new to apply to is a success.

`errors.log` is compiled from three sources, because no one of them is
complete:

- **Stage exit codes**, with the last 40 lines of the failing log.
- **Tracebacks read out of the logs.** The apply tools print one per bad
  posting and keep going, which is right — one bad posting must not end a batch
  — so a stage can exit 0 having lost eight applications.
- **The record diff.** Every posting whose `applications.json` entry changed
  during the run, with its state and note. This is the authoritative list:
  taken from the record rather than the console, because the record is what the
  next run will believe.

In `--dry-run` a draft is the success condition, so drafts are counted as
expected and only `failed` is a problem. In a real run both count.

## Recording outcomes

`output/applications.json` is the record, keyed by posting url, and a later
outcome **overwrites** the earlier one. `succ_links.txt` and
`missed_links.txt` are regenerated from it, never appended to.

This replaced append-only files that could not un-say anything: a posting that
failed once and succeeded on the retry stayed in `missed_links.txt` for good,
and on 2026-08-20 that file held 18 lines describing 5 postings, one of them
already submitted. Never append to those files again.

When the record and the site disagree, the site wins - run `tools/reconcile.py`
rather than editing anything by hand.

`is_submitted` is the one reader that looks wider than the store. Where there
is no `applications.json` at all it falls back to `data/submitted-urls.json`,
which is the only evidence a fresh checkout has - the daily routine's included.
The two answers do not cost the same: a posting wrongly called new sends a
recruiter a second application, one wrongly called submitted is missing from a
report. Nothing else consults the export, so `state_of`, `by_state` and the
derived `.txt` views still describe the local record exactly.

## Setup

```
python -m venv .venv && .venv\Scripts\activate
python -m pip install -r requirements.txt
set AIRBUS_CV_PATH=C:\path\to\your_cv.pdf   # optional - overrides the default
```

### The default CV

Workday applications attach `config.DEFAULT_CV` —
`career-ops/output/Mohammad_Machaka_CV.pdf`, the unbranded two-page one — when
`AIRBUS_CV_PATH` is not set. Capgemini ignores it entirely and picks a tailored
family CV per posting.

There did not use to be a default: the rule was that silently uploading a stale
document is worse than refusing to start. That is the right instinct aimed at
the wrong target. Refusing does not prevent a stale upload — the CV is whatever
career-ops last wrote either way — it only prevents an *unattended* run, which
is the entire point of `tools/run_all.py`. In practice it meant Airbus and
Accenture were skipped on every run while Capgemini went through.

The word that was carrying the rule is **silently**. So the default stands and
the silence goes: every path prints the file before attaching it, and
`tools/run_all.py` resolves and logs it in the preflight, before a browser
opens. A default that has gone missing still fails, and the message names the
file rather than reporting "no CV configured" — which would send you looking
for a setting instead of a file.

## Conventions

- 4-space indent, `snake_case` functions, `PascalCase` classes.
- Keep tunables in the frozen dataclasses in `app/config.py`; do not add globals.
- Store every XPath and CSS locator in `app/path.py`, named in all caps.
- Workday element ids are questionnaire-specific. Never hardcode a
  `primaryQuestionnaire--<uuid>` id in a shared code path: regular postings use
  several different questionnaires, and some have none. Record with `--inspect`
  first, then write a handler keyed on the questionnaire id.

## Safety

- Use `--inspect` or `--dry-run` when touching the wizard. A real run submits
  applications to a real employer and cannot be undone.
- Never commit credentials, `.env`, or Workday identifiers. The signed-in
  session lives in the Chrome profile named by `SeleniumConfig`.
- Validate new locators against both a posting with a questionnaire and one
  without.

## Commits

Concise imperative subject, optional context after a colon. Keep behavioural and
housekeeping changes in separate commits.

## Which board is which

| Employer | Platform | Applying |
| --- | --- | --- |
| Airbus | Workday (`ag.wd3`) | automated, `tools/apply_shortlist.py` |
| Accenture | Workday (`accenture.wd103`) | same code, needs an account |
| Sopra Steria | SmartRecruiters | **blocked by DataDome**, human submits - see below |
| Capgemini | SAP SuccessFactors | automated, `tools/apply_capgemini.py` |

Every Workday careers site is the same API behind a different host/tenant/site,
so `workday_api.Tenant` covers both Airbus and Accenture. Watch one trap:
Airbus uses the `workerSubType` facet for *contract type*, Accenture uses the
same facet for *skills* ("Java Full Stack Development"), so filtering Accenture
by the Airbus subtype ids returns nothing.

Sopra Steria applications go through SmartRecruiters' "OneClick" app, and it is
the one employer here that is **not** submitted automatically. Not by policy -
automatic submission is the whole point of this repo, and where a site allows
it we do it. It is blocked by the site.

Checked on 2026-08-23, and the earlier description here was wrong twice over.
The page does render under ChromeDriver: it comes back titled "Postuler
facilement", cookie wall first, then the full form - personal information,
experience, education, CV, "Suivant". What it does not do is stay. Behind the
cookie banner SmartRecruiters runs **DataDome**, and within seconds the app is
replaced by:

> Access is temporarily restricted. We detected unusual activity from your
> device or network. Reasons may include: Rapid taps or clicks · JavaScript
> disabled or not working · **Automated (bot) activity on your network** · Use
> of developer or inspection tools

with a `geo.captcha-delivery.com` challenge iframe and **zero** form controls
left in the DOM, shadow roots included. So it is not "unsupported browser" and
not a rendering quirk - it is bot detection doing exactly its job.

Getting past that means defeating an anti-bot control on someone else's
service, which is not something this repo does. `tools/assist_apply.py` opens
each posting for a person to submit, which is the workaround for the wall, not
a concession to a policy.

Scanning and scoring their board stays fine - that uses the documented public
API and is not what tripped the detector.

One practical consequence: the block is keyed to the **network**, not the
session. Once it fires, the flagged IP may see the same page in an ordinary
browser for a while.

## Capgemini, on SuccessFactors

Not Workday. `app/pages.py` cannot drive this form at all, which is why
`tools/apply_capgemini.py` is a sibling of `tools/apply_shortlist.py` rather
than a flag on it.

Ported from `career-ops/scripts/apply-capgemini.mjs`, which prefilled these
forms for months and never submitted, by policy. That policy was career-ops's,
not a property of the site, and it is dropped here: this repo already submits
to Airbus and Accenture, and a half-applied form helps nobody. What survives
the port is the field log in that file's comments — keep it as the reference
when a selector breaks.

Four things it learned the hard way, all reproduced in `tests/test_capgemini.py`:

- **The cover-letter slot arrives holding the previous application's letter.**
  It is pre-populated from the candidate profile, and unlike the CV it offers
  only "Supprimer le document" — so the stale file has to be removed before
  the right one is attached. Skipping that sends another role's letter.
- **Disability and gender gate their detail field behind a consent dropdown.**
  Answer the consent first or the detail control is disabled.
- **A combobox does not reliably open on the first click.** Every pick gets two
  attempts and its value is read back afterwards; a click landing on a closing
  popup is a silent no-op.
- **The combobox ids are positional** (`9:_input`, `13:_input`, `21:_input`…).
  They shift if Capgemini adds or removes a question, so a run reporting a
  combo "still empty" should be checked against the live form before the
  answer is blamed.

Two more that are specific to Selenium, and cost a debugging pass here:

- **XPath 1.0 cannot escape a quote inside a string literal.** French wording
  is full of apostrophes ("j'accepte", "merci d'avoir postulé"), and three
  locators failed to parse until `loc.xpath_literal` switched quote character.
  A malformed XPath fails only when Selenium runs it — part way through an
  application.
- **`send_keys` refuses a hidden file input** where Playwright's
  `setInputFiles` does not, so `capgemini.set_file_input` un-hides it first.

## Letter voice

A cover letter is a sales document. Name strengths and evidence; handle a gap
by not raising it.

This is written down because the first batch got it wrong. Four of the five
letters generated on 2026-08-22 volunteered a weakness in their closing
paragraph - "je n'ai pas encore travaillé sous DO-178", "je vise moins
d'années d'expérience que votre annonce", one opening with "je ne connais pas
encore Datasphere". They went out that way. Nothing asked for that; it was
mistaken for honesty.

Honesty is already enforced somewhere better: `verify-cv-facts.mjs` blocks any
claim the CV cannot support, so a letter cannot overstate. That makes the
absent skills exactly the thing there is no reason to mention.

One of those confessions was also simply false. The React/Node posting got
"mon socle applicatif est Python plutôt que Node.js" while `cv.md` records a
ported Express.js/TypeScript monorepo on Node 18 LTS with Jest integration
tests and a P95 cut of 63%. Read the CV before conceding anything.

Availability is **immediate**, stated without a qualifier. The earlier wording
named the end of the Airbus internship (18 November 2026), which reads as "not
really available until November" whatever the sentence in front of it says.
`app/letters.py` is fixed; career-ops' own `build-capgemini-letters.mjs` still
carries the old sentence, so letters rebuilt there will bring it back.

## Verified Capgemini behaviour

Read off the live board and form on 2026-08-22, during the first five real
submissions. Everything below corrected something that was wrong.

- **`locale=fr_FR` is not cosmetic.** Without it `/search/` answers from the
  en_US index, where "devops in France" is six Lyon postings and Toulouse has
  none. With it, the same search returns 90 Toulouse/Blagnac roles. A missing
  locale does not look like a bug, it looks like an empty job market. The
  server-side location filters (`locationsearch=`, `optionsFacetsDD_location=`)
  return **zero rows** for a city name, so `app/capgemini_board.py` filters
  locations on the parsed column instead of asking the server.
- **The document controls are not `<button>`s.** Each slot is a
  `div.attachWrapper` holding a glyphicon `<span role="button">`; the words
  "Modifier le document" / "Supprimer le document" live in a sibling
  `span.hiddenAriaContent`, not in the control. Every text-on-button locator
  matched nothing, so a run reported "no CV control found" and quietly left the
  **previous application's CV** attached. Anchor on `.qaResume` /
  `.qaCoverLetter` and `addAttachments` / `removeAttachments` - language
  neutral, and not positional the way the `NN:` ids are.
- **"ok" as a contains() needle matches "cookies".** c-**ok**-ies. The cookie
  manager is also `role="dialog"` and stays in the DOM hidden, so
  `CAP_DIALOG_CONFIRM` matched a hidden cookie button first; `UX.click` waits
  for the *first* match to become clickable, so the click timed out and
  returned quietly, the delete confirmation was never answered, and the stale
  cover letter stayed attached. Short needles use `loc.ci_equals`, and dialogs
  are scoped to `fd-dialog--active`.
- **A posting already applied to serves the register-and-apply form** to a
  signed-out visitor and only admits it after the login, when it becomes
  "Vous avez déjà postulé pour ce poste" and `isApplicationDenied=true`. Before
  it was recognised, `open_apply_form` waited out its 30s and called the
  posting closed. It now returns `"already_applied"`, which records as
  SUBMITTED - the record already defines that as "confirmed in the wizard, or
  already applied".
- **The confirmation reads "Votre candidature a été envoyée. Merci !"** None
  of the wordings carried over from career-ops matched it, so the first two
  real submissions were recorded as drafts although they had gone through. An
  unconfirmed submit now saves the page text under `output/capgemini/` rather
  than being described from memory.

Two things that follow from all this and are worth keeping in mind:

- **Clicking Postuler does submit.** The submit locators were never run live
  before this - the script they came from refused to click them on principle -
  and they work. `--inspect` remains the right first move on a changed form.
- **The cover letter slot must be cleared even when a role has no letter of
  its own**, which is what `CapgeminiForm.clear_letter` is for. And a letter
  cannot be reused across postings by name: these letters print the
  requisition number in their own body ("Cover Letter: Consultant DevOps (réf.
  1366344433)"), so a plausible file-name match sends the wrong reference to a
  recruiter. `tools/scrape_capgemini.py` maps letters by requisition id only.

## Verified Workday behaviour

Read off the live Airbus board on 2026-08-19. Prefer `data-automation-id` over
positional or text locators - ids survive re-layout and are language-neutral.

| Thing | Selector / fact |
| --- | --- |
| Apply / Continue CTA | `a[data-automation-id="adventureButton"]` - a plain `<a>`, not a button |
| Sign in (utility bar) | `button[data-automation-id="utilityButtonSignIn"]` |
| Cookie consent | `button[data-automation-id="legalNoticeAcceptButton"]` - an overlay that swallows clicks until dismissed |
| Start Your Application | three routes: `autofillWithResume`, `applyManually`, `useMyLastApplication` |
| Honeypot | `input[data-automation-id="beecatcher"]`, labelled "for robots only" - **never fill it** |

Wizard steps for a posting with no questionnaire:
`Create Account/Sign In → My Information → My Experience → Voluntary Disclosures → Review`

Two things this corrected:

- `signin_xpath = "(//button)[2]"` actually matched **"Accept Cookies"**, and
  `signin2_xpath` matched nothing. Both are fixed in `app/path.py`.
- The application form is **not served to signed-out visitors** - clicking
  through lands on Create Account. A session is required, so run
  `tools/login.py` once; it persists in the Chrome profile.

The API's `questionnaire_id` predicts the wizard: `None` means there is no
"Application Questions" step at all. Roughly 3 in 20 regular French postings
have no questionnaire; the rest split across ~3 different ones.

Two more, read off a live batch of eight applications on 2026-08-20:

- **Never assume the five-step wizard.** A posting with no questionnaire runs
  `My Experience -> Voluntary Disclosures` directly. Running the questions
  block anyway clicks Save on Voluntary Disclosures before it has been filled,
  and Workday refuses it for a missing Gender, Date of Birth and Primary
  Nationality (JR10426904). Dispatch on `JobPage.current_step()`, never on
  position in the flow.
- **Clicking Submit is not evidence of submitting.** The button sits in the
  sticky footer and a refused Review page leaves it exactly where it was, with
  nothing raised. Confirm against `loc.submitted_markers` before recording a
  success - a false success lands in `output/succ_links.txt` and the posting is
  never applied to again.
