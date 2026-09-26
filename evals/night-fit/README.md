# Night-list fit: go / no-go sample set

`golden.tsv` is the answer key for the night list's model (`freemotion-night/llm-score.mjs --eval`). Each row is a real job title with the verdict it should get:

- `go`: good enough for the night list;
- `no-go`: not one of the candidate's jobs.

| Column | Meaning |
|---|---|
| `id` | `g001`… Stable, so results can be compared across runs. |
| `label` | `go` or `no-go`. |
| `labeled_by` | `claude` (a clear case), `claude-guess` (unsure, waiting for the user), or `user` (the user's own call, which is final). |
| `title`, `company`, `location` | As recorded in `data/scan-history.tsv`, `data/freemotion-submissions.tsv` or `data/applications.md`. Blank when no record has them. |
| `source` | Where the row comes from: `submitted` (the night pipeline applied), `scan-history`, `applications`, `toulouse-test` (the 2026-09-25 HelloWork / France Travail check), `issue-3`. |
| `note` | Why it's labeled this way. |
| `text` | The start of the posting, when available. Empty rows are judged on the title alone, which is the hardest case. |

## What the rows cover

- **Go:** roles the night pipeline submitted, lead / manager / staff titles, and tech roles with a people or business side (pre-sales, solutions engineering, tech consulting, IT product).
- **No-go:** work that isn't digital (aircraft, rail, RF hardware, trades, HR, sales), digital specialties the candidate doesn't have (Salesforce, ERP, Oracle DBA), and the top of the ladder (VP, head of, director).
- **Unsure (`claude-guess`):** the 30 borderline titles. When the user validates or flips one, change `labeled_by` to `user`.

## The bar (from the plan)

- at most 3 go jobs missed;
- noise (no-go jobs let through) at most 10%;
- across two runs, the go/no-go answer is the same for at least 95% of jobs;
- across two runs, the overall score moves by at most 0.5 for at least 90% of jobs.
