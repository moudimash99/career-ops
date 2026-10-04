# Free Motion overnight run

Applies to a list of jobs one at a time while you sleep. Each job gets a fresh AI session
(agy, or Claude Sonnet when agy runs out of quota) that reads one instruction sheet and does it.

## One-time setup

1. Copy `config/freemotion-candidate.example.md` to `config/freemotion-candidate.md` and fill it in.
   Your phone, address and answers go there, not in the scripts. This repo is public: don't commit it.
2. Put the facts and wording rules for free-text questions in `config/freemotion-facts-fr.txt` and
   `config/freemotion-rules-fr.txt`. (Cover letters are not written from these: see "CV and letter".)
   Tailored CVs need RenderCV: `pip install -r requirements-cv.txt`.
3. Email links: `.env` needs `GMAIL_MACHAKA_USER` and `GMAIL_MACHAKA_APP_PASSWORD`.
   The fit score needs `GEMINI_API_KEY` (a free key from aistudio.google.com); `GEMINI_MODEL` picks the model.
4. Accounts you made by hand (Free-Work): `node lib/freemotion-credentials.mjs save --domain www.free-work.com --email <you>`.
   It asks for the password and keeps it in `data/freemotion-credentials/`, which git never sees.

Which jobs we look for (search words, title words, what is dropped, points, the years limit and the
`candidate:` block the model scores against) is `config/targets.yml`, the one list the scanner and
`make-pool.mjs` both read. `node targets.mjs check` shows what `portals.yml` still duplicates.

Before trusting the model with a night, check it against the go / no-go sample set:
`node freemotion-night/llm-score.mjs --eval evals/night-fit/golden.tsv` (about 190 calls of the
~500 a day; the bar is in `evals/night-fit/README.md`).

## Each night

```bash
node scan.mjs                                                     # all sources -> data/scan-history.tsv
node freemotion-night/make-pool.mjs --top 25                      # rules + quick gate + posting text + full score + merge + live-link check -> tmp/fm/night/list.json
                                                                  #   --llm-max 5000 (full scores), --no-llm, --rpm 12
                                                                  #   --text-minutes 120, --no-texts, --texts-only (text backlog only, no model)
                                                                  #   --scorer agy: quick check + fit score through agy's Claude allowance
                                                                  #   (claude-sonnet-4-6, 10 jobs per call, --parallel 3) when the Gemini quota is gone
                                                                  #   --scorer claude: the same through Haiku on the Claude plan, every tool off, 20 per call (--batch)
                                                                  #   --score-since today|YYYY-MM-DD: new fit scores only for jobs first found from that day
node freemotion-night/make-jobs.mjs tmp/fm/night/list.json <firstNumber>   # writes tmp/fm/night/job-<N>.md
bash freemotion-night/run.sh <firstNumber> <secondNumber> ...     # applies, one job at a time
                                                                  #   HEADFUL=1 bash freemotion-night/run.sh ...: the browser window is visible
node freemotion-night/usage.mjs                                   # next morning: results and tokens used
```

## Watching the browser (visible window)

The browser is Camoufox with no window by default. To watch a run, or step in:

```bash
HEADFUL=1 bash freemotion-night/run.sh <numbers>
```

The window is visible from the first job and hidden again when the run ends, on Ctrl+C, or, if
the run was killed outright, at the start of the next run. `lib/freemotion-browser-mode.mjs` does
the switch: it changes only `"headless"` in `config/playwright-mcp-camoufox.json`, the file every
driver's browser reads (agy, Claude and Copilot through `.mcp.json`, codex through
`.codex/config.toml`). The disguise, the Camoufox program and the MCP version stay as they are.
Don't use `node lib/freemotion-engine-config.mjs --apply` for this: it rewrites `.mcp.json` without
the disguise. By hand: `node lib/freemotion-browser-mode.mjs show | headful | headless | restore`.

To watch ONE job and approve every step:

```bash
WATCH=1 bash freemotion-night/run.sh <number>                  # watch window on this PC
WATCH=1 WATCH_HOST=lan bash freemotion-night/run.sh <number>   # also from other machines (keyed link)
```

The browser is visible and the **watch window** opens in your web browser (`control.mjs`, port 4777):

- Every action that puts input into the page (click, type, choose, upload, open a page, page code, send)
  waits there for you, in plain words with agy's reason and ⚠ warnings (a blind pick by arrow keys, a
  click done with code, the real send). **Continue** lets it happen; **Don't do it** + a message sends
  agy your instruction instead (give it the method, not the answer); **Stop everything** ends agy and
  its browser at once and records the job as stopped. Reading the page and screenshots pass without asking.
- "Page now" (a screenshot the gate takes for you when an action is shown and after each one you allow)
  and "Last screenshot agy saw"; links to the CV and the cover letter this job sends.
- The same log, in plain text, in `tmp/fm/night/watch-<number>.log`.

How the waiting works (`browser-gate.mjs`, which agy's browser goes through for that run only): agy gives
up on a browser call after 3 minutes, so after 2.5 minutes the gate tells it to ask again; between asks it
is idle and uses no tokens. When the form check finds empty fields, an allowed action fails or the send
button is not found, the gate adds a fresh read of the page to agy's answer. A refusal written for an
action agy has dropped answers its next one. The previous job's gate record is archived in
`tmp/fm/gate/archive/` when a new one starts.

agy's own terminal window (`agy -i`) opens too: approve in the watch window, not there. When agy writes
DONE, close its window and the run records and checks as usual. agy and agy-sonnet only. Don't edit
`run.sh` while a run is going: bash reads it as it goes, and an edit mid-run garbles the rest of the run.

Every agy job, watched or not, prints its steps live in the run's output and keeps them in
`tmp/fm/night/actions-<number>.log`: agy's own label for each step, what it acted on, `»` its own words,
`→` what the page or command answered, `✗` errors. `node freemotion-night/agent-log.mjs --job <number>`
prints it again later (from agy's transcript in `~/.gemini/antigravity-cli/brain/`).

agy's browser is in agy's own MCP list, not in `.mcp.json`. On a new machine add it once:
`agy mcp add playwright npx -y @playwright/mcp@<version in .mcp.json> --config <repo>/config/playwright-mcp-camoufox.json`
(`agy mcp list` shows it). `run.sh` checks this first and runs without agy when it is missing.

Things to know:
- A Claude or agy session you open during a HEADFUL=1 run gets a visible window too; one already
  open keeps the mode it started with.
- `tmp/fm/usage/night-runs.tsv` has the window mode as its 5th column, to compare job times.
- APEC's text fetch (`apec-route.mjs`) starts its own Camoufox and stays hidden; nobody watches it.

`node freemotion-night/browser-trial.mjs` measures both modes through the same MCP server the
drivers use (a copy of the config, its own browser profile): launch, clicks, slow typing and a
screenshot on a local page, then opening five application sites (it only opens pages). Results go
to `tmp/fm/browser-trial.tsv`. Two runs on 2026-10-02 (median ms):

| | launch + first page | click | type 20 chars slowly | open a site | failed steps |
|---|---|---|---|---|---|
| hidden | 4,865–5,175 | 542–543 | 556–559 | 1,292–2,355 | 1 per run (France Travail, below) |
| visible | 5,381–7,245 | 587–601 | 559–570 | 1,518–1,534 | 1 per run (France Travail, below) |

So the visible window is usable on this machine: 0.5 to 2 s more to start, about 50 ms more per
click, no bot wall on HelloWork, WTJ, Free-Work, France Travail or APEC in either mode. The earlier
note of 13 s to 2 min per click did not come back. The one failure, in both modes: France Travail's
load right after Free-Work is cancelled by Free-Work rewriting its own address (the trial now tries
once more, and France Travail then loads in about 1 s).
A real application run with HEADFUL=1 is the next check before making visible the default.

`<list.json>` is an array of `{co, title, url, english, toulouse, paris}`; `make-pool.mjs` writes it.

Each week: `node freemotion-night/site-review.mjs` shows how agy's attempts ended per application
site; add the sites to give up on to `data/site-blacklist.md`.

Practice run: add `--rehearsal` (and its own `--run-id`) to `make-jobs.mjs`. The agent fills everything,
stops before the final submit, and records the outcome `rehearsal`, which does not block a real attempt later.

APEC postings: `node freemotion-night/apec-route.mjs --in <rows.json>` checks which are still live and how each
takes applications (`URL_ONLY` = a partner site, `EMAIL_ONLY` = on APEC itself, behind the APEC sign-in).

## Scoring all day

Google counts the free allowance per model, so three loops run side by side, each on its own
models and its own part of the queue (they skip a job the others already scored):

```bash
# 1. Flash-Lite (~500 calls a day each, one job per call): newest first, does the quick title check
node freemotion-night/score-loop.mjs --models gemini-3.5-flash-lite,gemini-3.1-flash-lite
# 2. Flash (20 calls a day each, 10 jobs per call): from the middle of the queue
node freemotion-night/score-loop.mjs --name flash --models gemini-3.8-flash,gemini-3.5-flash,gemini-3.6-flash,gemini-3.7-flash --from-middle --no-gate --rpm 5 --rpm-max 8
# 3. Gemma 4 31B (slow, ~30 s a call, limited per minute): oldest first, only jobs with posting text
node freemotion-night/score-loop.mjs --name gemma --model gemma-4-31b-it --oldest-first --no-gate --text-only --parallel 2 --busy-rest 3 --rpm 6 --rpm-max 10
```

On Windows start each hidden with `Start-Process node -ArgumentList ... -WindowStyle Hidden`.
`--name flash --status` / `--name gemma --stop` for loops 2 and 3. Notes from 2026-09-30:
`gemma-4-26b-a4b-it` gets stuck repeating words until it runs out of length (a third of its
answers broke), so use 31B. `gemini-2.5-flash-lite` answers 404 (closed to new users). Pro is not free.

## What each file does

| File | Job |
|------|-----|
| `make-jobs.mjs` | Writes one instruction sheet per job (and the same job as `job-<N>.json`), plus the list of URLs allowed tonight. Site notes (Welcome to the Jungle, APEC and Free-Work sign-in) go only into sheets for that site. A sheet starts with the generic CV and no letter. |
| `prepare-docs.mjs` | **CV and letter.** Run by `run.sh` right before each job: draws (or recalls) the posting's arms (CV generic 15 / loose 50 / strict 35, letter none 15 / short 35 / full 50), has the CV written and rendered to one page and the letter written and checked, and puts both into the sheet, so the agent only uploads and pastes. A refused CV gets one revision; a refused `full` letter tries `short`. Whatever cannot be made falls back to the generic CV / no letter and is recorded as `fallback`. Kept in `output/fm/<slug>-<key>/` and reused on a retry. `<num> --required-letter` and `<num> --letter-pdf` are for the agent (a required letter field with no letter; a field that wants a file). `--sync` marks `sent` in both ledgers for submitted jobs (run.sh does it after each one; run it by hand after `check-sent.py --fix`). Read the results with `node lib/cv-experiment.mjs report --summary` and `node lib/letter-experiment.mjs report --summary`. |
| `make-pool.mjs` | Builds tonight's list from `data/scan-history.tsv`: drops what was already applied to or tried (tracker, run log), blacklisted or capped companies and jobs outside the rules; gives each job its apply route; merges duplicates keeping the easiest place to apply; writes `pool.json`, `list.json` and `merges.txt` to `tmp/fm/night/`. Before writing the list it checks each posting is still live (free ATS API, else one headless page at a time) and fills past dead or unclear links with the next jobs; skipped ones go to `dead.txt`, results are cached in `data/posting-liveness.json` (`--no-live-check` to skip). Then the model, in two steps (issue #10): titles clearly in our fields (a role group worth 1.5+ points) pass straight on; every other title gets a quick go / no-go on title, company and place only, 100 per Gemini call, stored in `data/llm-gate.tsv` and never asked again; a no-go is dropped. Every job that passed then gets its posting text (`fetch-texts.mjs`, no model): HelloWork, WTJ, Free-Work, jobposting.pro, LinkedIn, France Travail and the Greenhouse / Lever / Ashby / Workday APIs, fetched once and kept in `data/posting-text/`; a failed fetch is retried after 3 days (`misses.jsonl`); a site that gives text to under 20% of 10+ tries, or jobs left over when `--text-minutes` (default 120) runs out, each put one item in `data/agent-inbox.md`. APEC's text comes from `apec-route.mjs` instead (its pages sit behind a bot wall). Every job that passed gets the full score. Jobs with no stored fit score are sent to `llm-score.mjs`, best first, and 8+ years asked in the text drops the job. Titles with none of our role words wait for a score. The list takes go jobs first and fills any room left with stretch jobs. Scored jobs are ranked by their fit score plus small nudges (Toulouse +0.3, Paris +0.1, English +0.2, off-stack −0.5, `rankScore()` in `pool-rules.mjs`), so the model's judgment decides the order and the preferences only break near-ties. |
| `llm-score.mjs` | The fit score: one plain Gemini API call per job (never an agent). The model rates role, skills, experience, language and blockers 1-5, evidence first; the code averages them (35/25/20/10/10) into go (3+), stretch (2–2.9: under-qualified, applied to only when no go job is left) or no-go (a hard limit). Stored once per job in `data/llm-scores.tsv`. `--eval` checks it against `evals/night-fit/golden.tsv` (each answer is saved as it arrives in `tmp/fm/night/eval-<model>-partial.jsonl`, so a stopped run keeps what it has; `--batch 10` tests 10 jobs per call), `--try "<title>"` scores one job. `scoreJobsBatch()` scores 10 jobs in one call, for the Flash models (20 free calls a day each). |
| `fetch-texts.mjs` | The posting text of every job that passed the gate, before the full score (called by `make-pool.mjs`; `--texts-only` runs just this). Uses `lib/posting-fetch.mjs`, stores in `data/posting-text/`, remembers failures for 3 days, and raises a failing site or a leftover backlog in `data/agent-inbox.md`. No model. |
| `score-loop.mjs` | Keeps the Gemini API busy all day in the background: quick check on new titles, then fit scores, English first, newest first. Starts at 15 calls/min, halves on a per-minute 429 and creeps back up; the daily quota is counted per model, so when one model's is gone it moves on to the next (`MODEL_ROTATION`: the Flash-Lite models, then Flash, then Pro; a model the key cannot use is skipped), and only when every model is used up does it sleep until 09:00 Paris; `--once` stops there instead; network trouble backs off 1-30 min. The Flash and Pro models score 10 jobs per call (`--batch`). A 503 (Google overloaded) is retried once after 2 min, then that model rests `--busy-rest` minutes (30) while the next one works, since every try may use a daily call. Several loops can run side by side, one per model family (`--name`, `--oldest-first` / `--from-middle`, `--no-gate`, `--text-only`, `--parallel`): see "Scoring all day" below. `--status`, `--stop`; log in `tmp/fm/score-loop.log` (`score-loop-<name>.log`). Gemini API only (no agy, no Claude). |
| `pool-rules.mjs` | Same-job keys, Toulouse/Paris places, keep/drop and score. The role words it keeps, drops and scores by are in `config/targets.yml`; the rest (companies handled by hand, defence, seniority and language ranking) is here. |
| `site-review.mjs` | Weekly: per application site, sent vs failed over the last 7 days, with suggested sites for `data/site-blacklist.md`. |
| `apec-route.mjs` | For APEC postings: live or gone (APEC search, plain HTTP), the apply route and the full posting text (both read inside one hidden Camoufox page; the search only gives a 282-character excerpt). Runs before the full score; at most `--apec-max` (30) a night, since ~150 quick requests bring up APEC's CAPTCHA. Postings routed before texts were kept are asked once more. No model tokens. |
| `run.sh` | Goes down the list, starts one AI session per sheet, moves to the next driver when one is out of quota (agy, then codex, then the second Claude account, then copilot), retries network failures. `HEADFUL=1` shows the browser window for that run. |
| `browser-trial.mjs` | Times the browser hidden vs visible through the drivers' own MCP server (launch, clicks, typing, five application sites; opens pages only). Rows in `tmp/fm/browser-trial.tsv`. |
| `browser-gate.mjs` | WATCH=1 only: the browser server agy talks to, in front of the real one. Holds every input into the page until the person decides in the watch window; reads pass. Adds a fresh page read to agy's answer on a block; screenshots for the person. `gate-describe.mjs` puts each action in plain words and flags risky ones. |
| `control.mjs` | WATCH=1 only: the watch window (local web page): the action waiting, Continue / Don't do it + message / Stop, the plain log (`tmp/fm/night/watch-<num>.log`), screenshots, CV and letter links. `--host 0.0.0.0` (WATCH_HOST=lan) with a keyed link; `--keep` restarts it mid-job without clearing. |
| `agent-log.mjs` | agy's steps from its own transcript, one line each (its label, the target, its NEXT/WHY words, the answer); live with `--follow`. run.sh keeps one per job in `tmp/fm/night/actions-<num>.log`. `agy-transcript.mjs` finds and reads agy's transcripts. |
| `record.mjs` | The AI calls it after a confirmed submission (`record.sh` only forwards to it: from PowerShell or cmd, `bash` can be WSL's, which cannot run repo scripts). It refuses URLs not on tonight's list and notes that sound like a failure, then adds the Applied row to the tracker. |
| `imap-link.py` | Finds a verification email and prints its links (stands in for `lib/freemotion-inbox.mjs` while Gmail OAuth is broken). |
| `usage.mjs` | Per-job result and token count for a run. |
| `check-sent.py` | Did the applications really go out? Puts our records (`data/freemotion-submissions.tsv`) next to the inbox (read-only IMAP): HelloWork's "arrivée" (sent), "finalisez" (passed to the employer's site: sent only if the agent finished there), "transmise" (error) emails and employer confirmations, matched by company and, when a company has several jobs, by title. Flags every job where our record and the inbox disagree. `run.sh` runs it at the end of each run; `--fix` corrects the records (a new row per job, nothing deleted) so the not-sent ones get retried. `--days N`, `--run ID`. |
| `codex-usage.mjs` | Codex allowance per job for the current run: 5-hour and weekly % after each job, tokens, and how many jobs are left before the pause. Read only. |

The browser helpers the sheets point to live in `lib/freemotion-browser/`. Two of them
(`inventory-global.js`, `validate-global.js`) are generated from `lib/`: after changing
`lib/freemotion-inventory.mjs` or `lib/freemotion-validate.mjs`, run
`node lib/freemotion-browser/build.mjs` (the tests fail until you do).

Everything the run produces (sheets, screenshots, reports, logs) goes to `tmp/`.
