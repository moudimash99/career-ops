r"""Apply to every posting in output/shortlist.json, in one browser session.

Deliberately not `main.py --source board`: the board is unfiltered, and stage 2
(the LLM scorer) does not exist yet, so `app/relevance.py` picks the postings
and writes the shortlist first. Reading the list from a file rather than
scoring inline means the picks can be reviewed - and argued with - before a
single application goes out.

    .venv\Scripts\python.exe tools/apply_shortlist.py --dry-run
    .venv\Scripts\python.exe tools/apply_shortlist.py --limit 5
    .venv\Scripts\python.exe tools/apply_shortlist.py

Every outcome lands in output/applications.json, keyed by url, so a posting
already recorded as submitted is never applied to twice.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

# Job titles carry accents and en-dashes; the Windows console is cp1252 and
# raises UnicodeEncodeError on them, which killed a run *after* it had done the
# work, at the point of printing the result. Replace what cannot be encoded.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from app import employers
from app.config import ApplicationFiles, SeleniumConfig
from app.driver import build_driver
from app.record import DRAFT, FAILED, SUBMITTED, Applications
from selenium.common.exceptions import (InvalidSessionIdException,
                                        NoSuchWindowException,
                                        WebDriverException)

from app.session import ensure_signed_in
from main import AlreadyAppliedError, apply_one, load_answers

OUTPUT_DIR = REPO / "output"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--employer", default="Airbus")
    ap.add_argument("--shortlist", default=None,
                    help="defaults to the employer's shortlist.json")
    ap.add_argument("--answers", default=None,
                    help="defaults to answers/<employer>.json, else default.json")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true",
                    help="drive the full wizard but never click Submit")
    args = ap.parse_args()

    emp = employers.get(args.employer)
    if not emp.workday:
        # The wizard in app/pages.py is Workday's. Driving SmartRecruiters
        # with it would fill nothing and click nothing, which is a far worse
        # outcome than saying so.
        print(f"{emp.name} is not on Workday - app/pages.py cannot drive it.")
        return 2

    shortlist = Path(args.shortlist or (emp.output_dir / "shortlist.json"))
    rows = json.loads(shortlist.read_text(encoding="utf-8"))
    emp.output_dir.mkdir(parents=True, exist_ok=True)
    store = Applications(emp.output_dir)

    # Skipping the already-submitted here rather than in the wizard saves a
    # page load each, and keeps the run's own log honest about what it did.
    todo = [r for r in rows if not store.is_submitted(r["url"])][:args.limit]
    done = len(rows) - len([r for r in rows if not store.is_submitted(r["url"])])
    print(f"{emp.name}: {len(todo)} to apply to, {done} already submitted")
    if not todo:
        return 0

    files = ApplicationFiles.from_env().resolved()
    print("Attaching:", *[str(f) for f in files])
    # Per employer: Accenture's five questions are nothing like Airbus's, and
    # loading the wrong file silently parked every posting as a draft.
    answers_path = Path(args.answers) if args.answers else None
    if answers_path is None:
        named = REPO / "answers" / f"{emp.name.split()[0].casefold()}.json"
        answers_path = named if named.exists() else REPO / "answers" / "default.json"
    answers = load_answers(answers_path)

    cfg = SeleniumConfig()
    driver = build_driver(emp.profile_dir, emp.profile_name)
    counts: dict[str, int] = {}
    try:
        ensure_signed_in(driver, verify_url=todo[0]["url"], employer=emp)
        for n, row in enumerate(todo, 1):
            url, title = row["url"], row.get("title", "")
            print(f"\n########## {n}/{len(todo)}  [{row.get('score')}] {title}")
            try:
                ok = apply_one(driver, url, files, dry_run=args.dry_run,
                               route="last", answers=answers,
                               source_answer=emp.source_answer)
                state = SUBMITTED if ok else DRAFT
                store.record(url, state, title=title)
            except AlreadyAppliedError:
                print("  already applied - skipping")
                state = SUBMITTED
                store.record(url, state, title=title, note="already applied")
            except (InvalidSessionIdException, NoSuchWindowException) as e:
                # The browser died. Everything after this would "fail"
                # instantly without being attempted - on 2026-08-21 that
                # marked 22 untouched postings as failed in the same second.
                # Rebuild and retry this one rather than burning the list.
                print(f"\n[driver] browser lost ({type(e).__name__}); "
                      "restarting and retrying this posting")
                try:
                    driver.quit()
                except Exception:
                    pass
                driver = build_driver(emp.profile_dir, emp.profile_name)
                ensure_signed_in(driver, verify_url=url, employer=emp)
                try:
                    ok = apply_one(driver, url, files, dry_run=args.dry_run,
                                   route="last", answers=answers,
                                   source_answer=emp.source_answer)
                    state = SUBMITTED if ok else DRAFT
                    store.record(url, state, title=title)
                except Exception as again:
                    state = FAILED
                    store.record(url, state, title=title,
                                 note=f"after restart: {type(again).__name__}"[:300])
                    traceback.print_exc()
            except WebDriverException as e:
                if "invalid session id" in str(e).lower() or                         "disconnected" in str(e).lower():
                    print(f"\n[driver] browser lost ({type(e).__name__}); "
                          "stopping so the rest is not marked failed untried")
                    store.record(url, FAILED, title=title,
                                 note="browser lost mid-run")
                    store.save()
                    raise
                state = FAILED
                store.record(url, state, title=title,
                             note=f"{type(e).__name__}: {e}"[:300])
                traceback.print_exc()
            except Exception as e:
                # One bad posting must not end the run: the whole point of an
                # unattended pass is that it gets through the rest of the list.
                state = FAILED
                store.record(url, state, title=title,
                             note=f"{type(e).__name__}: {e}"[:300])
                traceback.print_exc()
            counts[state] = counts.get(state, 0) + 1
            store.save()
            print(f"[{datetime.now():%H:%M:%S}] {state}  ({store.summary()})")
    finally:
        driver.quit()

    print("\n" + "=" * 68)
    for state in (SUBMITTED, DRAFT, FAILED):
        if counts.get(state):
            print(f"  {counts[state]:3d}  {state}")
    print(f"\n{store.summary()}  -> {store.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
