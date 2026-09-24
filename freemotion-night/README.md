# Free Motion overnight run

Applies to a list of jobs one at a time while you sleep. Each job gets a fresh AI session
(agy, or Claude Sonnet when agy runs out of quota) that reads one instruction sheet and does it.

## One-time setup

1. Copy `config/freemotion-candidate.example.md` to `config/freemotion-candidate.md` and fill it in.
   Your phone, address and answers go there, not in the scripts. This repo is public: don't commit it.
2. Put your cover-letter facts and wording rules in `config/freemotion-facts-fr.txt` and
   `config/freemotion-rules-fr.txt`.
3. Email links: `.env` needs `GMAIL_MACHAKA_USER` and `GMAIL_MACHAKA_APP_PASSWORD`.

## Each night

```bash
node scan.mjs                                                     # all sources -> data/scan-history.tsv
node freemotion-night/make-pool.mjs --top 25                      # rules + merge -> tmp/fm/night/list.json
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

## What each file does

| File | Job |
|------|-----|
| `make-jobs.mjs` | Writes one instruction sheet per job, plus the list of URLs allowed tonight. Site notes (Welcome to the Jungle, APEC sign-in) go only into sheets for that site. |
| `make-pool.mjs` | Builds tonight's list from `data/scan-history.tsv`: drops what was already applied to or tried (tracker, run log), blacklisted or capped companies and jobs outside the rules; gives each job its apply route; merges duplicates keeping the easiest place to apply; writes `pool.json`, `list.json` and `merges.txt` to `tmp/fm/night/`. No model tokens. |
| `pool-rules.mjs` | The rules and word lists: same-job keys, Toulouse/Paris places, keep/drop and score. Change them here only. |
| `site-review.mjs` | Weekly: per application site, sent vs failed over the last 7 days, with suggested sites for `data/site-blacklist.md`. |
| `apec-route.mjs` | For APEC postings: live or gone (APEC search, plain HTTP) and the apply route (read inside one hidden Camoufox page). No model tokens. |
| `run.sh` | Goes down the list, starts one AI session per sheet, switches to Sonnet when agy is out of quota, retries network failures. |
| `record.sh` | The AI calls it after a confirmed submission. It refuses URLs not on tonight's list and notes that sound like a failure, then adds the Applied row to the tracker. |
| `imap-link.py` | Finds a verification email and prints its links (stands in for `lib/freemotion-inbox.mjs` while Gmail OAuth is broken). |
| `usage.mjs` | Per-job result and token count for a run. |

The browser helpers the sheets point to live in `lib/freemotion-browser/`. Two of them
(`inventory-global.js`, `validate-global.js`) are generated from `lib/`: after changing
`lib/freemotion-inventory.mjs` or `lib/freemotion-validate.mjs`, run
`node lib/freemotion-browser/build.mjs` (the tests fail until you do).

Everything the run produces (sheets, screenshots, reports, logs) goes to `tmp/`.
