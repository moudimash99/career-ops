r"""Scrape Capgemini's board and write output/capgemini/shortlist.json.

The counterpart to tools/shortlist.py, which only knows Workday and
SmartRecruiters. Reads app/capgemini_board.py (no browser) and scores titles
with app/relevance.py, so a pick is explainable rather than a hunch.

    .venv\Scripts\python.exe tools/scrape_capgemini.py --limit 5 --dry-run
    .venv\Scripts\python.exe tools/scrape_capgemini.py --limit 5
    .venv\Scripts\python.exe tools/apply_capgemini.py --inspect --limit 1

Documents are not in this repo. A role gets the tailored CV for its family,
resolved against --docs-root, and a cover letter only when one demonstrably
belongs to it - see `letter_for`. A letter that cannot be matched is left null
on purpose: the slot arrives holding the LAST application's letter, so a
plausible-looking guess would send another role's letter to a real recruiter.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from app import capgemini_board, employers, relevance

# What to ask the board for. Several narrow queries beat one broad one: the
# search ANDs its terms, so "devops cloud" returns neither.
QUERIES = ("devops", "cloud", "sre", "kubernetes", "infrastructure",
           "software engineer", "data", "systemes")

NEAR = ("Toulouse", "Blagnac")

# Which tailored CV a title gets. First family whose terms hit wins, so the
# order is the priority order, not alphabetical.
FAMILIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("cloud", ("devops", "cloud", "aws", "azure", "sre", "kubernetes",
               "openshift", "ansible", "infrastructure", "docker",
               "terraform", "platform")),
    ("data", ("data", "analytics", "big data", "machine learning")),
    ("fullstack", ("fullstack", "full stack", "software engineer", "logiciel",
                   "developpeur", "developpeuse", "java", "angular", "react",
                   "net", "python", "backend", "frontend", "api", "c++")),
    # Spelled the French way because the family name IS the CV file name
    # (CV_FOR_FAMILY below) and the document is
    # cv-mohammad-machaka-capgemini-systemes-fr.pdf. Keyed "systems", every
    # systems and MBSE posting was dropped with "no CV for family 'systems'" -
    # silently, and they are among the best fits on the board for a candidate
    # with a systems engineering MS.
    ("systemes", ("systemes", "systems", "mbse", "spatiaux", "electriques",
                  "embarque", "avionique")),
)

CV_FOR_FAMILY = "cv-mohammad-machaka-capgemini-{family}-fr.pdf"

# Where the tailored CVs and cover letters were generated - same default as
# tools/apply_capgemini.py.
DEFAULT_DOCS_ROOT = Path(
    r"C:\Users\Moudimash99\Documents\Coding\career-ops\output")

_STOPWORDS = {"lettre", "motivation", "capgemini", "de", "la", "le", "les",
              "et", "du", "des", "un", "une"}


def fold(text: str) -> str:
    """Accent- and case-insensitive, punctuation as spaces."""
    stripped = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(c for c in stripped if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", stripped.casefold()).strip()


def family_for(title: str) -> str:
    flat = fold(title)
    for family, terms in FAMILIES:
        if any(t in flat for t in terms):
            return family
    return ""


def letter_for(job, docs_root: Path, known: dict) -> "str | None":
    """The cover letter written for this exact posting, or None.

    One source only: a previous shortlist keyed by requisition id, where the
    mapping was made per role by hand.

    Matching on the file name was tried and removed. It looked reasonable -
    "consultant-devops" is a subset of "Consultante/Consultant Ingenieur
    DEVOPS PLM" - but these letters print the requisition number in their own
    body ("Cover Letter: Consultant DevOps (ref. 1366344433)"), so a letter
    reused across two postings arrives quoting the wrong reference at the
    recruiter. A name can look like a match; only the id is one.
    """
    return known.get(job.req_id)


def known_letters(shortlist: Path) -> dict:
    """req id -> letter file name, read off every shortlist in the directory.

    Not just the one about to be overwritten: the per-role letters were
    matched to postings by hand in earlier shortlists, and that mapping is the
    only evidence of which letter belongs to which requisition. Rewriting the
    file must not throw it away.
    """
    out = {}
    for path in sorted(shortlist.parent.glob("shortlist*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rows = data["roles"] if isinstance(data, dict) else data
        for r in rows:
            m = re.search(r"/job/[^/]+/(\d+)/?", r.get("url", ""))
            if m and r.get("letter"):
                out.setdefault(m.group(1), r["letter"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=5,
                    help="how many postings to shortlist (default 5)")
    ap.add_argument("--near", default=",".join(NEAR),
                    help="comma-separated locations, blank for anywhere")
    ap.add_argument("--queries", default=",".join(QUERIES))
    ap.add_argument("--docs-root", default=None)
    ap.add_argument("--out", default=None,
                    help="defaults to output/capgemini/shortlist.json")
    ap.add_argument("--require-letter", action="store_true",
                    help="only shortlist postings that have a tailored letter")
    ap.add_argument("--min-score", type=int, default=1)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the picks, write nothing")
    args = ap.parse_args()

    emp = employers.get("Capgemini")
    emp.output_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out or (emp.output_dir / "shortlist.json"))
    docs_root = Path(args.docs_root or DEFAULT_DOCS_ROOT)
    if not docs_root.is_dir():
        print(f"Documents directory not found: {docs_root}")
        return 2

    near = [n.strip() for n in args.near.split(",") if n.strip()]
    queries = [q.strip() for q in args.queries.split(",") if q.strip()]

    print(f"Searching {capgemini_board.SEARCH} "
          f"({len(queries)} queries, locale {capgemini_board.LOCALE})")
    jobs = capgemini_board.search(queries, near)
    print(f"  {len(jobs)} postings"
          + (f" in {', '.join(near)}" if near else ""))

    known = known_letters(out_path)
    scored = []
    for job in jobs:
        score, reason = relevance.score_title(job.title)
        family = family_for(job.title)
        if score < args.min_score or not family:
            continue
        cv = CV_FOR_FAMILY.format(family=family)
        if not (docs_root / cv).is_file():
            print(f"  ! no CV for family {family!r}, skipping: {job.title}")
            continue
        letter = letter_for(job, docs_root, known)
        if args.require_letter and not letter:
            continue
        scored.append((score, reason, job, family, cv, letter))

    # Best fit first, then freshest - a tie on score is broken by the posting
    # that has been open least long.
    def freshness(job):
        days = relevance.days_since_posted(job.posted_on)
        return days if days is not None else 9999

    scored.sort(key=lambda r: (-r[0], freshness(r[2])))
    picks = scored[:args.limit]

    roles = []
    for n, (score, reason, job, family, cv, letter) in enumerate(picks, 1):
        print(f"\n  #{n}  {job.title}")
        print(f"      {job.location} - {job.posted_on or job.posted_date} "
              f"- score {score} ({reason})")
        print(f"      cv     {cv}")
        print(f"      letter {letter or '- none matched, slot must be cleared'}")
        print(f"      {job.url}")
        roles.append({
            "tracker": n,
            "url": job.url,
            "title": job.title,
            "location": job.location,
            "req_id": job.req_id,
            "posted": job.posted_date,
            "score": score,
            "reason": reason,
            "family": family,
            "cv": cv,
            "letter": letter,
        })

    if args.dry_run:
        print(f"\nDry run - {out_path} not written.")
        return 0

    out_path.write_text(json.dumps({
        "_comment": ("Scraped from careers.capgemini.com by "
                     "tools/scrape_capgemini.py. 'cv' and 'letter' are file "
                     "names resolved against --docs-root by "
                     "tools/apply_capgemini.py."),
        "roles": roles,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWrote {len(roles)} roles -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
