# main.py
"""Apply to Airbus postings on Workday.

Stage 1 targets normal (non-student) jobs. The LLM CV/cover-letter generator is
no longer in this path - documents are static files named in app/config.py or
via AIRBUS_CV_PATH. Generation comes back in stage 3.

Modes:
    python main.py --inspect --limit 1   record wizard fields, submit nothing
    python main.py --dry-run             drive the whole flow, stop at Submit
    python main.py                       apply for real
"""
from __future__ import annotations

import argparse
import json
import time
import traceback
import sys
from datetime import datetime
from pathlib import Path

from selenium.webdriver.common.by import By

import app.link_getter
from app.config import (ApplicationFiles, CandidateData, JobSearchConfig,
                        SeleniumConfig)
from app.driver import build_driver
from app.inspector import (describe, describe_obstructions, save_page_html,
                           save_snapshots, snapshot_page)
from app.pages import ApplicationWizard, JobPage
from app.record import DRAFT, FAILED, SUBMITTED, Applications
from app.relevance import score_title
from app.session import ensure_signed_in
from app.ux import UX
from job_scrapper import workday_api
from utils import pause_for_human_resume


class AlreadyAppliedError(RuntimeError):
    """This posting already has a submitted application."""


CFG = SeleniumConfig()
ME = CandidateData()
SEARCH = JobSearchConfig()

REPO_ROOT = Path(__file__).resolve().parent

# Job titles carry accents and en-dashes; the Windows console is cp1252 and
# raises UnicodeEncodeError on them, which killed a run *after* it had done the
# work, at the point of printing the result. Replace what cannot be encoded.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass
# Matches tools/shortlist.py, so both paths agree on what counts.
MIN_SCORE = 3

OUTPUT_DIR = REPO_ROOT / "output"
SNAPSHOT_DIR = OUTPUT_DIR / "wizard_snapshots"


# -------------------------------------------------------------------------
# Link sources
# -------------------------------------------------------------------------

def links_from_bookmarks() -> list[str]:
    return list(app.link_getter.get_links())


def links_from_board(limit):
    """Live search of the board, restricted to non-student contracts."""
    subtypes = ", ".join(SEARCH.subtypes)
    total = workday_api.count_jobs(SEARCH.country, SEARCH.subtypes,
                                   SEARCH.search_text)
    print(f"Board reports {total} matching postings "
          f"[country={SEARCH.country}, subtypes={subtypes}]")
    postings = workday_api.iter_postings(
        country=SEARCH.country,
        subtypes=SEARCH.subtypes,
        search_text=SEARCH.search_text,
        max_jobs=limit if limit is not None else SEARCH.max_jobs,
    )

    # The board is not a shortlist. Most of what it carries is buying,
    # logistics, production and quality work, and applying to all of it puts
    # the candidate's name on jobs they are not remotely suited to. Every
    # posting that gets through here names the term that let it through.
    kept, dropped = [], 0
    for posting in postings:
        score, why = score_title(posting.title or "")
        if score < MIN_SCORE:
            dropped += 1
            continue
        kept.append(posting.url)
        print(f"  [{score}] {posting.title[:64]} ({why[:40]})")
    print(f"{len(kept)} worth applying to, {dropped} filtered out. "
          f"Use tools/shortlist.py for the ranked, de-duplicated version.")
    return kept


def link_for_jr(jr: str) -> str:
    """Resolve a JR id to its posting url via the board search."""
    jr = jr.strip().upper()
    for p in workday_api.iter_postings(country=SEARCH.country,
                                       subtypes=SEARCH.subtypes,
                                       search_text=SEARCH.search_text,
                                       max_jobs=SEARCH.max_jobs or 600):
        if jr in (p.url or "").upper():
            print(f"{jr} -> {p.title}")
            return p.url
    raise RuntimeError(f"{jr} not found on the board "
                       f"[country={SEARCH.country}, subtypes={SEARCH.subtypes}]")


def get_links(source: str, limit, url: str | None = None, jr: str | None = None):
    # An explicit target wins: without this there is no way to aim at one
    # posting, and every run lands on whatever sorts first.
    if url:
        return [url]
    if jr:
        return [link_for_jr(jr)]
    if source == "bookmarks":
        links = links_from_bookmarks()
    else:
        links = links_from_board(limit)
    if limit is not None:
        links = links[:limit]
    return links


# -------------------------------------------------------------------------
# Flows
# -------------------------------------------------------------------------

UNANSWERED_DIR = OUTPUT_DIR / "unanswered"

# What is on the page right now, in the terms that matter: the three things
# earlier runs silently emptied.
_PAGE_COUNTS_JS = """
const sel = (q) => document.querySelectorAll(q).length;
const blank = Array.from(document.querySelectorAll('input,textarea'))
  .filter(e => (e.offsetWidth || e.offsetHeight)
            && e.getAttribute('aria-required') === 'true'
            && !(e.value || '').trim()
            && !e.closest('[data-automation-id^="formField"]')
                 ?.querySelector('[data-automation-id="selectedItem"]'))
  .map(e => e.id || e.getAttribute('data-automation-id') || '?');
return {
  work_experience: sel('[id*="--companyName"]'),
  education: sel('[data-automation-id="formField-school"]'),
  education_filled: sel('[data-automation-id="formField-school"] [data-automation-id="selectedItem"]'),
  attachments: sel('button[data-automation-id="delete-file"]'),
  languages: sel('[data-automation-id="formField-language"]'),
  blank_required: blank.slice(0, 12)
};
"""


def summarise_page(driver, job) -> str:
    """Describe what the user is looking at, before anything is submitted."""
    lines = [f"  step        : {job.current_step() or '?'}"]
    try:
        c = driver.execute_script(_PAGE_COUNTS_JS)
    except Exception as e:
        return "\n".join(lines + [f"  (could not read page: {type(e).__name__})"])
    if c.get("work_experience"):
        lines.append(f"  work history: {c['work_experience']} entr(y/ies)")
    if c.get("education"):
        lines.append(f"  education   : {c['education']} entr(y/ies), "
                     f"{c['education_filled']} with a school selected")
    if c.get("languages"):
        lines.append(f"  languages   : {c['languages']} entr(y/ies)")
    if c.get("attachments"):
        lines.append(f"  attachments : {c['attachments']} file(s)")
    blank = c.get("blank_required") or []
    lines.append(f"  blank req'd : {', '.join(blank) if blank else 'none'}")
    return "\n".join(lines)


def build_gate(driver, job_ref, gate_path, timeout_s: int = 1800):
    """Block before anything that advances the wizard, until the user says OK.

    The user watches the browser and approves each step in chat; there is no
    stdin on these runs, so the OK arrives as a file appearing on disk.
    """
    if gate_path is None:
        return lambda step: None

    gate_path = Path(gate_path)

    def gate(step: str):
        print("\n" + "=" * 68)
        print(f"[GATE] about to advance: {step}")
        job = job_ref[0] if job_ref else None
        if job is not None:
            print(summarise_page(driver, job))
        print(f"[GATE] waiting for your OK  (touch {gate_path})")
        print("=" * 68, flush=True)

        started = time.time()
        announced = 0
        while time.time() - started < timeout_s:
            if gate_path.exists():
                try:
                    gate_path.unlink()
                except Exception:
                    pass
                print(f"[GATE] OK received - advancing {step}", flush=True)
                return
            time.sleep(1)
            mins = int(time.time() - started) // 60
            if mins and mins != announced:
                announced = mins
                print(f"[GATE] still waiting ({mins} min)", flush=True)
        raise TimeoutError(f"No OK received for {step!r} within {timeout_s}s")

    return gate


def load_answers(path) -> dict:
    if not path:
        return {}
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    print(f"Answers loaded from {path}: {len(data)} entr(y/ies)")
    return data


def park_unanswered(unanswered: list, link: str) -> Path:
    """Write questions we will not guess at, for the user to fill in later."""
    UNANSWERED_DIR.mkdir(parents=True, exist_ok=True)
    jr = next((part for part in link.replace("/", "_").split("_")
               if part.upper().startswith("JR")), "posting")
    path = UNANSWERED_DIR / f"{jr}.json"
    path.write_text(json.dumps(
        {"posting": link,
         "answer_each_and_rerun_with": "--answers <this file>",
         "questions": unanswered}, indent=2, ensure_ascii=False),
        encoding="utf-8")
    return path


STEPS = ("information", "experience", "questions", "disclosures",
         "review", "submit")


def work_history_is_empty(driver) -> bool:
    """Whether My Experience has no work entry with a company name in it.

    A row can exist and still be blank: a draft left behind by a failed run
    reopens with empty rows, and Workday then refuses the page for a missing
    Job Title, Company, From and To without prefill ever running again.
    """
    fields = driver.find_elements(
        By.CSS_SELECTOR, "[id^='workExperience-'][id$='--companyName']")
    return not any((el.get_attribute("value") or "").strip() for el in fields)


def has_questions_step(step: str) -> bool:
    """Whether the wizard is actually on Application Questions.

    Not every posting has the step: the API's questionnaire_id is None for
    roughly 3 in 20 regular French postings, and those run My Experience ->
    Voluntary Disclosures directly. Matching on the progress bar rather than
    assuming a fixed five-step wizard.
    """
    return "question" in (step or "").casefold()


def apply_one(driver, link: str, files, **kwargs) -> bool:
    """Apply to one posting, recording the page if anything goes wrong.

    Only the experience step used to capture on failure, so when My
    Information refused to advance with no field flagged - JR10416968-1, live
    on 2026-08-21 - the run said "read the captured HTML" and there was no
    captured HTML to read. Every step gets that treatment now.
    """
    try:
        return _apply_one(driver, link, files, **kwargs)
    except AlreadyAppliedError:
        # Normal control flow, not a failure - nothing to diagnose.
        raise
    except Exception as e:
        try:
            snap = snapshot_page(driver)
            snap["tag"] = "99_FAILED"
            print(f"[inspect] 99_FAILED ({type(e).__name__})")
            print(describe(snap))
            obstructed = describe_obstructions(snap)
            if obstructed:
                print(obstructed)
            save_snapshots([snap], SNAPSHOT_DIR, tag="99_FAILED")
            written = save_page_html(driver, SNAPSHOT_DIR, tag="99_FAILED")
            if written.get("html"):
                print(f"[inspect] failure page -> {written['html']}")
        except Exception as inner:
            print(f"[inspect] could not capture the failure page "
                  f"({type(inner).__name__})")
        raise


def _apply_one(driver, link: str, files, *, dry_run: bool,
               route: str = "last", stop_after: str | None = None,
               interactive: bool = False,
               force_identity: bool = False,
               gate_path=None, answers: dict | None = None,
               source_answer: tuple = ()) -> bool:
    ux = UX(driver, CFG.timeout_s, CFG.micro_wait_s)
    started = datetime.now()
    print(f"\n[{started:%H:%M:%S}] === {link}")

    def capture(tag: str):
        """Record the page: summary, obstructions, raw HTML, screenshot.

        The summary is a convenience; the HTML is the evidence. Every real
        defect this flow has hit was invisible in the summary and obvious in
        the markup.
        """
        try:
            snap = snapshot_page(driver)
        except Exception as e:
            print(f"[inspect] {tag}: could not read page ({type(e).__name__})")
            return None
        snap["tag"] = tag
        print(f"[inspect] {tag}")
        print(describe(snap))
        obstructed = describe_obstructions(snap)
        if obstructed:
            print(obstructed)
        save_snapshots([snap], SNAPSHOT_DIR, tag=tag)
        written = save_page_html(driver, SNAPSHOT_DIR, tag=tag)
        if written.get("html"):
            print(f"[inspect] html -> {written['html']}")
        return snap

    def reached(step: str) -> bool:
        if stop_after == step:
            print(f"\n[stop] finished '{step}' as requested; "
                  f"draft left in Workday at: {job.current_step() or '?'}")
            return True
        return False

    driver.get(link)

    # The gate describes what the user is looking at, so it needs the page
    # object - and the page needs the gate. Hence the one-element handle.
    job_ref = [None]
    gate = build_gate(driver, job_ref, gate_path)
    job = JobPage(ux, gate=gate)
    job_ref[0] = job
    capture("00_posting")

    state = job.start_application(
        use_last_application=getattr(ME, "use_last_application", True),
        route=route,
        interactive=interactive,
    )
    if state == "submitted":
        raise AlreadyAppliedError(link)
    capture("01_route_chosen")
    if getattr(job, "prefilled", True) is False:
        print("[route] continuing with nothing prefilled - every field is "
              "written from scratch.")

    # --- My Information ---------------------------------------------------
    job.select_source(ME, overwrite_identity=force_identity,
                      source_answer=source_answer)
    capture("02_information_saved")
    if reached("information"):
        return False

    wiz = ApplicationWizard(driver, ux, ME, dry_run=dry_run, gate=gate)

    # --- My Experience ----------------------------------------------------
    job.experience_page(files=files)

    # Work history is normally carried across by "Use My Last Application" and
    # is deliberately left alone when it is there - it is the candidate's own
    # record. But a draft left behind by a failed run reopens with the section
    # empty, and Workday requires Job Title, Company, From and To. Writing it
    # from the CV data in app/config.py is the only way such a draft can ever
    # advance.
    if work_history_is_empty(driver):
        history = getattr(ME, "work_history", ())
        if history:
            print(f"[work] section is empty - writing {len(history)} entries "
                  "from the configured CV history")
            wiz.fill_work_history(history)
        else:
            print("[work] section is empty and no history is configured")

    wiz.fill_education()
    wiz.set_languages()
    capture("03_experience_filled")
    try:
        wiz.save_and_continue("My Experience")
    except Exception:
        # Capture the page that refused, not just the traceback - the reason is
        # in the markup, and without this the failing state is never recorded.
        capture("04_experience_REFUSED")
        raise
    capture("04_experience_saved")
    if reached("experience"):
        return False

    # --- Application Questions -------------------------------------------
    # Not every posting has this step. The API's questionnaire_id is None for
    # roughly 3 in 20 regular French postings, and those go straight from My
    # Experience to Voluntary Disclosures. Running this block regardless
    # clicked Save on the Voluntary Disclosures page before final_page had
    # filled it, and Workday refused it for a missing Gender, Date of Birth
    # and Primary Nationality - which is what killed JR10426904 live on
    # 2026-08-20. Read where the wizard actually is instead of assuming.
    step_now = job.current_step()
    if has_questions_step(step_now):
        wiz.handle_questionnaire(interactive=interactive)
        unanswered = wiz.answer_questions(answers or {})
        capture("05_questions")
        if unanswered:
            path = park_unanswered(unanswered, link)
            print("\n[stop] questions here have no answer configured. "
                  "Nothing was guessed.")
            for q in unanswered:
                print(f"  - {q.get('question', '')[:150]}")
            print(f"[stop] saved for you -> {path}")
            print("[stop] fill in the answers there, then re-run with "
                  "--answers " + str(path))
            return False
        wiz.save_and_continue("Application Questions")
        capture("06_questions_saved")
    else:
        print(f"[questions] no Application Questions step on this posting "
              f"(wizard is on {step_now or '?'}) - skipping")
    if reached("questions"):
        return False

    # --- Voluntary Disclosures / personal information ---------------------
    # final_page saves the page, so what is on screen afterwards is Review.
    # One capture covers both stop points; capturing twice produced two
    # byte-identical files, one of them mislabelled.
    wiz.final_page()
    capture("07_review")
    if reached("disclosures") or reached("review"):
        return False

    submitted = wiz.submit()
    capture("08_submitted" if submitted else "08_submit_unconfirmed")

    if wiz.snapshots:
        path = save_snapshots(wiz.snapshots, SNAPSHOT_DIR, tag="apply")
        print(f"[inspect] wizard snapshots -> {path}")

    took = (datetime.now() - started).total_seconds()
    outcome = "submitted" if submitted else "draft"
    print(f"[{datetime.now():%H:%M:%S}] {outcome} in {took:.0f}s")
    return submitted


def inspect_one(driver, link: str):
    """Walk the wizard with a human driving, recording every page.

    Records only - it never fills a field or clicks Submit. The point is to
    learn what regular postings actually ask, since the questionnaire varies
    per posting and is invisible without a logged-in session.
    """
    ux = UX(driver, CFG.timeout_s, CFG.micro_wait_s)
    snaps = []

    driver.get(link)
    snap = snapshot_page(driver)
    snap["tag"] = "job_posting"
    snaps.append(snap)
    print(f"\n=== inspecting {link}")

    try:
        JobPage(ux).start_application()
    except Exception:
        print("Could not click Apply automatically - do it in the browser.")

    print("\nDrive the wizard in the browser. After each page loads, come back "
          "here and press Enter to record it. Type q then Enter when done.\n"
          "Nothing is submitted by this mode.")

    page_no = 1
    while True:
        answer = input(f"[page {page_no}] Enter = record, q = finish: ")
        if answer.strip().lower() == "q":
            break
        try:
            snap = snapshot_page(driver)
        except Exception as e:
            print(f"  could not read page: {e}")
            continue
        snap["tag"] = f"page_{page_no}"
        snaps.append(snap)
        print(describe(snap))
        page_no += 1

    return snaps


# -------------------------------------------------------------------------
# Entry point
# -------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Apply to Airbus jobs on Workday.")
    parser.add_argument("--inspect", action="store_true",
                        help="record wizard fields instead of applying")
    parser.add_argument("--dry-run", action="store_true",
                        help="drive the full flow but never click Submit")
    parser.add_argument("--source", choices=("bookmarks", "board"),
                        default="bookmarks",
                        help="where job links come from (default: bookmarks)")
    parser.add_argument("--limit", type=int, default=None,
                        help="only process the first N links")
    parser.add_argument("--url", default=None,
                        help="apply to exactly this posting url")
    parser.add_argument("--jr", default=None,
                        help="apply to this JR id, e.g. JR10425441")
    parser.add_argument("--route", choices=("last", "autofill", "manual"),
                        default="last",
                        help="which 'Start Your Application' route to take")
    parser.add_argument("--stop-after", choices=STEPS, default=None,
                        help="stop once this step is saved, leaving a draft")
    parser.add_argument("--gate", default=None,
                        help="pause before every Save and Continue and before "
                             "Submit until this file appears, then delete it")
    parser.add_argument("--answers", default=None,
                        help="json file mapping question text -> answer")
    parser.add_argument("--force-identity", action="store_true",
                        help="rewrite identity fields even when already filled "
                             "(repairs a page an earlier run wrote badly)")
    parser.add_argument("--interactive", action="store_true",
                        help="pause for a human on the questionnaire "
                             "(needs a real console; off by default)")
    args = parser.parse_args()

    # Fail before opening a browser if the documents are not set up.
    files = []
    if not args.inspect:
        files = ApplicationFiles.from_env().resolved()
        print("Attaching:")
        for f in files:
            print(f"  - {f}")

    answers = load_answers(args.answers)
    if args.stop_after == "information":
        # Saving My Information and exiting is what left a draft with no work
        # history: the next run resumes at /apply, where prefill never reruns.
        print("WARNING --stop-after information leaves a draft with no work "
              "history; ignoring it.")
        args.stop_after = None

    links = get_links(args.source, args.limit,
                      url=args.url, jr=args.jr)
    if not links:
        raise RuntimeError(f"No links obtained from source {args.source!r}.")
    print(f"{len(links)} links to process")

    OUTPUT_DIR.mkdir(exist_ok=True)
    driver = build_driver(CFG.user_data_dir, CFG.profile_name)

    try:
        # Confirm the session before touching a posting. Signed out, Workday
        # serves the account wall in place of the form and the run dies several
        # steps later on a missing field instead of here.
        # Verify the session on the first posting itself. candidateHome is
        # broken on this account - permanent spinner, "1 Error", no listing.
        ensure_signed_in(driver, verify_url=links[0])

        if args.inspect:
            all_snaps = []
            for link in links:
                try:
                    all_snaps.extend(inspect_one(driver, link))
                except Exception:
                    traceback.print_exc()
            if all_snaps:
                path = save_snapshots(all_snaps, SNAPSHOT_DIR, tag="inspect")
                print(f"\nRecorded {len(all_snaps)} pages -> {path}")
            else:
                print("\nNothing recorded.")
            return

        # Keyed, not appended: a retry that succeeds must be able to overwrite
        # the earlier failure. See app/record.py.
        store = Applications(OUTPUT_DIR)
        for link in links:
            try:
                ok = apply_one(driver, link, files,
                               dry_run=args.dry_run,
                               route=args.route,
                               stop_after=args.stop_after,
                               interactive=args.interactive,
                               force_identity=args.force_identity,
                               gate_path=args.gate,
                               answers=answers)
                store.record(link, SUBMITTED if ok else DRAFT)
            except AlreadyAppliedError:
                # Not a failure: an application already went in for this one.
                print("  already applied - skipping")
                store.record(link, SUBMITTED, note="already applied")
            except Exception as e:
                store.record(link, FAILED, note=f"{type(e).__name__}: {e}"[:300])
                traceback.print_exc()
                # Give a human the chance to finish or abandon this one.
                pause_for_human_resume(120, raise_on_timeout=False)
            # Saved after every posting, so an interrupted run keeps its record.
            store.save()
        print(f"\n[record] {store.summary()} -> {store.path}")
        print(f"\nDone. Results recorded under {OUTPUT_DIR}")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
