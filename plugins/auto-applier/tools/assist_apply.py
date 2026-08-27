r"""Walk a shortlist in the browser, one posting at a time, for a human to submit.

Why this exists rather than another automated applier: Sopra Steria applies
through SmartRecruiters' "OneClick" app, and that app does not render under
ChromeDriver - the public job listing renders every time, only the application
endpoint comes back blank or as an "unsupported browser" page. That is a
deliberate line the site has drawn around automated submission, and this repo
does not cross it.

So the machine does the part it is good at - finding, scoring, ranking and
de-duplicating the postings, and opening each one ready to submit - and the
person does the click. Each posting is recorded as you go, so the run can be
stopped and resumed without losing your place or applying twice.

    .venv\Scripts\python.exe tools/assist_apply.py --employer "Sopra Steria"
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from app import employers
from app.driver import build_driver
from app.record import DRAFT, FAILED, SUBMITTED, Applications

PROMPT = """
  [enter] submitted it     [s] skip     [q] stop for now
> """


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--employer", default="Sopra Steria")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    emp = employers.get(args.employer)
    shortlist = emp.output_dir / "shortlist.json"
    rows = json.loads(shortlist.read_text(encoding="utf-8"))
    store = Applications(emp.output_dir)

    todo = [r for r in rows if not store.is_submitted(r["url"])][:args.limit]
    print(f"{emp.name}: {len(todo)} to go, "
          f"{len(rows) - len(todo)} already recorded\n")
    if not todo:
        return 0

    driver = build_driver(emp.profile_dir, emp.profile_name)
    try:
        for n, row in enumerate(todo, 1):
            print(f"\n{'=' * 70}\n{n}/{len(todo)}  [{row.get('score')}] "
                  f"{row.get('title', '')}")
            print(f"  {row.get('location', '')}")
            print(f"  {row.get('apply_url') or row['url']}")
            driver.get(row.get("apply_url") or row["url"])

            answer = input(PROMPT).strip().casefold()
            if answer == "q":
                print("Stopped. Re-run to pick up here.")
                break
            state = DRAFT if answer == "s" else SUBMITTED
            store.record(row["url"], state, title=row.get("title", ""),
                         note="submitted by hand" if state == SUBMITTED
                              else "skipped by hand")
            store.save()
            print(f"  recorded: {state}   ({store.summary()})")
    except (KeyboardInterrupt, EOFError):
        print("\nStopped.")
    finally:
        driver.quit()

    print(f"\n{store.summary()} -> {store.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
