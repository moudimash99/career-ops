r"""Build the per-role cover letters and point the shortlist at them.

The sibling of tools/scrape_capgemini.py: that one decides which postings to
apply to, this one makes sure each of them has a letter written for it before
tools/apply_capgemini.py sends anything.

    .venv\Scripts\python.exe tools/build_letters.py --only 4,8,9,14
    .venv\Scripts\python.exe tools/build_letters.py --list
    .venv\Scripts\python.exe tools/build_letters.py

Content lives in data/capgemini-letters.json, keyed by requisition id, and is
rendered through career-ops' generate-cover-letter.mjs - see app/letters.py for
why that is a call rather than a reimplementation.

A posting with no letter written for it is reported, never quietly skipped:
the cover-letter slot on the form arrives holding the PREVIOUS application's
letter, so "no letter" is a real decision about what gets sent.
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

from app import employers, letters

SCRATCH = REPO / "output" / "capgemini" / "letter-payloads"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shortlist", default=None,
                    help="defaults to output/capgemini/shortlist.json")
    ap.add_argument("--only", default=None,
                    help="comma-separated tracker numbers, e.g. --only 4,14")
    ap.add_argument("--list", action="store_true",
                    help="report which shortlisted roles have a letter")
    ap.add_argument("--career-ops", default=None,
                    help="where generate-cover-letter.mjs lives")
    args = ap.parse_args()

    emp = employers.get("Capgemini")
    shortlist = Path(args.shortlist or (emp.output_dir / "shortlist.json"))
    if not shortlist.is_file():
        print(f"No shortlist at {shortlist}")
        return 2

    data = json.loads(shortlist.read_text(encoding="utf-8"))
    roles = data["roles"] if isinstance(data, dict) else data
    content = letters.load_content()

    if args.only:
        want = {int(n) for n in args.only.split(",") if n.strip()}
        roles = [r for r in roles if r.get("tracker") in want]

    if args.list:
        for r in roles:
            has = "yes" if r.get("req_id") in content else "NOT WRITTEN"
            print(f"  #{r.get('tracker'):>2}  {has:<11} {r.get('title', '')[:52]}")
        missing = [r for r in roles if r.get("req_id") not in content]
        print(f"\n{len(roles) - len(missing)}/{len(roles)} have a letter")
        return 0

    career_ops = Path(args.career_ops) if args.career_ops else letters.CAREER_OPS
    built, failed, absent = 0, 0, []

    for r in roles:
        req_id = r.get("req_id", "")
        label = f"#{r.get('tracker')} {r.get('title', '')[:46]}"
        if req_id not in content:
            absent.append(label)
            continue
        try:
            made = letters.build(req_id, SCRATCH, content, career_ops)
        except letters.LetterError as e:
            print(f"  x {label}\n      {e}")
            failed += 1
            continue
        r["letter"] = made.filename
        built += 1
        print(f"  + {label}\n      {made.path}")

    if built:
        shortlist.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nUpdated {built} shortlist rows -> {shortlist}")

    for label in absent:
        print(f"  ! no letter written for {label} - it would be sent without "
              "one (the stale letter is removed, not replaced)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
