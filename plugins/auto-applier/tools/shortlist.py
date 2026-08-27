r"""Pick the postings worth applying to, for any Workday employer.

Writes <employer output_dir>/shortlist.json, which tools/apply_shortlist.py
then works through. Kept as a separate step on purpose: a real application goes
out under the candidate's name, so the picks are written down and reviewable
before anything is submitted.

    .venv\Scripts\python.exe tools/shortlist.py --employer Airbus
    .venv\Scripts\python.exe tools/shortlist.py --employer Accenture --days 30
"""
from __future__ import annotations

import argparse
import json
import re
import sys
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

from app import employers, smartrecruiters
from app.config import JobSearchConfig
from app.record import Applications
from app.relevance import (days_since_posted, is_lower_bound,
                           posted_within, score_title)
from job_scrapper import workday_api

# SmartRecruiters company ids, for the employers not on Workday.
SMARTRECRUITERS_ID = {"Sopra Steria": "SopraSteria1"}

# Airbus uses workerSubType for contract type, so the non-student filter works
# there. Accenture repurposes the same facet for *skills* ("Java Full Stack
# Development"), where those ids mean nothing - filtering on them returns zero.
# Student contracts are excluded by title instead; see app/relevance.py.
SUBTYPE_FACET_IS_CONTRACT_TYPE = {"Airbus"}


_CITY_TAIL = re.compile(r"\s*[-–]\s*[A-Za-zÀ-ſ' ]+$")

# The candidate lives in Toulouse (31300). A role in Brest is not the same
# opportunity as the identical role in Colomiers, and Sopra Steria lists many
# of its jobs once per city - so location ranks the list rather than filtering
# it, and the cap keeps a single employer from receiving 126 applications.
HOME_AREA = ("toulouse", "colomiers", "blagnac", "labege", "labège",
             "31000", "31300", "31700", "haute-garonne", "occitanie")
# "Location Negotiable" is Accenture's wording for a role open anywhere, which
# includes Toulouse - it ranks with remote rather than with the far side of the
# country.
REMOTE = ("remote", "teletravail", "télétravail", "full remote",
          "location negotiable", "negotiable")


def location_rank(location: str, title: str = "") -> int:
    """0 = home area, 1 = remote, 2 = elsewhere. Lower sorts first."""
    flat = " ".join(f"{location} {title}".split()).casefold()
    if any(word in flat for word in HOME_AREA):
        return 0
    if any(word in flat for word in REMOTE):
        return 1
    return 2


def _dedupe_key(title: str) -> str:
    """Collapse the same role listed once per city.

    Airbus repeats a title verbatim per site; Sopra Steria appends the city
    ("... - Strasbourg", "... - Nantes"), so a plain title key leaves twelve
    copies of one job. Trailing place-name is stripped before comparing.
    """
    flat = " ".join((title or "").split()).casefold()
    return _CITY_TAIL.sub("", flat).strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--employer", default="Airbus")
    ap.add_argument("--days", type=int, default=30,
                    help="only postings at most this old (default: 30)")
    ap.add_argument("--min-score", type=int, default=3)
    ap.add_argument("--max-jobs", type=int, default=None)
    ap.add_argument("--max-picks", type=int, default=40,
                    help="cap applications per employer per run (default: 40)")
    args = ap.parse_args()

    emp = employers.get(args.employer)
    search = JobSearchConfig()

    if emp.workday:
        subtypes = (search.subtypes
                    if emp.name in SUBTYPE_FACET_IS_CONTRACT_TYPE else None)
        postings = workday_api.iter_postings(
            country=search.country, subtypes=subtypes, search_text="",
            max_jobs=args.max_jobs, tenant=emp.workday)
    elif emp.name in SMARTRECRUITERS_ID:
        postings = smartrecruiters.iter_postings(
            company=SMARTRECRUITERS_ID[emp.name], country="fr",
            max_jobs=args.max_jobs)
    else:
        print(f"No client for {emp.name}.")
        return 2

    emp.output_dir.mkdir(parents=True, exist_ok=True)
    store = Applications(emp.output_dir)

    # Seed the de-duplicator with what has already gone in. Otherwise the
    # same role listed in six cities comes back one city at a time: the run
    # excludes submitted *urls*, so once the picked listing is submitted its
    # sibling surfaces as if it were a new job. Seen on 2026-08-21, where
    # "Architecte cybersecurite" reappeared after being applied to.
    already = {_dedupe_key(e.get("title", "")) for e in store.entries.values()
               if e.get("state") == "submitted" and e.get("title")}
    by_title = {key: 1 for key in already if key}
    rows, scanned, recent, dupes = [], 0, 0, 0
    for p in postings:
        scanned += 1
        # posted_within, not a bare age comparison: "Posted 30+ Days Ago" is a
        # floor, not an age, and comparing it as 30 let 231 older postings
        # through a 30-day window on 2026-08-21.
        if not posted_within(p.posted_on, args.days):
            continue
        age = days_since_posted(p.posted_on)
        recent += 1
        score, why = score_title(p.title or "")
        if score < args.min_score or store.is_submitted(p.url):
            continue
        # The same role is listed once per site; six identical "Architecte
        # cybersecurite" postings is one job, not six applications.
        key = _dedupe_key(p.title or "")
        if key in by_title:
            # Either a second listing of a role in this run, or one already
            # applied to. Both are the same job; neither is a new application.
            by_title[key] += 1
            dupes += 1
            continue
        by_title[key] = 1
        rows.append({"score": score, "age": age, "title": p.title,
                     "url": p.url, "why": why,
                     "location": getattr(p, "location", ""),
                     # Present for SmartRecruiters; Workday applies at the
                     # posting url itself.
                     "apply_url": getattr(p, "apply_url", "") or p.url,
                     "near": location_rank(getattr(p, "location", ""), p.title),
                     "age_mark": "+" if is_lower_bound(p.posted_on) else "d"})

    # Closest to home first, then best match, then freshest. Location leads
    # deliberately: the candidate is in Toulouse, and the same Java role exists
    # in a dozen Sopra Steria cities - a weaker Toulouse posting is a better
    # opportunity than a stronger one in Le Mans.
    rows.sort(key=lambda r: (r["near"], -r["score"], r["age"]))
    dropped = max(0, len(rows) - args.max_picks)
    rows = rows[:args.max_picks]
    out = emp.output_dir / "shortlist.json"
    out.write_text(json.dumps(rows, indent=1, ensure_ascii=False),
                   encoding="utf-8")

    print(f"{emp.name}: scanned {scanned}, {recent} within {args.days} days, "
          f"{len(rows)} picked ({dupes} duplicate listings collapsed"
          + (f", {dropped} over the {args.max_picks} cap" if dropped else "")
          + ")")
    print(f"-> {out}\n")
    here = {0: "home", 1: "remote", 2: ""}
    for r in rows:
        print(f'{r["score"]:3d} {str(r["age"]) + r["age_mark"]:<5}{here[r["near"]]:<6} '
              f'{r["title"][:50]:<50} {(r["location"] or "")[:20]:<20} '
              f'{r["why"][:26]}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
