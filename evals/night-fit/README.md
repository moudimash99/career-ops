# Night-list fit: go / stretch / no-go sample set

`golden.tsv` is the answer key for the night list's model (`freemotion-night/llm-score.mjs --eval`). Each row is a real job title with the outcome it should get:

- `go`: good enough for the night list;
- `stretch`: a digital role the candidate is under-qualified for. It's still worth applying to, but only when no go job is left (that's how the GreenPraxis cloud job happened);
- `no-go`: a hard limit, meaning hands-on physical engineering (bench or ground testing, hardware, aircraft certification), non-tech work, 8+ years or director / VP / head of, a language the candidate doesn't have, or on-site outside France.

| Column | Meaning |
|---|---|
| `id` | `g001`… Stable, so results can be compared across runs. |
| `label` | `go`, `stretch` or `no-go`. The model's overall maps to them as ≥ 3.0, 2.0–2.9 and < 2.0. |
| `labeled_by` | `claude` (a clear case, or the user's rule applied by Claude), `claude-guess` (waiting for the user), or `user` (the user's own call, which is final). |
| `title`, `company`, `location` | As recorded in `data/scan-history.tsv`, `data/freemotion-submissions.tsv` or `data/applications.md`. Blank when no record has them. |
| `source` | Where the row comes from: `submitted` (the night pipeline applied), `scan-history`, `applications`, `toulouse-test` (the 2026-09-25 HelloWork / France Travail check), `issue-3`. |
| `note` | Why it's labeled this way. |
| `text` | The start of the posting, when available. Empty rows are judged on the title alone, which is the hardest case. |

## What the rows cover

- **Go:** roles the night pipeline submitted, lead / manager / staff titles, tech roles with a people or business side (pre-sales, solutions engineering, tech consulting, IT product), and digital operations roles.
- **Stretch:** digital specialties the candidate doesn't have yet (Salesforce, ERP, Oracle DBA, computer vision, GNSS / GNC algorithms, ServiceNow…). The user's rule is that digital but under-qualified means stretch.
- **No-go:** hands-on physical engineering (aircraft testing and certification, rail, RF / telecom-radio hardware, electrical product safety), non-tech work (trades, health care, hotel, HR, procurement, audit, pure sales), the top of the ladder (VP, head of, director), a native-French linguist role, and on-site outside France.
- **The 30 once-borderline titles** (`note` starts with `unsure #`) are labeled by the user (2026-09-26).

## The bar (from the plan)

- at most 3 go or stretch jobs dropped (overall below 2);
- noise (no-go jobs kept, overall 2 or more) at most 10%;
- across two runs, the keep / drop answer is the same for at least 95% of jobs;
- across two runs, the overall score moves by at most 0.5 for at least 90% of jobs.

Go jobs scored as stretch (and the reverse) are reported for information. They only change the order, not whether a job is applied to.
