r"""One command: scan every board, then apply to everything new.

The three per-employer pipelines already exist and each works on its own. What
did not exist was a way to run them unattended and find out afterwards what
went wrong - the tools print to a console that scrolls away, and a failure part
way through a hundred-posting batch left nothing to read.

    .venv\Scripts\python.exe tools/run_all.py --dry-run   # drive it all, submit nothing
    .venv\Scripts\python.exe tools/run_all.py             # for real
    .venv\Scripts\python.exe tools/run_all.py --employers Capgemini
    .venv\Scripts\python.exe tools/run_all.py --search-only

Every run writes output/runs/<timestamp>/ holding one log per stage, an
errors.log and a summary.json; output/runs/latest-errors.log is a copy of the
newest one, so there is a fixed path to read afterwards.

Two things it is careful about:

- **One browser at a time.** Employers run in sequence, never in parallel. Two
  ChromeDriver suites at once fight over the same profile and debugging port,
  and the loser's postings all fail without being attempted.
- **A failure stops one employer, not the run.** Accenture blowing up must not
  cost the Capgemini batch, so each employer is fenced and the reason is
  written down rather than raised.

What it does not do is decide anything new. The picks still come from
tools/shortlist.py and tools/scrape_capgemini.py, the letters from
tools/build_letters.py, and every outcome lands in the same
output/**/applications.json as before - a posting already submitted is skipped
by the apply tools themselves, not here.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

# Job titles carry accents and en-dashes; the Windows console is cp1252 and
# raises UnicodeEncodeError on them, which would kill the runner at the point
# of echoing a child's output rather than at anything that mattered.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from app import employers
from app import record as record_mod
from app.config import DEFAULT_CV, ApplicationFiles, MissingAttachmentError
from app.record import DRAFT, FAILED, Applications

RUNS = REPO / "output" / "runs"
TOOLS = REPO / "tools"

# What the daily cloud routine reads. output/ is gitignored, so anything the
# routine needs has to be exported into data/ and pushed - see publish_record.
DIGEST_PATH = REPO / "data" / "last-runs.json"
DIGEST_KEEP = 10

# The CV the scorer and every letter are written against. career-ops owns it;
# this repo keeps a snapshot so the routine has something to score postings
# against on a machine that has never seen career-ops.
CV_SOURCE = Path(
    r"C:\Users\Moudimash99\Documents\Coding\career-ops\cv.md")
CV_SNAPSHOT = REPO / "data" / "cv.md"

# Where the tailored Capgemini CVs and letters live. Same default as
# tools/apply_capgemini.py and tools/scrape_capgemini.py.
DEFAULT_DOCS_ROOT = Path(
    r"C:\Users\Moudimash99\Documents\Coding\career-ops\output")

ORDER = ("Airbus", "Accenture", "Capgemini")

# Sopra Steria is deliberately absent. SmartRecruiters runs DataDome in front
# of its apply form and no automated submission gets through, so listing it
# here would produce a column of failures every run that mean nothing. Use
# tools/assist_apply.py, which opens each posting for a person.


class SkipEmployer(Exception):
    """Preflight says this employer cannot run. Not a bug - a missing input."""


@dataclass
class Stage:
    name: str
    argv: list[str]
    # A non-zero exit here is reported but does not stop the employer. Used
    # for the letter build: if node or career-ops is unavailable the letters
    # already rendered on disk are still attached, so losing the rebuild is
    # not a reason to skip the applications.
    optional: bool = False


@dataclass
class StageResult:
    name: str
    argv: list[str]
    code: "int | None" = None
    seconds: float = 0.0
    log: "Path | None" = None
    tracebacks: list[str] = field(default_factory=list)
    tail: list[str] = field(default_factory=list)
    skipped: str = ""


@dataclass
class EmployerResult:
    name: str
    stages: list[StageResult] = field(default_factory=list)
    # url -> {state, title, note}, for every posting this run touched.
    touched: dict[str, dict] = field(default_factory=dict)
    skipped: str = ""

    @property
    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for e in self.touched.values():
            out[e["state"]] = out.get(e["state"], 0) + 1
        return out

    @property
    def bad(self) -> dict[str, dict]:
        return {u: e for u, e in self.touched.items()
                if e["state"] in (DRAFT, FAILED)}


# -- running a stage ---------------------------------------------------

def child_env() -> dict:
    """The environment the tools get, with .env folded in.

    The tools that need credentials load .env themselves, but
    ApplicationFiles reads AIRBUS_CV_PATH straight from the environment - so
    an unattended run has to put it there, or every Workday application fails
    on a missing attachment one posting at a time.
    """
    env = dict(os.environ)
    try:
        from dotenv import dotenv_values
        for key, value in dotenv_values(REPO / ".env").items():
            if value is not None:
                env.setdefault(key, value)
    except ImportError:
        pass
    # Without this the child's stdout is cp1252 through a pipe, and every
    # accented job title raises UnicodeEncodeError inside the tool.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    return env


def tracebacks_in(lines: list[str]) -> list[str]:
    """Every traceback in a stage log, as its last frame plus the exception.

    The apply tools print a traceback and keep going, which is right - one bad
    posting must not end a batch - but it means a stage can exit 0 and still
    have lost eight applications. The exit code is not the whole story, so the
    tracebacks are read out of the log rather than inferred from it.
    """
    found, i = [], 0
    while i < len(lines):
        if lines[i].startswith("Traceback (most recent call last)"):
            block = [lines[i]]
            i += 1
            # Frames are indented; the exception line that ends the block is
            # not. Take the frames, then that line, then stop.
            while i < len(lines) and (lines[i].startswith(" ")
                                      or not lines[i].strip()):
                block.append(lines[i])
                i += 1
            if i < len(lines):
                block.append(lines[i])
                i += 1
            # The last frame and the exception say what happened; the rest of
            # the stack is in the log if it is ever needed.
            found.append("\n".join(block[-4:]))
            continue
        i += 1
    return found


def run_stage(stage: Stage, log_dir: Path, employer: str, env: dict,
              echo: bool = True) -> StageResult:
    log_path = log_dir / f"{employer.split()[0].casefold()}.{stage.name}.log"
    res = StageResult(stage.name, list(stage.argv), log=log_path)
    started = time.time()
    lines: list[str] = []

    header = "$ " + " ".join(str(a) for a in stage.argv)
    if echo:
        print(header, flush=True)

    with open(log_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(header + "\n")
        proc = subprocess.Popen(
            [str(a) for a in stage.argv], cwd=str(REPO), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            lines.append(line)
            fh.write(line + "\n")
            fh.flush()
            if echo:
                print(line, flush=True)
        res.code = proc.wait()

    res.seconds = time.time() - started
    res.tracebacks = tracebacks_in(lines)
    res.tail = lines[-40:]
    return res


# -- the plan ----------------------------------------------------------

def preflight(name: str, args) -> None:
    """Raise SkipEmployer with an actionable message, or return.

    Checked up front on purpose. A missing CV path is not discovered by
    Workday until the upload step, which is most of the way through an
    application - so a hundred postings get walked and parked as drafts before
    anything says why.
    """
    emp = employers.get(name)

    if emp.workday:
        if not (REPO / "answers").is_dir():
            raise SkipEmployer("no answers/ directory")
        try:
            files = ApplicationFiles.from_env().resolved()
        except MissingAttachmentError as e:
            raise SkipEmployer(
                f"{e}\n    Set AIRBUS_CV_PATH in .env to override "
                f"the default ({DEFAULT_CV.name}).") from e
        # Named out loud, every run, before a browser opens. The default CV
        # is what makes an unattended run possible; printing it is what stops
        # that from meaning "whatever was on disk, silently". See the
        # ApplicationFiles docstring.
        for f in files:
            print(f"  attaching: {f}")
        return

    if name == "Capgemini":
        docs = Path(args.docs_root or os.getenv("CAPGEMINI_DOCS_DIR")
                    or DEFAULT_DOCS_ROOT)
        if not docs.is_dir():
            raise SkipEmployer(f"documents directory not found: {docs}")
        if not (REPO / "answers" / "capgemini.json").is_file():
            raise SkipEmployer("answers/capgemini.json is missing")
        env = child_env()
        if not (env.get("CAPGEMINI_EMAIL") or env.get("CAPGEMINI_USER")):
            raise SkipEmployer("CAPGEMINI_EMAIL is not set in .env")
        if not (env.get("CAPGEMINI_PASSWORD") or env.get("CAPGEMINI_PASS")):
            raise SkipEmployer("CAPGEMINI_PASSWORD is not set in .env")
        return

    raise SkipEmployer(f"no pipeline for {name} in this runner")


def plan_for(name: str, args) -> list[Stage]:
    py = [sys.executable]
    stages: list[Stage] = []

    if name == "Capgemini":
        if not args.skip_search:
            search = py + [str(TOOLS / "scrape_capgemini.py"),
                           "--limit", str(args.scan_limit),
                           "--near", args.cap_near]
            if args.min_score is not None:
                search += ["--min-score", str(args.min_score)]
            if args.docs_root:
                search += ["--docs-root", args.docs_root]
            stages.append(Stage("search", search))
            # Optional - see the Stage docstring.
            stages.append(Stage("letters",
                                py + [str(TOOLS / "build_letters.py")],
                                optional=True))
        if not args.search_only:
            apply_argv = py + [str(TOOLS / "apply_capgemini.py")]
            if args.docs_root:
                apply_argv += ["--docs-root", args.docs_root]
            if args.limit:
                apply_argv += ["--limit", str(args.limit)]
            if args.dry_run:
                apply_argv.append("--dry-run")
            stages.append(Stage("apply", apply_argv))
        return stages

    if not args.skip_search:
        search = py + [str(TOOLS / "shortlist.py"), "--employer", name,
                       "--days", str(args.days),
                       # tools/shortlist.py caps its picks at 40 by default.
                       # "Apply to them all" means lifting that here rather
                       # than silently obeying a default chosen for a
                       # different question.
                       "--max-picks", str(args.max_picks)]
        if args.min_score is not None:
            search += ["--min-score", str(args.min_score)]
        stages.append(Stage("search", search))
    if not args.search_only:
        apply_argv = py + [str(TOOLS / "apply_shortlist.py"), "--employer", name]
        if args.limit:
            apply_argv += ["--limit", str(args.limit)]
        if args.dry_run:
            apply_argv.append("--dry-run")
        stages.append(Stage("apply", apply_argv))
    return stages


def snapshot(name: str) -> dict[str, dict]:
    emp = employers.get(name)
    try:
        return dict(Applications(emp.output_dir).entries)
    except RuntimeError:
        # A half-written store. The apply tool refuses to start on it and says
        # so; there is nothing useful to diff against here.
        return {}


def touched_since(name: str, before: dict[str, dict]) -> dict[str, dict]:
    """Every posting whose record changed while this employer ran.

    Diffed against the record rather than parsed out of the console, because
    the record is what the next run will believe. If a posting is not in here,
    this run did not touch it - whatever the log said.
    """
    after = snapshot(name)
    out = {}
    for url, entry in after.items():
        was = before.get(url)
        if was is None or was.get("updated") != entry.get("updated"):
            out[url] = {"state": entry.get("state", ""),
                        "title": entry.get("title", ""),
                        "note": entry.get("note", "")}
    return out


# -- what the routine reads --------------------------------------------

def run_digest(run_id: str, args, results: list[EmployerResult],
               skipped: dict[str, str]) -> dict:
    """This run's failures, small enough to keep in git.

    errors.log is the artefact a person reads and it lives under output/,
    which is gitignored - so the daily routine, which only ever sees the
    default branch, has no way of knowing that last night's Capgemini batch
    lost eight postings to one traceback.

    Failures only. A run where everything worked is one entry saying so;
    carrying every success into git would bury the row worth reading.
    """
    failures = []
    for r in results:
        for st in r.stages:
            if not st.code and not st.tracebacks:
                continue
            failures.append({
                "employer": r.name,
                "stage": st.name,
                "exit": st.code,
                "command": " ".join(str(a) for a in st.argv),
                # tracebacks_in has already cut these to the last frame plus
                # the exception. Two is enough to tell eight postings dying of
                # one cause from eight postings dying of eight.
                "tracebacks": st.tracebacks[:2],
                "traceback_count": len(st.tracebacks),
                "tail": st.tail[-12:] if st.code else [],
            })

    bad = [{"employer": r.name, "url": url, "title": e.get("title", ""),
            "state": e.get("state", ""), "note": e.get("note", "")}
           for r in results for url, e in r.bad.items()]

    return {
        "run": run_id,
        "at": datetime.now().isoformat(timespec="seconds"),
        "mode": ("search-only" if args.search_only
                 else "dry-run" if args.dry_run else "real"),
        "employers": list(args.employers),
        "skipped": dict(skipped),
        "failures": failures,
        "bad_postings": bad,
    }


def write_digest(entry: dict, path: Path = DIGEST_PATH,
                 keep: int = DIGEST_KEEP) -> None:
    """Append this run to the digest, newest first, keeping the last `keep`.

    A rolling window rather than the whole history: the routine is asked what
    broke recently, and a file that grows without limit makes every run a
    bigger diff carrying no more signal. output/runs/ is the archive.
    """
    runs: list = []
    if path.is_file():
        try:
            runs = json.loads(path.read_text(encoding="utf-8")).get("runs", [])
        except (json.JSONDecodeError, OSError, AttributeError):
            # A corrupt digest must not cost this run its record.
            runs = []
    runs = [entry] + [r for r in runs if r.get("run") != entry.get("run")]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "_comment": ("The last few runs' failures, exported by "
                     "tools/run_all.py so the daily routine can see what "
                     "broke. The full logs are under output/runs/, which is "
                     "gitignored. Generated - do not edit by hand."),
        "runs": runs[:keep],
    }, indent=2, ensure_ascii=False), encoding="utf-8")


def snapshot_cv(source: Path = CV_SOURCE, dest: Path = CV_SNAPSHOT) -> str:
    """Refresh the in-repo CV copy from career-ops. Returns what happened.

    The scorer and the letters are both written against career-ops' cv.md, so
    a routine ranking postings against a stale copy would recommend roles on
    facts the CV no longer claims. Copying it every run is what keeps the two
    from drifting. A missing source leaves the existing snapshot alone rather
    than deleting it: an old CV still scores, no CV scores nothing.
    """
    if not source.is_file():
        return f"cv source not found ({source}); snapshot left as it is"
    text = source.read_text(encoding="utf-8", errors="replace")
    if (dest.is_file()
            and dest.read_text(encoding="utf-8", errors="replace") == text):
        return "cv snapshot already current"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8")
    return f"cv snapshot refreshed from {source}"


# -- publishing the record ---------------------------------------------

EXPORT_PATH = REPO / "data" / record_mod.EXPORT_NAME


def git(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(REPO), check=check,
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace")


@dataclass
class Published:
    """Whether the export reached master, and what to say about it.

    A bool rather than a message the caller has to pattern-match: "exported
    and committed" and "exported, committed and pushed" differ by one word and
    mean opposite things to the routine reading the result.
    """
    ok: bool
    message: str


def publish_record(quiet: bool = False) -> Published:
    """Export what the routine reads, commit those files, push them to master.

    Three files, all under data/: the submitted urls, so it can tell a new
    posting from one already applied to; the run digest, so it can see what
    broke; and the CV snapshot, so it has something to score against.

    The daily cloud routine reads the repository's default branch and nothing
    else. An export that is written but never pushed is worse than no export
    at all: the routine would answer confidently off a list that stopped being
    true, where "posted in the last two days" at least fails honestly.

    Nothing here is allowed to fail the run. Applications have already been
    submitted by the time this is reached, and losing that outcome to a git
    error - offline, no credentials, a diverged branch - would be absurd. Every
    problem comes back as a string to put in the report.
    """
    names = [e.name for e in (employers.AIRBUS_EMPLOYER,
                              employers.ACCENTURE_EMPLOYER,
                              employers.CAPGEMINI_EMPLOYER)]
    counts = record_mod.export_submitted(
        [employers.get(n) for n in names], EXPORT_PATH)
    total = sum(counts.values())
    if not quiet:
        print(f"\nexported {total} submitted urls -> {EXPORT_PATH}")

    if git("rev-parse", "--git-dir").returncode:
        return Published(False, f"exported {total} urls; not a git checkout, "
                         "nothing pushed")

    # git wants a repo-relative pathspec, with forward slashes on Windows. A
    # path outside the checkout is not a case that arises in this repo, but
    # this function promises never to raise - so it degrades to the absolute
    # path and lets git be the one to complain.
    paths: list[str] = []
    for candidate in (EXPORT_PATH, DIGEST_PATH, CV_SNAPSHOT):
        if not candidate.is_file():
            continue                 # nothing written it yet; not an error
        try:
            paths.append(str(candidate.relative_to(REPO)).replace("\\", "/"))
        except ValueError:
            paths.append(str(candidate))
    git("add", "--", *paths)
    if git("diff", "--cached", "--quiet", "--", *paths).returncode == 0:
        return Published(True, f"exported {total} urls; unchanged since the "
                         "last run, nothing to push")

    # Only this pathspec. A run that has just submitted a hundred
    # applications must not also sweep up whatever else is in the working
    # tree - half-finished edits included.
    made = git("commit", "-m",
               f"Update the routine's inputs ({total} submitted postings)",
               "--", *paths)
    if made.returncode:
        return Published(False, f"exported {total} urls; commit failed: "
                         f"{made.stderr.strip()[:200]}")

    if git("fetch", "origin", "master").returncode:
        return Published(False, f"exported and committed {total} urls; could "
                         "not reach origin, so the routine will read an "
                         "older list")
    # Fast-forward only. Force-pushing master from a job-application run is
    # not a trade anyone would make on purpose.
    if git("merge-base", "--is-ancestor", "origin/master", "HEAD").returncode:
        return Published(False, f"exported and committed {total} urls, but "
                         "HEAD has diverged from origin/master - push it "
                         "yourself; the routine reads an older list until "
                         "you do")
    pushed = git("push", "origin", "HEAD:master")
    if pushed.returncode:
        return Published(False, f"exported and committed {total} urls; push "
                         f"failed: {pushed.stderr.strip()[:200]}")
    return Published(True, f"exported, committed and pushed {total} submitted "
                     "urls to master")


# -- reporting ---------------------------------------------------------

def write_errors(path: Path, run_id: str, args, results: list[EmployerResult],
                 skipped: dict[str, str],
                 published: "Published | None" = None) -> int:
    """The file to read after an unattended run. Returns the problem count."""
    out: list[str] = []
    problems = 0

    # An export that did not reach master is a problem worth naming: the daily
    # routine keeps answering off the older list, and does it confidently.
    if published and not published.ok:
        problems += 1
        out.append(f"[record] {published.message}")
        out.append("")

    out.append(f"run {run_id}")
    out.append("mode: " + ("SEARCH ONLY - nothing submitted" if args.search_only
                           else "DRY RUN - nothing submitted" if args.dry_run
                           else "REAL - applications submitted"))
    out.append("employers: " + ", ".join(args.employers))
    out.append("")

    for name, why in skipped.items():
        problems += 1
        out.append(f"[{name}] SKIPPED - {why}")
    if skipped:
        out.append("")

    for r in results:
        for st in r.stages:
            if st.skipped:
                out.append(f"[{r.name}/{st.name}] not run - {st.skipped}")
                continue
            if st.code:
                problems += 1
                out.append(f"[{r.name}/{st.name}] exit {st.code}")
                out.append(f"  last lines of {st.log}:")
                out.extend("    " + line for line in st.tail)
                out.append("")
            for tb in st.tracebacks:
                problems += 1
                out.append(f"[{r.name}/{st.name}] traceback:")
                out.extend("    " + line for line in tb.splitlines())
                out.append("")

        # In a dry run every posting ends as a draft - that IS the success
        # condition, so counting drafts as problems would flag all of them and
        # teach anyone reading this file to ignore it. A `failed` is still a
        # failure: the form broke before the point where Submit was skipped.
        bad = ({u: e for u, e in r.bad.items() if e["state"] == FAILED}
               if args.dry_run else r.bad)
        if bad:
            problems += len(bad)
            verb = ("broke before the end of the form" if args.dry_run
                    else "did not submit")
            out.append(f"[{r.name}] {len(bad)} posting(s) {verb}:")
            for url, e in bad.items():
                out.append(f"    {e['state']:<9} {e['title'][:60]}")
                out.append(f"              {url}")
                if e["note"]:
                    out.append(f"              note: {e['note']}")
            out.append("")

    if args.dry_run:
        drafted = sum(len(r.bad) - len([1 for e in r.bad.values()
                                        if e["state"] == FAILED])
                      for r in results)
        if drafted:
            out.append(f"{drafted} posting(s) reached the end of the form and "
                       "were not submitted, which is what a dry run is for.")
            out.append("")

    if not problems:
        out.append("No errors. Every posting attempted this run was submitted.")

    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--employers", default=",".join(ORDER),
                    help="comma-separated, in order (default: %(default)s)")
    ap.add_argument("--dry-run", action="store_true",
                    help="drive every form but never click Submit")
    ap.add_argument("--search-only", action="store_true",
                    help="refresh the shortlists and stop, opening no browser")
    ap.add_argument("--skip-search", action="store_true",
                    help="apply to the existing shortlists without rescanning")
    ap.add_argument("--limit", type=int, default=None,
                    help="cap applications per employer this run "
                         "(default: no cap - apply to everything new)")
    ap.add_argument("--days", type=int, default=30,
                    help="Workday: only postings at most this old (default: 30)")
    # No default on purpose. Each search tool already has one chosen for its
    # own board - 3 for Workday, 1 for Capgemini - and forcing a single number
    # on both is the runner re-deciding relevance, which is not its job.
    # Passing --min-score 1 here put "IT Support Technician Level 2" on the
    # Airbus shortlist.
    ap.add_argument("--min-score", type=int, default=None,
                    help="override the relevance floor for every board "
                         "(default: each tool's own - 3 Workday, 1 Capgemini)")
    ap.add_argument("--max-picks", type=int, default=500,
                    help="Workday: shortlist size ceiling (default: 500)")
    ap.add_argument("--scan-limit", type=int, default=500,
                    help="Capgemini: shortlist size ceiling (default: 500)")
    ap.add_argument("--cap-near", default="",
                    help="Capgemini locations, comma-separated; "
                         "blank (the default) means all of France")
    ap.add_argument("--docs-root", default=None,
                    help="where the Capgemini CVs and letters live")
    ap.add_argument("--quiet", action="store_true",
                    help="write the logs but do not echo them")
    ap.add_argument("--no-push", action="store_true",
                    help="do not commit and push the data/ exports the daily "
                         "routine reads (submitted urls, run digest, CV)")
    ap.add_argument("--push", action="store_true",
                    help="publish from a --dry-run too. A dry run submits "
                         "nothing, so the url export will not have changed - "
                         "this is for getting its failures to the daily "
                         "routine without waiting for a real run")
    args = ap.parse_args()

    args.employers = [n.strip() for n in args.employers.split(",") if n.strip()]
    for name in args.employers:
        employers.get(name)          # reject a typo before anything runs

    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    log_dir = RUNS / run_id
    log_dir.mkdir(parents=True, exist_ok=True)

    if args.search_only:
        mode = "SEARCH ONLY - no browser, nothing submitted"
    elif args.dry_run:
        mode = "DRY RUN - nothing will be submitted"
    else:
        mode = "REAL RUN - applications will be submitted"

    print("=" * 68)
    print(f"run {run_id}   {mode}")
    print("employers: " + ", ".join(args.employers)
          + (f"   limit {args.limit} each" if args.limit
             else "   no per-employer limit"))
    print(f"logs: {log_dir}")
    print("=" * 68)

    env = child_env()
    results: list[EmployerResult] = []
    skipped: dict[str, str] = {}
    started = time.time()

    for name in args.employers:
        print(f"\n{'=' * 68}\n== {name}\n{'=' * 68}")
        result = EmployerResult(name)

        try:
            # --search-only opens no browser and attaches no documents, so the
            # preflight would refuse a scan that is perfectly fine to run.
            if not args.search_only:
                preflight(name, args)
        except (SkipEmployer, KeyError) as e:
            why = str(e).strip("'")
            print(f"  skipped: {why}")
            skipped[name] = why
            result.skipped = why
            results.append(result)
            continue

        before = snapshot(name)
        plan = plan_for(name, args)
        for n, stage in enumerate(plan):
            res = run_stage(stage, log_dir, name, env, echo=not args.quiet)
            result.stages.append(res)
            print(f"  -- {name}/{stage.name}: exit {res.code} "
                  f"in {res.seconds:.0f}s  -> {res.log}")
            if res.code and not stage.optional:
                # A failed search means the shortlist is stale or empty, and
                # applying off it would work through the previous run's picks
                # as though they were this run's.
                print(f"  stopping {name}: {stage.name} failed")
                for later in plan[n + 1:]:
                    result.stages.append(StageResult(
                        later.name, list(later.argv),
                        skipped=f"{stage.name} exited {res.code}"))
                break

        result.touched = touched_since(name, before)
        counts = result.counts
        print(f"  == {name}: "
              + (", ".join(f"{v} {k}" for k, v in counts.items())
                 or "nothing changed"))
        results.append(result)

    # -- write it all down ---------------------------------------------
    # A dry run submitted nothing, so there is nothing new to export and a
    # commit would say something untrue.
    # Written on every run, dry ones included: a traceback raised while
    # driving the forms is a real bug whether or not anything was submitted.
    # Whether it reaches git is the separate question below.
    write_digest(run_digest(run_id, args, results, skipped))
    cv_note = snapshot_cv()
    if not args.quiet:
        print(f"  {cv_note}")

    published: "Published | None" = None
    if not args.no_push and (args.push or not args.dry_run):
        try:
            published = publish_record(quiet=args.quiet)
        except Exception as e:                       # never fail a real run
            published = Published(
                False, f"export failed: {type(e).__name__}: {e}"[:200])
        print(f"  record: {published.message}")

    errors_path = log_dir / "errors.log"
    problems = write_errors(errors_path, run_id, args, results, skipped,
                            published)

    summary = {
        "run": run_id,
        "started": datetime.fromtimestamp(started).isoformat(timespec="seconds"),
        "seconds": round(time.time() - started, 1),
        "dry_run": args.dry_run,
        "employers": args.employers,
        "problems": problems,
        "record_export": ({"ok": published.ok, "message": published.message}
                          if published else None),
        "results": [{
            "employer": r.name,
            "skipped": r.skipped,
            "counts": r.counts,
            "stages": [{"stage": s.name, "exit": s.code,
                        "seconds": round(s.seconds, 1),
                        "log": s.log.name if s.log else "",
                        "skipped": s.skipped,
                        "tracebacks": len(s.tracebacks)} for s in r.stages],
            "touched": r.touched,
        } for r in results],
    }
    (log_dir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

    # A fixed path to read afterwards. The timestamped directory is the
    # archive; these two are "what happened last time", which is what anyone
    # actually goes looking for.
    RUNS.mkdir(parents=True, exist_ok=True)
    (RUNS / "LATEST.txt").write_text(str(log_dir) + "\n", encoding="utf-8")
    shutil.copyfile(errors_path, RUNS / "latest-errors.log")
    shutil.copyfile(log_dir / "summary.json", RUNS / "latest-summary.json")

    print("\n" + "=" * 68)
    total: dict[str, int] = {}
    for r in results:
        for state, n in r.counts.items():
            total[state] = total.get(state, 0) + n
        line = ", ".join(f"{v} {k}" for k, v in r.counts.items())
        print(f"  {r.name:<14} {r.skipped or line or 'nothing new'}")
    print("-" * 68)
    print("  " + (", ".join(f"{v} {k}" for k, v in total.items())
                  or "nothing applied to"))
    print(f"\n  {problems} problem(s)  -> {RUNS / 'latest-errors.log'}")
    print(f"  full logs              -> {log_dir}")
    # Non-zero only when something needs a human. A run with nothing new to
    # apply to is a success, not a failure.
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
