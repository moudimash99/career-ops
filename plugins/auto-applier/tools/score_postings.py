r"""Score Capgemini's open postings against the CV and report the ranking.

Stage 2 of the roadmap. Scrapes the board, fetches each posting's text, scores
it 1-100 with a local model through Ollama, and writes a ranked report.

    .venv\Scripts\python.exe tools/score_postings.py --check
    .venv\Scripts\python.exe tools/score_postings.py --top 20
    .venv\Scripts\python.exe tools/score_postings.py --top 20 --min-score 60

Advisory, not deciding: it ranks, it does not apply. Applying still goes
through tools/scrape_capgemini.py and tools/apply_capgemini.py, and a pick
still has to be defensible - which is why every row prints its reason.

With no Ollama running it falls back to the keyword model and says so on every
row, so the report is never quietly a different thing than it claims to be.
Descriptions are cached under output/capgemini/jds/, so re-scoring with a
different model costs no requests to the board.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from app import capgemini_board, employers, llm_score, record
from tools.scrape_capgemini import NEAR, QUERIES

# The CV the postings are scored against. Same source career-ops writes its
# letters from, so the scorer and the letters cannot disagree about the facts.
DEFAULT_CV = Path(
    r"C:\Users\Moudimash99\Documents\Coding\career-ops\cv.md")


def cached_description(job, cache: Path) -> str:
    """The posting text, fetched once and kept."""
    path = cache / f"{job.req_id}.txt"
    if path.is_file():
        return path.read_text(encoding="utf-8")
    text = capgemini_board.fetch_description(job.url)
    if text:
        cache.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--top", type=int, default=20,
                    help="how many postings to score (default 20)")
    ap.add_argument("--min-score", type=int, default=0,
                    help="only report at or above this score")
    ap.add_argument("--model", default=llm_score.DEFAULT_MODEL)
    ap.add_argument("--cv", default=None)
    ap.add_argument("--near", default=",".join(NEAR))
    ap.add_argument("--queries", default=",".join(QUERIES))
    ap.add_argument("--include-applied", action="store_true",
                    help="score postings already applied to as well")
    ap.add_argument("--check", action="store_true",
                    help="report whether Ollama is reachable, then stop")
    args = ap.parse_args()

    if args.check:
        models = llm_score.available_models()
        if not models:
            print("Ollama is not reachable at " + llm_score.HOST)
            print("  install it, then:  ollama pull " + llm_score.DEFAULT_MODEL)
            print("  without it, scoring falls back to the keyword model.")
            return 1
        print(f"Ollama is up at {llm_score.HOST}. Models: {', '.join(models)}")
        wanted = "yes" if llm_score.is_available(args.model) else "NOT PULLED"
        print(f"  {args.model}: {wanted}")
        return 0

    cv_path = Path(args.cv or DEFAULT_CV)
    if not cv_path.is_file():
        print(f"CV not found: {cv_path}")
        return 2
    cv = cv_path.read_text(encoding="utf-8", errors="replace")

    emp = employers.get("Capgemini")
    cache = emp.output_dir / "jds"
    store = record.Applications(emp.output_dir)

    near = [n.strip() for n in args.near.split(",") if n.strip()]
    queries = [q.strip() for q in args.queries.split(",") if q.strip()]

    using_model = llm_score.is_available(args.model)
    print(f"CV: {cv_path}")
    print("Scorer: " + (f"{args.model} via Ollama" if using_model
                        else "keyword fallback (Ollama unavailable)"))

    jobs = capgemini_board.search(queries, near)
    if not args.include_applied:
        jobs = [j for j in jobs if not store.is_submitted(j.url)]
    print(f"{len(jobs)} postings to score"
          + (" (already-applied excluded)" if not args.include_applied else ""))

    # Score the freshest first, so a --top cut keeps what is most worth acting
    # on rather than whatever the board happened to list first.
    jobs.sort(key=lambda j: (capgemini_board.parse_posted(j.posted_date)
                             or capgemini_board.parse_posted("1 janv. 1970")),
              reverse=True)
    jobs = jobs[:args.top]

    rows = []
    started = time.time()
    for n, job in enumerate(jobs, 1):
        jd = cached_description(job, cache)
        if using_model:
            result = llm_score.score(job.title, jd, cv, model=args.model)
        else:
            # Already established the daemon is down. Twenty more refused
            # connections would say nothing new and slow the scan down.
            result = llm_score.keyword_score(job.title)
        rows.append((result, job))
        print(f"  [{n}/{len(jobs)}] {result.score:3d}  {job.title[:52]}")

    rows.sort(key=lambda r: -r[0].score)
    kept = [r for r in rows if r[0].score >= args.min_score]

    print("\n" + "=" * 72)
    for result, job in kept:
        print(f"\n{result.score:3d}  {job.title}")
        print(f"     {job.location} - {job.posted_date} [{result.source}]")
        print(f"     {result.explained}")
        print(f"     {job.url}")

    out = emp.output_dir / "scores.json"
    out.write_text(json.dumps({
        "cv": str(cv_path),
        "model": args.model if using_model else llm_score.KEYWORD,
        "scored": [{
            "score": r.score, "reason": r.reason, "gaps": r.gaps,
            "source": r.source, "title": j.title, "url": j.url,
            "req_id": j.req_id, "location": j.location, "posted": j.posted_date,
        } for r, j in rows],
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n{len(kept)}/{len(rows)} at or above {args.min_score} "
          f"in {time.time() - started:.0f}s  -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
