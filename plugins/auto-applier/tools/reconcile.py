r"""Rebuild output/applications.json from what Workday actually says.

The local record is a cache, and caches drift: a run that dies between the
Submit click and the write leaves a submitted application recorded as failed,
and before app/record.py existed the .txt files were append-only, so a retry
that succeeded could not overwrite the failure it replaced.

Rather than anyone editing those files by hand - which is guesswork, and the
kind of guesswork that makes you re-apply to a job you already applied to -
this visits each known posting and reads the real state off the page. Workday
is the authority; this file just writes down what it says.

    .venv\Scripts\python.exe tools/reconcile.py --dry-run   # show the drift
    .venv\Scripts\python.exe tools/reconcile.py             # fix it

Read-only against the site: it clicks nothing but the cookie banner.
"""
from __future__ import annotations

import argparse
import sys
import time
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

from app.config import SeleniumConfig
from app.driver import build_driver
from app.pages import JobPage
from app.record import DRAFT, FAILED, SUBMITTED, Applications
from app.session import ensure_signed_in
from app.ux import UX

OUTPUT_DIR = REPO / "output"

# Workday's posting state -> what we record, and why.
FROM_POSTING_STATE = {
    "submitted": (SUBMITTED, "confirmed on the posting"),
    "draft": (DRAFT, "draft open on Workday"),
    # No Apply/Continue history at all: whatever we thought happened here,
    # nothing is on file, so it belongs in the retry list.
    "new": (FAILED, "nothing started on Workday"),
}


def known_links(store: Applications) -> list[str]:
    """Every posting we have ever recorded, store and legacy files alike.

    The .txt files are read too so the first reconcile after switching to the
    keyed store picks up everything the append-only era left behind.
    """
    links = list(store.entries)
    seen = set(links)
    for name in ("succ_links.txt", "missed_links.txt", "skipped_links.txt"):
        path = OUTPUT_DIR / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            url = line.strip()
            if url and url not in seen:
                seen.add(url)
                links.append(url)
    return links


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="report the drift without writing anything")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    cfg = SeleniumConfig()
    store = Applications(OUTPUT_DIR)
    links = known_links(store)[:args.limit]
    if not links:
        print("Nothing recorded yet - nothing to reconcile.")
        return 0
    print(f"Reconciling {len(links)} posting(s) against Workday\n")

    changes, unreadable = [], []
    driver = build_driver(cfg.user_data_dir, cfg.profile_name)
    try:
        ensure_signed_in(driver, verify_url=links[0])
        for url in links:
            driver.get(url)
            page = JobPage(UX(driver, cfg.timeout_s, cfg.micro_wait_s))
            page.wait_for_posting()
            page.dismiss_cookie_banner()
            time.sleep(1)
            live = page.posting_state()

            was = store.state_of(url) or "(unrecorded)"
            if live not in FROM_POSTING_STATE:
                # Expired or pulled postings read as "unknown". Overwriting a
                # confirmed submission with a guess would be worse than saying
                # so and leaving the entry alone.
                unreadable.append((url, was))
                print(f"  ?  {store.entries.get(url, {}).get('jr') or url[-24:]}"
                      f"  unreadable ({live}) - left as {was}")
                continue

            state, why = FROM_POSTING_STATE[live]
            mark = "=" if state == was else "~"
            label = store.entries.get(url, {}).get("jr") or url[-24:]
            print(f"  {mark}  {label}  {was} -> {state}  ({why})")
            if state != was:
                changes.append((url, was, state))
            if not args.dry_run:
                store.record(url, state, note=why)
                # record() counts an attempt; reconciling is not one.
                store.entries[url]["attempts"] -= 1
    finally:
        driver.quit()

    print(f"\n{len(changes)} correction(s), {len(unreadable)} unreadable")
    for url, was, now in changes:
        print(f"  {was} -> {now}: {url}")

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    store.save()
    print(f"\n{store.summary()}")
    print(f"written -> {store.path}")
    for path in store.write_views():
        print(f"rebuilt -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
