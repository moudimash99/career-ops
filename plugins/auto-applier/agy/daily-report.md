# Daily job report — what to do

You are running unattended on Mohammad's Windows laptop, in
`C:\Users\Moudimash99\Documents\GitHub\AirBusAutoApplier`. Produce one report:
what to apply to today, plus a diagnosis of anything that broke on the last
run.

Read `AGENTS.md` first. It is the authority on how this repo works.

## Rules

- **Never open a browser.** Do not run `main.py`, `tools/apply_*.py`,
  `tools/login.py`, `tools/assist_apply.py`, or `tools/run_all.py` without
  `--search-only`. Mohammad may be sitting in that Chrome window; taking it
  over mid-session is worse than a missing report.
- **Never submit an application.** You recommend; he runs the applier himself.
- **Never commit to `master` except files under `reports/`.** Code changes go
  on a local branch. Do not push a branch to master.
- Python is `.venv\Scripts\python.exe`. A bare `python` is the wrong one.

## Step 1 — refresh the boards

    .venv\Scripts\python.exe tools\run_all.py --search-only --no-push

Opens no browser. Rewrites each employer's shortlist and appends this run to
`data\last-runs.json`. Takes about two minutes. If it exits non-zero, read
`output\runs\latest-errors.log` and carry on — a failed search is itself
something to report, not a reason to stop.

Where the picks land:

| Employer | File |
| --- | --- |
| Airbus | `output\shortlist.json` |
| Accenture | `output\accenture\shortlist.json` |
| Capgemini | `output\capgemini\picks.json` |

Sopra Steria is deliberately absent from that run — DataDome blocks its apply
form, so the repo never submits there (AGENTS.md explains it). Scan its board
anyway with `app\smartrecruiters.py`: those are roles Mohammad applies to by
hand, and they belong in the report flagged **manual**.

## Step 2 — drop what he has already applied to

`output\**\applications.json` is the record and
`app.record.Applications.is_submitted` is the check. The shortlist tools
already apply it, so this is a verification rather than a filter you build:
several hundred postings are recorded submitted, so if today's picks exclude
nothing at all, something is broken — and that is a finding for the report,
not something to paper over.

## Step 3 — score them, and say why

The CV is `C:\Users\Moudimash99\Documents\Coding\career-ops\cv.md`. `data\cv.md`
here is a snapshot of it; prefer the career-ops original, and if the two differ,
say so — the cover letters are generated from the original.

`app\llm_score.py` scores through a local Ollama daemon that **is not installed
on this machine**, and `app\relevance.py` only ever reads the title. **You are
the model.** Fetch each posting's description and score it yourself, 1-100, on
the scale in `app\llm_score.py`'s `PROMPT` constant.

- Be severe about required technologies the CV does not evidence, and about
  the years of experience demanded. Do not reward shared keywords.
- **Every score carries its reason.** That rule is in AGENTS.md and it applies
  to you: a pick has to be defensible, or there is no way to tell a good
  shortlist from a plausible-looking one.
- Score the ~25 most recently posted unapplied roles across the four
  employers. Not the whole board.
- Descriptions cache under `output\capgemini\jds\`. Reuse them rather than
  refetching.

## Step 4 — what broke last time

`data\last-runs.json` holds the last ten runs' failures: stage exit codes,
tracebacks trimmed to the last frame plus the exception, and every posting left
`draft` or `failed`. `output\runs\latest-errors.log` is the newest run in full.

- Date every finding against the run's `at` field. If the newest run is more
  than a few days old, say so — you are describing an old failure, not a
  current one.
- No failures means one line saying so. Do not invent work.
- AGENTS.md's "Verified Capgemini behaviour" and "Verified Workday behaviour"
  sections record selectors and traps confirmed against the live sites. Check a
  suspected selector break against them before rewriting anything.
- Confident in a fix? Branch `fix/<short-name>`, commit it there, and run
  `.venv\Scripts\python.exe -m pytest tests\ -q` — 297 tests pass today, and a
  fix that breaks the suite is not a fix. Leave the branch local and name it in
  the report. A selector you cannot verify against the live form is a
  **hypothesis, not a fix** — say so in those words.
- Not confident? Diagnosis in the report, no branch.

## Step 5 — write it

`reports\YYYY-MM-DD.md`, today's local date, with these sections:

- **Apply to today** — ranked, highest first, cut at 60. Score, title,
  employer, location, posted date, url, one sentence of why. Mark Sopra Steria
  rows **manual**.
- **Skipped and why** — notable low scorers, one line each.
- **What broke** — Step 4's findings, dated, naming any branch you left behind.
- **Routine health** — anything that stopped you: a board that would not
  answer, a stale record, a missing file. Be specific. A report that hides its
  own gaps is worse than no report.

Then commit **only** the reports pathspec and push:

    git add -- reports
    git commit -m "Daily report YYYY-MM-DD"
    git push origin HEAD:master

If the working tree holds unrelated edits, still commit only that pathspec —
never sweep up half-finished work. If the push fails, say so in your final
output; the file on disk is the deliverable either way.

Finish by printing the top five picks and the path to the report.
