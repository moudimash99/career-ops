r"""Apply to every posting in output/capgemini/shortlist.json.

Capgemini is on SAP SuccessFactors, not Workday, so this is the sibling of
tools/apply_shortlist.py rather than a flag on it - app/pages.py cannot drive
this form at all. The flow itself lives in app/capgemini.py.

    .venv\Scripts\python.exe tools/apply_capgemini.py --login
    .venv\Scripts\python.exe tools/apply_capgemini.py --inspect --limit 1
    .venv\Scripts\python.exe tools/apply_capgemini.py --dry-run --limit 1
    .venv\Scripts\python.exe tools/apply_capgemini.py --limit 1
    .venv\Scripts\python.exe tools/apply_capgemini.py

Order matters on a form nobody here has submitted before: --inspect first (it
clicks nothing and dumps the controls, which is how the submit button gets
confirmed), then --dry-run on ONE posting, then a real run on one, then the
rest. Every outcome lands in output/capgemini/applications.json keyed by url,
so a posting already submitted is never applied to twice.

Documents are not in this repo. `cv` and `letter` in the shortlist are file
names resolved against --docs-root, which defaults to $CAPGEMINI_DOCS_DIR and
then to the career-ops output directory where they were generated.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

# Job titles carry accents; the Windows console is cp1252 and raises
# UnicodeEncodeError on them, which kills a run *after* it has done the work,
# at the point of printing the result.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from selenium.common.exceptions import (InvalidSessionIdException,
                                        NoSuchWindowException,
                                        WebDriverException)

from app import capgemini, employers
from app.capgemini import CapgeminiForm, Role, apply_one, visible_buttons
from app.config import CandidateData, SeleniumConfig
from app.driver import build_driver
from app.record import DRAFT, FAILED, SUBMITTED, Applications

# Where the tailored CVs and cover letters were generated. Not vendored: they
# are regenerated per role by career-ops, and a stale copy here would be worse
# than a path that fails loudly.
DEFAULT_DOCS_ROOT = Path(
    r"C:\Users\Moudimash99\Documents\Coding\career-ops\output")


def credentials() -> tuple[str, str]:
    """CAPGEMINI_EMAIL / CAPGEMINI_PASSWORD, falling back to career-ops' names.

    app/session.py's credentials() only knows the <PREFIX>_EMAIL convention,
    but the existing account is already in career-ops/.env as CAPGEMINI_USER /
    CAPGEMINI_PASS. Accept both rather than making the user keep two copies of
    one credential in sync.
    """
    try:
        from dotenv import load_dotenv
        load_dotenv(REPO / ".env")
        load_dotenv(DEFAULT_DOCS_ROOT.parent / ".env")
    except ImportError:
        pass
    email = os.getenv("CAPGEMINI_EMAIL") or os.getenv("CAPGEMINI_USER", "")
    password = os.getenv("CAPGEMINI_PASSWORD") or os.getenv("CAPGEMINI_PASS", "")
    return email, password


def load_roles(shortlist: Path, docs_root: Path) -> list[Role]:
    """Shortlist rows into Role objects, resolving the document paths.

    A document named in the shortlist but not on disk is dropped with a
    warning rather than silently ignored: applying without the tailored CV is
    a decision, not a detail.
    """
    data = json.loads(shortlist.read_text(encoding="utf-8"))
    rows = data["roles"] if isinstance(data, dict) else data
    roles = []
    for r in rows:
        def resolve(name):
            if not name:
                return None
            p = docs_root / name
            if not p.is_file():
                print(f"  ! missing document, continuing without it: {p}")
                return None
            return p
        roles.append(Role(
            url=r["url"],
            title=r.get("title", ""),
            family=r.get("family", ""),
            location=r.get("location", ""),
            cv=resolve(r.get("cv")),
            letter=resolve(r.get("letter")),
            tracker=r.get("tracker"),
        ))
    return roles


def report(out: capgemini.Outcome, verbose: bool) -> None:
    if out.filled:
        print("        filled: " + ", ".join(str(f) for f in out.filled))
    if verbose and out.readback:
        for k, v in out.readback.items():
            print(f"        {'+' if v else '.'} {k}: {v if v else '-'}")
    for n in out.notes:
        print(f"        ! {n}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--shortlist", default=None,
                    help="defaults to output/capgemini/shortlist.json")
    ap.add_argument("--answers", default=None,
                    help="defaults to answers/capgemini.json")
    ap.add_argument("--docs-root", default=None,
                    help="where the CVs and letters live "
                         "(default: $CAPGEMINI_DOCS_DIR, else career-ops/output)")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--only", default=None,
                    help="comma-separated tracker numbers, e.g. --only 4,19")
    ap.add_argument("--force", action="store_true",
                    help="re-apply to postings already recorded as submitted")
    ap.add_argument("--dry-run", action="store_true",
                    help="fill the whole form but never click Submit")
    ap.add_argument("--wait-captcha", action="store_true",
                    help="wait for user to manually solve captchas upon submit instead of skipping")
    ap.add_argument("--inspect", action="store_true",
                    help="open the form, list its controls, change nothing")
    ap.add_argument("--login", action="store_true",
                    help="sign in and stop, to establish the session")
    ap.add_argument("--verbose", action="store_true",
                    help="print the field readback for each posting")
    args = ap.parse_args()

    emp = employers.get("Capgemini")
    emp.output_dir.mkdir(parents=True, exist_ok=True)

    shortlist = Path(args.shortlist or (emp.output_dir / "shortlist.json"))
    if not shortlist.is_file():
        print(f"No shortlist at {shortlist}")
        return 2

    docs_root = Path(args.docs_root or os.getenv("CAPGEMINI_DOCS_DIR")
                     or DEFAULT_DOCS_ROOT)
    if not docs_root.is_dir():
        print(f"Documents directory not found: {docs_root}")
        return 2

    answers_path = Path(args.answers or (REPO / "answers" / "capgemini.json"))
    answers = json.loads(answers_path.read_text(encoding="utf-8"))
    missing = [k for k in capgemini.REQUIRED_ANSWERS if not answers.get(k)]
    if missing:
        print(f"{answers_path} is missing: {', '.join(missing)}")
        return 2

    email, password = credentials()
    if not email or not password:
        print("Set CAPGEMINI_EMAIL / CAPGEMINI_PASSWORD in .env "
              "(CAPGEMINI_USER / CAPGEMINI_PASS also accepted).")
        return 2

    print(f"Documents: {docs_root}")
    all_roles = load_roles(shortlist, docs_root)
    roles = list(all_roles)

    store = Applications(emp.output_dir)
    if args.only:
        want = {int(n) for n in args.only.split(",") if n.strip()}
        roles = [r for r in roles if r.tracker in want]

    # Applying twice is not a wasted page load, it is a second application in
    # front of the same recruiter, and nothing undoes it. --only targets a
    # posting; it does not mean "ignore what already happened to it".
    if not args.force:
        done = [r for r in roles if store.is_submitted(r.url)]
        for r in done:
            print(f"  skipping #{r.tracker} {r.title} - already submitted "
                  "(--force to re-apply)")
        roles = [r for r in roles if not store.is_submitted(r.url)]
    todo = roles[:args.limit]

    print(f"Capgemini: {len(todo)} to apply to  ({store.summary()})")
    if not todo and not args.login:
        return 0

    cfg = SeleniumConfig()
    candidate = CandidateData()
    driver = build_driver(emp.profile_dir, emp.profile_name)
    form = CapgeminiForm(driver, cfg.timeout_s, cfg.micro_wait_s)
    counts: dict[str, int] = {}

    try:
        anchor = (todo or all_roles)[0].url
        print(f"\nSigning in as {email} ... ", end="", flush=True)
        signed_in = form.sign_in(anchor, email, password)
        print("ok" if signed_in else "FAILED")
        if not signed_in:
            # Signed out, SuccessFactors serves the register-and-apply form and
            # only the first submission of a batch works. Carrying on would
            # produce a run of failures that all look like something else.
            print("\nCould not sign in. Every posting would get the "
                  "register-and-apply form, where only the FIRST submission "
                  "works. Fix the login before batching.")
            return 1
        if args.login:
            print("Session established in", emp.profile_dir)
            return 0

        for n, role in enumerate(todo, 1):
            label = f"#{role.tracker} {role.title}"
            print(f"\n########## {n}/{len(todo)}  {label}")

            if args.inspect:
                state = form.open_apply_form(role.url)
                print(f"        form: {state}")
                for b in visible_buttons(driver):
                    flag = " (disabled)" if b["disabled"] else ""
                    print(f"        [button] {b['text']!r}{flag}")
                rb = form.readback()
                for k, v in rb.items():
                    print(f"        {'+' if v else '.'} {k}: {v if v else '-'}")
                continue

            try:
                out = apply_one(form, role, candidate, answers,
                                dry_run=args.dry_run, wait_for_captcha=args.wait_captcha)
                report(out, args.verbose)
                state = SUBMITTED if out.submitted else DRAFT
                store.record(role.url, state, title=role.title, note=out.note)
            except (InvalidSessionIdException, NoSuchWindowException) as e:
                # The browser died. Everything after this would "fail"
                # instantly without being attempted, so stop rather than
                # marking the untouched rest as failed.
                print(f"\n[driver] browser lost ({type(e).__name__}); stopping "
                      "so the rest is not marked failed untried")
                store.record(role.url, FAILED, title=role.title,
                             note="browser lost mid-run")
                store.save()
                raise
            except WebDriverException as e:
                state = FAILED
                store.record(role.url, state, title=role.title,
                             note=f"{type(e).__name__}: {e}"[:300])
                traceback.print_exc()
            except Exception as e:
                # One bad posting must not end the run.
                state = FAILED
                store.record(role.url, state, title=role.title,
                             note=f"{type(e).__name__}: {e}"[:300])
                traceback.print_exc()

            counts[state] = counts.get(state, 0) + 1
            store.save()
            print(f"[{datetime.now():%H:%M:%S}] {state}  ({store.summary()})")
    finally:
        driver.quit()

    if args.inspect:
        return 0

    print("\n" + "=" * 68)
    for state in (SUBMITTED, DRAFT, FAILED):
        if counts.get(state):
            print(f"  {counts[state]:3d}  {state}")
    print(f"\n{store.summary()}  -> {store.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
