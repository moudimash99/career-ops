"""Collect Airbus job links and descriptions.

Stage 1 rewrite: this used to paginate the board with Selenium and filter on
workerSubType "Trainee / Student (Fixed Term)". It now talks to the Workday
JSON API instead - no browser, no DOM breakage - and defaults to non-student
contracts (regular / temporary / VIE).

Output layout is unchanged, so anything downstream keeps working:
    <out>/successes/YYYYMMDD_###.json
    <out>/misses/YYYYMMDD_###.json
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import urlparse, urlunparse

from app.config import JobSearchConfig
from job_scrapper import workday_api

MAX_ITEMS_PER_FILE = 10
REPO_ROOT = Path(__file__).resolve().parent


def _ensure_dirs(base: Path) -> tuple[Path, Path]:
    suc = base / "successes"
    mis = base / "misses"
    suc.mkdir(parents=True, exist_ok=True)
    mis.mkdir(parents=True, exist_ok=True)
    return suc, mis


def _today_str() -> str:
    return datetime.now().strftime("%Y%m%d")


def _norm(u: str) -> str:
    """Normalise a URL for dedupe: drop query/fragment and trailing slash."""
    if not u:
        return ""
    p = urlparse(u)
    s = urlunparse(p._replace(query="", fragment=""))
    return s[:-1] if s.endswith("/") else s


def _next_index_for_day(dir_: Path, day: str) -> int:
    max_idx = 0
    for p in dir_.glob(f"{day}_*.json"):
        try:
            idx = int(p.stem.split("_", 1)[1])
            max_idx = max(max_idx, idx)
        except (IndexError, ValueError):
            continue
    return max_idx + 1


def _chunk(items: list[dict], size: int) -> Iterable[list[dict]]:
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _write_chunks(items: list[dict], out_dir: Path, day: str,
                  start_index: int) -> list[Path]:
    written = []
    idx = start_index
    for chunk in _chunk(items, MAX_ITEMS_PER_FILE):
        path = out_dir / f"{day}_{idx:03d}.json"
        path.write_text(json.dumps(chunk, ensure_ascii=False, indent=2),
                        encoding="utf-8")
        written.append(path)
        idx += 1
    return written


def load_seen(suc_dir: Path) -> set:
    """URLs already captured in successes/*.json. Safe on first run."""
    seen = set()
    if not suc_dir.exists():
        return seen
    for p in suc_dir.glob("*.json"):
        try:
            for item in json.loads(p.read_text(encoding="utf-8")):
                u = _norm(item.get("url", ""))
                if u:
                    seen.add(u)
        except Exception:
            continue  # ignore malformed files
    return seen


def scan(output_dir: Optional[str] = None, limit: Optional[int] = None,
         skip_seen: bool = True) -> tuple[int, int]:
    """Pull matching postings and write them to dated JSON chunks."""
    cfg = JobSearchConfig()
    base_out = Path(output_dir) if output_dir else REPO_ROOT / "job_scrapper" / "output"
    suc_dir, mis_dir = _ensure_dirs(base_out)
    day = _today_str()

    seen = load_seen(suc_dir) if skip_seen else set()
    subtypes = ", ".join(cfg.subtypes)
    total = workday_api.count_jobs(cfg.country, cfg.subtypes, cfg.search_text)
    print(f"Board reports {total} postings [subtypes: {subtypes}]")
    if seen:
        print(f"{len(seen)} already captured, skipping those")

    successes: list[dict] = []
    misses: list[dict] = []
    checked = 0

    for posting in workday_api.iter_postings(
            country=cfg.country, subtypes=cfg.subtypes,
            search_text=cfg.search_text, max_jobs=None):
        if skip_seen and _norm(posting.url) in seen:
            continue
        checked += 1
        try:
            detail = workday_api.fetch_detail(posting.external_path)
            if detail.description:
                successes.append(detail.as_dict())
                print(f"[{checked}] OK   {detail.title}")
            else:
                misses.append({"url": posting.url, "error": "empty description"})
                print(f"[{checked}] MISS {posting.title} (empty)")
        except Exception as e:
            misses.append({"url": posting.url, "error": str(e)})
            print(f"[{checked}] ERR  {posting.title}: {e}")

        if limit is not None and checked >= limit:
            break

    if successes:
        for p in _write_chunks(successes, suc_dir, day,
                               _next_index_for_day(suc_dir, day)):
            print(f"  -> {p}")
    if misses:
        for p in _write_chunks(misses, mis_dir, day,
                               _next_index_for_day(mis_dir, day)):
            print(f"  -> {p}")

    print(f"Saved {len(successes)} successes, {len(misses)} misses.")
    return len(successes), len(misses)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scan the Airbus job board.")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--limit", type=int, default=None,
                        help="stop after N new postings")
    parser.add_argument("--all", action="store_true",
                        help="re-fetch postings already saved in successes/")
    args = parser.parse_args()
    scan(output_dir=args.output_dir, limit=args.limit, skip_seen=not args.all)
