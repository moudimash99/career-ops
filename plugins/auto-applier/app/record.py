"""What happened to each posting, keyed by url rather than appended.

The three `output/*_links.txt` files were append-only, which meant they could
never un-say anything. A posting that failed once and succeeded on the retry
stayed in `missed_links.txt` for good, and every re-run added another copy of
the same url - by 2026-08-20 that file held 18 lines describing 5 postings, one
of them ("Application Manager for SE") already submitted.

An append log cannot express "this is now true instead"; that is what a keyed
store is for. Each posting has exactly one entry here, and a later outcome
overwrites the earlier one. The .txt files are still written, but they are
derived views - regenerated from the store every time, so they self-heal rather
than accumulating history that has stopped being true.

Workday remains the authority. tools/reconcile.py reads the real state off the
site and rewrites this store from it.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

STORE_NAME = "applications.json"

# The outcome of one attempt, and which derived file it feeds.
SUBMITTED = "submitted"   # confirmed in the wizard, or already applied
DRAFT = "draft"           # reached Workday but did not submit
FAILED = "failed"         # blew up part way through
STATES = (SUBMITTED, DRAFT, FAILED)

VIEWS = {
    "succ_links.txt": (SUBMITTED,),
    "missed_links.txt": (DRAFT, FAILED),
}


def jr_of(url: str) -> str:
    """The JR id in a posting url, or "" - handy as a short label."""
    tail = (url or "").rsplit("_", 1)[-1]
    return tail if tail.upper().startswith("JR") else ""


class Applications:
    """The store, loaded from and saved to output/applications.json."""

    def __init__(self, out_dir: Path, exported: "set | None" = None):
        self.out_dir = Path(out_dir)
        self.path = self.out_dir / STORE_NAME
        self.entries: dict[str, dict] = {}
        # Read-only, and consulted by is_submitted alone. The store is the
        # authority wherever it exists, and on this machine it already
        # contains everything the export does - so this only ever loads in a
        # checkout that has no output/ at all, which is the daily cloud
        # routine's. Without it that routine builds its shortlist as though
        # nothing had ever been applied to.
        self.exported: set = set()
        if self.path.exists():
            try:
                self.entries = json.loads(self.path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError) as e:
                # Refuse to start from a half-read file: silently treating it
                # as empty would rewrite every view as though nothing had ever
                # been applied to.
                raise RuntimeError(
                    f"{self.path} exists but could not be read ({e}). Move it "
                    "aside if you mean to start over.") from e
        if not self.entries:
            self.exported = (exported if exported is not None
                             else exported_submitted())

    # -- writing -------------------------------------------------------

    def record(self, url: str, state: str, *, title: str = "",
               note: str = "") -> dict:
        """Set this posting's outcome, replacing whatever was there before."""
        if state not in STATES:
            raise ValueError(f"unknown state {state!r}; expected one of {STATES}")
        entry = self.entries.get(url, {})
        self.entries[url] = {
            "jr": jr_of(url),
            # Keep an earlier title if this caller does not have one.
            "title": title or entry.get("title", ""),
            "state": state,
            "note": note,
            "updated": datetime.now().isoformat(timespec="seconds"),
            # How many times we have been through this posting, which is the
            # signal that something needs a human rather than another retry.
            "attempts": entry.get("attempts", 0) + 1,
        }
        return self.entries[url]

    def save(self) -> Path:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self.entries, indent=2, ensure_ascii=False),
            encoding="utf-8")
        self.write_views()
        return self.path

    def write_views(self) -> list[Path]:
        """Rewrite the .txt files from the store. Not appended - rewritten."""
        written = []
        for name, states in VIEWS.items():
            urls = [u for u, e in self.entries.items() if e["state"] in states]
            path = self.out_dir / name
            path.write_text("".join(u + "\n" for u in sorted(urls)),
                            encoding="utf-8")
            written.append(path)
        return written

    # -- reading -------------------------------------------------------

    def state_of(self, url: str) -> str:
        return (self.entries.get(url) or {}).get("state", "")

    def is_submitted(self, url: str) -> bool:
        """Whether applying to this again would be a duplicate.

        Widened past `state_of` on purpose: the export is the only evidence
        available where the store is missing, and the cost of the two answers
        is not symmetric. A posting wrongly called new gets a second
        application sent to a recruiter; one wrongly called submitted is
        absent from a report.
        """
        return self.state_of(url) == SUBMITTED or url in self.exported

    def by_state(self, *states: str) -> list[str]:
        return [u for u, e in self.entries.items() if e["state"] in states]

    def summary(self) -> str:
        counts = {}
        for e in self.entries.values():
            counts[e["state"]] = counts.get(e["state"], 0) + 1
        parts = [f"{counts[s]} {s}" for s in STATES if s in counts]
        return ", ".join(parts) or "nothing recorded"


# The record itself lives under output/, which is gitignored - it is personal
# and it is rewritten constantly. But the daily cloud routine only ever sees
# what is in git, so without this export it would look at a 200-posting board
# with no idea which ones have already been applied to, and report jobs from
# weeks ago as new every morning.
#
# So: urls only, no titles, notes or timestamps - the least that answers "have
# I applied to this one".
EXPORT_NAME = "submitted-urls.json"


def exported_submitted(path=None) -> set:
    """Every submitted url in the in-git export, across all employers.

    A flat set rather than a per-employer map because the caller is an
    `Applications` for one output directory and does not know its employer's
    name. Urls carry their own board's host, so the union cannot collide.

    Returns an empty set when the export is missing or unreadable - the whole
    point of it is to be a best-effort second source, and refusing to start
    over a malformed generated file would take the routine down with it.
    """
    from pathlib import Path as _Path

    path = _Path(path) if path else (
        _Path(__file__).resolve().parent.parent / "data" / EXPORT_NAME)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        by_employer = data["submitted"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return set()
    if not isinstance(by_employer, dict):
        return set()
    return {u for urls in by_employer.values()
            if isinstance(urls, list) for u in urls}


def export_submitted(employers, path):
    """Write the submitted urls per employer to `path`. Returns the counts.

    Deliberately sorted: an unordered dump would produce a different file on
    every run and a commit whenever anything was applied to in a new order,
    which is noise in the history and a push that says nothing.
    """
    from datetime import datetime
    import json as _json
    from pathlib import Path as _Path

    path = _Path(path)
    out, counts = {}, {}
    for emp in employers:
        urls = sorted(Applications(emp.output_dir).by_state(SUBMITTED))
        out[emp.name] = urls
        counts[emp.name] = len(urls)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_json.dumps({
        "_comment": ("Submitted-posting urls, exported from each employer's "
                     "output/**/applications.json by tools/run_all.py. The "
                     "records themselves are gitignored; this exists so the "
                     "daily routine can tell a new posting from one already "
                     "applied to. Generated - do not edit by hand."),
        "generated": datetime.now().isoformat(timespec="seconds"),
        "counts": counts,
        "submitted": out,
    }, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return counts
