# Free Motion overnight run

Applies to a list of jobs one at a time while you sleep. Each job gets a fresh AI session
(agy, or Claude Sonnet when agy runs out of quota) that reads one instruction sheet and does it.

## One-time setup

1. Copy `config/freemotion-candidate.example.md` to `config/freemotion-candidate.md` and fill it in.
   Your phone, address and answers go there, not in the scripts. This repo is public: don't commit it.
2. Put your cover-letter facts and wording rules in `config/freemotion-facts-fr.txt` and
   `config/freemotion-rules-fr.txt`.
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
node freemotion-night/usage.mjs                                   # next morning: results and tokens used
```

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
| `make-jobs.mjs` | Writes one instruction sheet per job, plus the list of URLs allowed tonight. Site notes (Welcome to the Jungle, APEC and Free-Work sign-in) go only into sheets for that site. |
| `make-pool.mjs` | Builds tonight's list from `data/scan-history.tsv`: drops what was already applied to or tried (tracker, run log), blacklisted or capped companies and jobs outside the rules; gives each job its apply route; merges duplicates keeping the easiest place to apply; writes `pool.json`, `list.json` and `merges.txt` to `tmp/fm/night/`. Before writing the list it checks each posting is still live (free ATS API, else one headless page at a time) and fills past dead or unclear links with the next jobs; skipped ones go to `dead.txt`, results are cached in `data/posting-liveness.json` (`--no-live-check` to skip). Then the model, in two steps (issue #10): titles clearly in our fields (a role group worth 1.5+ points) pass straight on; every other title gets a quick go / no-go on title, company and place only, 100 per Gemini call, stored in `data/llm-gate.tsv` and never asked again; a no-go is dropped. Every job that passed then gets its posting text (`fetch-texts.mjs`, no model): HelloWork, WTJ, Free-Work, jobposting.pro, LinkedIn, France Travail and the Greenhouse / Lever / Ashby / Workday APIs, fetched once and kept in `data/posting-text/`; a failed fetch is retried after 3 days (`misses.jsonl`); a site that gives text to under 20% of 10+ tries, or jobs left over when `--text-minutes` (default 120) runs out, each put one item in `data/agent-inbox.md`. APEC's text comes from `apec-route.mjs` instead (its pages sit behind a bot wall). Every job that passed gets the full score. Jobs with no stored fit score are sent to `llm-score.mjs`, best first, and 8+ years asked in the text drops the job. Titles with none of our role words wait for a score. The list takes go jobs first and fills any room left with stretch jobs. Scored jobs are ranked by their fit score plus small nudges (Toulouse +0.3, Paris +0.1, English +0.2, off-stack −0.5, `rankScore()` in `pool-rules.mjs`), so the model's judgment decides the order and the preferences only break near-ties. |
| `llm-score.mjs` | The fit score: one plain Gemini API call per job (never an agent). The model rates role, skills, experience, language and blockers 1-5, evidence first; the code averages them (35/25/20/10/10) into go (3+), stretch (2–2.9: under-qualified, applied to only when no go job is left) or no-go (a hard limit). Stored once per job in `data/llm-scores.tsv`. `--eval` checks it against `evals/night-fit/golden.tsv` (each answer is saved as it arrives in `tmp/fm/night/eval-<model>-partial.jsonl`, so a stopped run keeps what it has; `--batch 10` tests 10 jobs per call), `--try "<title>"` scores one job. `scoreJobsBatch()` scores 10 jobs in one call, for the Flash models (20 free calls a day each). |
| `fetch-texts.mjs` | The posting text of every job that passed the gate, before the full score (called by `make-pool.mjs`; `--texts-only` runs just this). Uses `lib/posting-fetch.mjs`, stores in `data/posting-text/`, remembers failures for 3 days, and raises a failing site or a leftover backlog in `data/agent-inbox.md`. No model. |
| `score-loop.mjs` | Keeps the Gemini API busy all day in the background: quick check on new titles, then fit scores, English first, newest first. Starts at 15 calls/min, halves on a per-minute 429 and creeps back up; the daily quota is counted per model, so when one model's is gone it moves on to the next (`MODEL_ROTATION`: the Flash-Lite models, then Flash, then Pro; a model the key cannot use is skipped), and only when every model is used up does it sleep until 09:00 Paris; `--once` stops there instead; network trouble backs off 1-30 min. The Flash and Pro models score 10 jobs per call (`--batch`). A 503 (Google overloaded) is retried once after 2 min, then that model rests `--busy-rest` minutes (30) while the next one works, since every try may use a daily call. Several loops can run side by side, one per model family (`--name`, `--oldest-first` / `--from-middle`, `--no-gate`, `--text-only`, `--parallel`): see "Scoring all day" below. `--status`, `--stop`; log in `tmp/fm/score-loop.log` (`score-loop-<name>.log`). Gemini API only (no agy, no Claude). |
| `pool-rules.mjs` | Same-job keys, Toulouse/Paris places, keep/drop and score. The role words it keeps, drops and scores by are in `config/targets.yml`; the rest (companies handled by hand, defence, seniority and language ranking) is here. |
| `site-review.mjs` | Weekly: per application site, sent vs failed over the last 7 days, with suggested sites for `data/site-blacklist.md`. |
| `apec-route.mjs` | For APEC postings: live or gone (APEC search, plain HTTP), the apply route and the full posting text (both read inside one hidden Camoufox page; the search only gives a 282-character excerpt). Runs before the full score; at most `--apec-max` (30) a night, since ~150 quick requests bring up APEC's CAPTCHA. Postings routed before texts were kept are asked once more. No model tokens. |
| `run.sh` | Goes down the list, starts one AI session per sheet, switches to Sonnet when agy is out of quota, retries network failures. |
| `record.sh` | The AI calls it after a confirmed submission. It refuses URLs not on tonight's list and notes that sound like a failure, then adds the Applied row to the tracker. |
| `imap-link.py` | Finds a verification email and prints its links (stands in for `lib/freemotion-inbox.mjs` while Gmail OAuth is broken). |
| `usage.mjs` | Per-job result and token count for a run. |
| `check-sent.py` | Did the applications really go out? Puts our records (`data/freemotion-submissions.tsv`) next to the inbox (read-only IMAP): HelloWork's "arrivée" (sent), "finalisez" (passed to the employer's site: sent only if the agent finished there), "transmise" (error) emails and employer confirmations, matched by company and, when a company has several jobs, by title. Flags every job where our record and the inbox disagree. `run.sh` runs it at the end of each run; `--fix` corrects the records (a new row per job, nothing deleted) so the not-sent ones get retried. `--days N`, `--run ID`. |
| `codex-usage.mjs` | Codex allowance per job for the current run: 5-hour and weekly % after each job, tokens, and how many jobs are left before the pause. Read only. |

The browser helpers the sheets point to live in `lib/freemotion-browser/`. Two of them
(`inventory-global.js`, `validate-global.js`) are generated from `lib/`: after changing
`lib/freemotion-inventory.mjs` or `lib/freemotion-validate.mjs`, run
`node lib/freemotion-browser/build.mjs` (the tests fail until you do).

Everything the run produces (sheets, screenshots, reports, logs) goes to `tmp/`.
