"""The runner's job is to be trustworthy about what went wrong.

An unattended batch is only worth running if the report afterwards is
complete, so the cases here are all about *not* losing a failure:

- a stage that exits 0 having printed eight tracebacks is not a clean stage;
- a posting that ended as a draft is a problem even when every exit code is 0;
- the relevance floor belongs to each board's own search tool, not to the
  runner - passing --min-score 1 to Workday put "IT Support Technician Level
  2" on the Airbus shortlist.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.record import DRAFT, FAILED, SUBMITTED
from tools import run_all


def opts(**over):
    """The argparse namespace plan_for expects, with the real defaults."""
    base = dict(employers=["Airbus"], dry_run=False, search_only=False,
                skip_search=False, limit=None, days=30, min_score=None,
                max_picks=500, scan_limit=500, cap_near="", docs_root=None,
                quiet=True)
    base.update(over)
    return argparse.Namespace(**base)


def argv_of(stages, name):
    return next(" ".join(s.argv) for s in stages if s.name == name)


class TestTheRelevanceFloorStaysWithTheBoard:
    """--min-score is not passed unless it was asked for."""

    def test_workday_search_keeps_its_own_default(self):
        line = argv_of(run_all.plan_for("Airbus", opts()), "search")
        assert "--min-score" not in line

    def test_capgemini_search_keeps_its_own_default(self):
        line = argv_of(run_all.plan_for("Capgemini", opts()), "search")
        assert "--min-score" not in line

    def test_an_explicit_floor_reaches_both(self):
        for emp in ("Airbus", "Capgemini"):
            line = argv_of(run_all.plan_for(emp, opts(min_score=5)), "search")
            assert "--min-score 5" in line


class TestThePlan:
    def test_the_forty_pick_cap_is_lifted(self):
        """shortlist.py defaults to 40; "apply to them all" has to say so."""
        line = argv_of(run_all.plan_for("Airbus", opts()), "search")
        assert "--max-picks 500" in line

    def test_capgemini_scans_all_of_france_by_default(self):
        line = argv_of(run_all.plan_for("Capgemini", opts()), "search")
        assert "--near " in line + " "

    def test_dry_run_reaches_the_apply_stage(self):
        for emp in ("Airbus", "Capgemini"):
            line = argv_of(run_all.plan_for(emp, opts(dry_run=True)), "apply")
            assert "--dry-run" in line

    def test_dry_run_never_reaches_the_search_stage(self):
        """A dry run must still scan for real, or it proves nothing."""
        for emp in ("Airbus", "Capgemini"):
            line = argv_of(run_all.plan_for(emp, opts(dry_run=True)), "search")
            assert "--dry-run" not in line

    def test_search_only_opens_no_browser(self):
        for emp in ("Airbus", "Capgemini"):
            names = [s.name for s in run_all.plan_for(emp, opts(search_only=True))]
            assert "apply" not in names

    def test_skip_search_applies_to_the_existing_shortlist(self):
        for emp in ("Airbus", "Capgemini"):
            names = [s.name for s in run_all.plan_for(emp, opts(skip_search=True))]
            assert names == ["apply"]

    def test_the_letter_build_is_optional(self):
        """node or career-ops missing must not cost the applications: the
        letters already on disk are still attached."""
        letters = next(s for s in run_all.plan_for("Capgemini", opts())
                       if s.name == "letters")
        assert letters.optional
        search = next(s for s in run_all.plan_for("Capgemini", opts())
                      if s.name == "search")
        assert not search.optional


class TestTracebacksAreNotLostToAZeroExit:
    """apply_shortlist.py prints a traceback per bad posting and keeps going,
    so the exit code says nothing about how many applications were lost."""

    def test_a_traceback_is_found(self):
        log = ["########## 3/9  Architecte", "Traceback (most recent call last):",
               '  File "main.py", line 40, in apply_one',
               "    page.submit()",
               "TimeoutException: Message: ", "[14:02:11] failed"]
        found = run_all.tracebacks_in(log)
        assert len(found) == 1
        assert "TimeoutException" in found[0]

    def test_every_traceback_is_found_not_just_the_first(self):
        block = ["Traceback (most recent call last):",
                 '  File "main.py", line 40, in apply_one',
                 "ValueError: nope"]
        assert len(run_all.tracebacks_in(block * 3)) == 3

    def test_a_clean_log_yields_nothing(self):
        assert run_all.tracebacks_in(["Airbus: 4 to apply to", "submitted"]) == []

    def test_a_truncated_traceback_is_still_reported(self):
        """The log ends mid-block when the process is killed - which is
        precisely the run worth hearing about, so report the partial block
        rather than dropping it for want of an exception line."""
        found = run_all.tracebacks_in(
            ["Traceback (most recent call last):",
             '  File "main.py", line 40, in apply_one'])
        assert len(found) == 1
        assert "apply_one" in found[0]


class TestWhatTheRunTouched:
    """Read off the record, not the console: the record is what the next run
    will believe."""

    def _store(self, tmp_path, monkeypatch, entries):
        (tmp_path / "applications.json").write_text(
            json.dumps(entries), encoding="utf-8")
        emp = type("E", (), {"output_dir": tmp_path})()
        monkeypatch.setattr(run_all.employers, "get", lambda _n: emp)

    def test_an_untouched_posting_is_not_reported(self, tmp_path, monkeypatch):
        old = {"u1": {"state": SUBMITTED, "title": "t", "note": "",
                      "updated": "2026-08-20T10:00:00"}}
        self._store(tmp_path, monkeypatch, old)
        assert run_all.touched_since("Airbus", old) == {}

    def test_a_re_attempted_posting_is_reported(self, tmp_path, monkeypatch):
        before = {"u1": {"state": FAILED, "title": "t", "note": "",
                         "updated": "2026-08-20T10:00:00"}}
        after = {"u1": {"state": SUBMITTED, "title": "t", "note": "",
                        "updated": "2026-08-23T14:00:00"}}
        self._store(tmp_path, monkeypatch, after)
        assert run_all.touched_since("Airbus", before)["u1"]["state"] == SUBMITTED

    def test_a_new_posting_is_reported(self, tmp_path, monkeypatch):
        after = {"u2": {"state": DRAFT, "title": "t", "note": "n",
                        "updated": "2026-08-23T14:00:00"}}
        self._store(tmp_path, monkeypatch, after)
        assert set(run_all.touched_since("Airbus", {})) == {"u2"}


class TestTheErrorReport:
    def _result(self, **over):
        r = run_all.EmployerResult(over.pop("name", "Airbus"))
        for k, v in over.items():
            setattr(r, k, v)
        return r

    def test_a_draft_is_a_problem_even_when_every_exit_code_is_zero(self, tmp_path):
        r = self._result(
            stages=[run_all.StageResult("apply", [], code=0)],
            touched={"u1": {"state": DRAFT, "title": "Architecte",
                            "note": "no submit button"}})
        path = tmp_path / "errors.log"
        assert run_all.write_errors(path, "x", opts(), [r], {}) == 1
        text = path.read_text(encoding="utf-8")
        assert "did not submit" in text
        assert "no submit button" in text
        assert "u1" in text

    def test_a_dry_run_draft_is_not_a_problem(self, tmp_path):
        """Every posting ends as a draft in a dry run - that is the success
        condition. Counting them would flag all of them and teach anyone
        reading errors.log to ignore it."""
        r = self._result(
            stages=[run_all.StageResult("apply", [], code=0)],
            touched={"u1": {"state": DRAFT, "title": "Architecte",
                            "note": "dry run - not submitted"}})
        path = tmp_path / "errors.log"
        assert run_all.write_errors(path, "x", opts(dry_run=True), [r], {}) == 0
        assert "what a dry run is for" in path.read_text(encoding="utf-8")

    def test_a_dry_run_failure_is_still_a_problem(self, tmp_path):
        """The form broke before the point where Submit would be skipped."""
        r = self._result(
            stages=[run_all.StageResult("apply", [], code=0)],
            touched={"u1": {"state": FAILED, "title": "Architecte",
                            "note": "TimeoutException"}})
        path = tmp_path / "errors.log"
        assert run_all.write_errors(path, "x", opts(dry_run=True), [r], {}) == 1
        assert "TimeoutException" in path.read_text(encoding="utf-8")

    def test_a_submitted_posting_is_not_a_problem(self, tmp_path):
        r = self._result(
            stages=[run_all.StageResult("apply", [], code=0)],
            touched={"u1": {"state": SUBMITTED, "title": "t", "note": ""}})
        path = tmp_path / "errors.log"
        assert run_all.write_errors(path, "x", opts(), [r], {}) == 0
        assert "No errors" in path.read_text(encoding="utf-8")

    def test_a_failed_stage_brings_its_log_tail(self, tmp_path):
        r = self._result(stages=[run_all.StageResult(
            "search", [], code=2, tail=["Documents directory not found: D:\\x"])])
        path = tmp_path / "errors.log"
        assert run_all.write_errors(path, "x", opts(), [r], {}) == 1
        assert "Documents directory not found" in path.read_text(encoding="utf-8")

    def test_a_skipped_employer_is_a_problem(self, tmp_path):
        path = tmp_path / "errors.log"
        n = run_all.write_errors(path, "x", opts(), [],
                                 {"Capgemini": "CAPGEMINI_EMAIL is not set"})
        assert n == 1
        assert "CAPGEMINI_EMAIL is not set" in path.read_text(encoding="utf-8")

    def test_stages_never_reached_are_named_not_counted(self, tmp_path):
        """A stage skipped because an earlier one failed is not a second
        problem - the failure is already counted once."""
        r = self._result(stages=[
            run_all.StageResult("search", [], code=2, tail=["boom"]),
            run_all.StageResult("apply", [], skipped="search exited 2")])
        path = tmp_path / "errors.log"
        assert run_all.write_errors(path, "x", opts(), [r], {}) == 1
        assert "not run - search exited 2" in path.read_text(encoding="utf-8")


class TestRunStage:
    """The tee: a stage's output has to reach the log file even when the
    stage dies, or the report is written from nothing."""

    def test_output_and_exit_code_are_captured(self, tmp_path):
        stage = run_all.Stage("search", [
            sys.executable, "-c", "print('hello'); raise SystemExit(3)"])
        res = run_all.run_stage(stage, tmp_path, "Airbus",
                                run_all.child_env(), echo=False)
        assert res.code == 3
        assert "hello" in res.log.read_text(encoding="utf-8")
        assert "hello" in res.tail

    def test_a_child_traceback_is_captured(self, tmp_path):
        stage = run_all.Stage("apply", [
            sys.executable, "-c", "raise ValueError('bad posting')"])
        res = run_all.run_stage(stage, tmp_path, "Airbus",
                                run_all.child_env(), echo=False)
        assert res.tracebacks and "bad posting" in res.tracebacks[0]

    def test_an_accented_title_survives_the_pipe(self, tmp_path):
        """cp1252 through a pipe is how a run dies at the point of printing
        the result it already achieved."""
        stage = run_all.Stage("search", [
            sys.executable, "-c", "print('Ing\\u00e9nieur Syst\\u00e8mes')"])
        res = run_all.run_stage(stage, tmp_path, "Airbus",
                                run_all.child_env(), echo=False)
        assert res.code == 0
        assert "Ingénieur Systèmes" in res.log.read_text(encoding="utf-8")


class TestPreflight:
    def test_sopra_steria_has_no_pipeline(self):
        """DataDome blocks the apply form; a column of failures every run
        would mean nothing. tools/assist_apply.py is the route."""
        with pytest.raises(run_all.SkipEmployer):
            run_all.preflight("Sopra Steria", opts())

    def test_the_default_cv_lets_workday_run_unattended(self, monkeypatch,
                                                        capsys):
        """The point of the default: no AIRBUS_CV_PATH in the environment and
        Airbus still runs. It used to be skipped every time."""
        monkeypatch.delenv("AIRBUS_CV_PATH", raising=False)
        run_all.preflight("Airbus", opts())
        assert run_all.DEFAULT_CV.name in capsys.readouterr().out

    def test_the_attached_cv_is_named_before_the_browser_opens(self, monkeypatch,
                                                               capsys):
        """A default is only safe if it is never silent."""
        monkeypatch.delenv("AIRBUS_CV_PATH", raising=False)
        run_all.preflight("Airbus", opts())
        out = capsys.readouterr().out
        assert "attaching:" in out
        assert str(run_all.DEFAULT_CV) in out

    def test_an_override_wins_and_is_named(self, monkeypatch, tmp_path, capsys):
        cv = tmp_path / "other.pdf"
        cv.write_bytes(b"%PDF-1.4\n")
        monkeypatch.setenv("AIRBUS_CV_PATH", str(cv))
        run_all.preflight("Airbus", opts())
        assert "other.pdf" in capsys.readouterr().out

    def test_a_default_cv_that_is_gone_is_caught_by_name(self, monkeypatch):
        """The message has to name the missing file, not report "no CV
        configured" - that sends you looking for a setting, not a file."""
        monkeypatch.delenv("AIRBUS_CV_PATH", raising=False)
        monkeypatch.setattr(run_all, "DEFAULT_CV", Path("D:/gone/nope.pdf"))
        monkeypatch.setattr(run_all.ApplicationFiles, "cv_path", None)
        monkeypatch.setattr("app.config.DEFAULT_CV", Path("D:/gone/nope.pdf"))
        with pytest.raises(run_all.SkipEmployer) as e:
            run_all.preflight("Airbus", opts())
        assert "nope.pdf" in str(e.value)

    def test_capgemini_needs_its_documents(self, tmp_path):
        with pytest.raises(run_all.SkipEmployer) as e:
            run_all.preflight("Capgemini",
                              opts(docs_root=str(tmp_path / "nope")))
        assert "documents directory not found" in str(e.value)


class TestTheDefaultCV:
    """The default exists so an unattended run can happen at all. What the
    old no-default rule was really protecting against was a *silent* upload,
    and that protection is kept by naming the file rather than by refusing."""

    def test_it_is_used_when_nothing_is_configured(self, monkeypatch):
        from app import config
        monkeypatch.delenv("AIRBUS_CV_PATH", raising=False)
        assert config.ApplicationFiles.from_env().cv_path == config.DEFAULT_CV

    def test_the_environment_still_wins(self, monkeypatch):
        from app import config
        monkeypatch.setenv("AIRBUS_CV_PATH", r"D:\mine.pdf")
        assert config.ApplicationFiles.from_env().cv_path == Path(r"D:\mine.pdf")

    def test_it_is_a_pdf_that_exists(self):
        """A default pointing at nothing is worse than none at all."""
        from app import config
        assert config.DEFAULT_CV.is_file()
        assert config.DEFAULT_CV.suffix == ".pdf"

    def test_it_is_not_branded_for_one_employer(self):
        """Airbus and Accenture share it, so a Capgemini-tailored CV would be
        the wrong document with the right file name."""
        from app import config
        assert "capgemini" not in config.DEFAULT_CV.name.casefold()

    def test_it_resolves_to_something_uploadable(self):
        from app import config
        files = config.ApplicationFiles.from_env().resolved()
        assert files and files[0].is_file()


class TestTheSubmittedExport:
    """output/ is gitignored, so the daily cloud routine cannot see the
    record. Without this export it looks at a 200-posting board with no idea
    which ones have been applied to, and reports weeks-old jobs as new."""

    def _store(self, tmp_path, entries):
        from app.record import Applications
        s = Applications(tmp_path)
        for url, state in entries:
            s.record(url, state)
        s.save()
        return type("E", (), {"name": "Airbus", "output_dir": tmp_path})()

    def test_only_submitted_urls_are_exported(self, tmp_path):
        from app import record as rm
        emp = self._store(tmp_path / "rec", [
            ("u-sub", SUBMITTED), ("u-draft", DRAFT), ("u-failed", FAILED)])
        out = tmp_path / "export.json"
        counts = rm.export_submitted([emp], out)
        data = json.loads(out.read_text(encoding="utf-8"))
        assert counts == {"Airbus": 1}
        assert data["submitted"]["Airbus"] == ["u-sub"]

    def test_the_output_is_sorted_so_reruns_do_not_churn(self, tmp_path):
        """An unordered dump makes a commit every run and says nothing."""
        from app import record as rm
        emp = self._store(tmp_path / "rec",
                          [("u-c", SUBMITTED), ("u-a", SUBMITTED),
                           ("u-b", SUBMITTED)])
        out = tmp_path / "export.json"
        rm.export_submitted([emp], out)
        first = json.loads(out.read_text(encoding="utf-8"))["submitted"]["Airbus"]
        assert first == ["u-a", "u-b", "u-c"]

    def test_it_carries_no_titles_or_notes(self, tmp_path):
        """Urls answer "have I applied to this"; nothing else is needed, and
        the record itself is personal."""
        from app import record as rm
        from app.record import Applications
        s = Applications(tmp_path / "rec")
        s.record("u1", SUBMITTED, title="Secret Role", note="private note")
        s.save()
        emp = type("E", (), {"name": "Airbus", "output_dir": tmp_path / "rec"})()
        out = tmp_path / "export.json"
        rm.export_submitted([emp], out)
        text = out.read_text(encoding="utf-8")
        assert "Secret Role" not in text and "private note" not in text


class TestPublishingTheExport:
    """Nothing in the push path may fail the run: by the time it is reached
    the applications have already been submitted."""

    def _fake_git(self, monkeypatch, outcomes):
        """outcomes: first word of the git subcommand -> returncode."""
        calls = []

        def fake(*args, check=False):
            calls.append(args)
            code = outcomes.get(args[0], 0)
            return type("P", (), {"returncode": code, "stdout": "",
                                  "stderr": "boom"})()
        monkeypatch.setattr(run_all, "git", fake)
        return calls

    def _fake_export(self, monkeypatch, tmp_path):
        monkeypatch.setattr(run_all, "EXPORT_PATH", tmp_path / "e.json")
        monkeypatch.setattr(run_all.record_mod, "export_submitted",
                            lambda emps, path: {"Airbus": 3})

    def test_the_happy_path_reports_a_push(self, monkeypatch, tmp_path):
        self._fake_export(monkeypatch, tmp_path)
        self._fake_git(monkeypatch, {"diff": 1})     # 1 = there is a change
        res = run_all.publish_record(quiet=True)
        assert res.ok and "pushed" in res.message

    def test_no_change_is_fine_and_pushes_nothing(self, monkeypatch, tmp_path):
        self._fake_export(monkeypatch, tmp_path)
        calls = self._fake_git(monkeypatch, {"diff": 0})   # 0 = unchanged
        res = run_all.publish_record(quiet=True)
        assert res.ok and "unchanged" in res.message
        assert not any(c[0] == "push" for c in calls)

    def test_a_diverged_branch_refuses_rather_than_forcing(self, monkeypatch,
                                                           tmp_path):
        """Force-pushing master from a job-application run is not a trade
        anyone would make on purpose."""
        self._fake_export(monkeypatch, tmp_path)
        calls = self._fake_git(monkeypatch, {"diff": 1, "merge-base": 1})
        res = run_all.publish_record(quiet=True)
        assert not res.ok and "diverged" in res.message
        assert not any(c[0] == "push" for c in calls)

    def test_being_offline_is_reported_not_raised(self, monkeypatch, tmp_path):
        self._fake_export(monkeypatch, tmp_path)
        self._fake_git(monkeypatch, {"diff": 1, "fetch": 1})
        res = run_all.publish_record(quiet=True)
        assert not res.ok and "older list" in res.message

    def test_a_failed_push_is_reported_not_raised(self, monkeypatch, tmp_path):
        self._fake_export(monkeypatch, tmp_path)
        self._fake_git(monkeypatch, {"diff": 1, "push": 1})
        res = run_all.publish_record(quiet=True)
        assert not res.ok and "push failed" in res.message

    def test_a_stale_export_is_a_problem_in_the_report(self, tmp_path):
        """The routine keeps answering off the older list, confidently."""
        path = tmp_path / "errors.log"
        n = run_all.write_errors(
            path, "x", opts(), [], {},
            run_all.Published(False, "push failed: no upstream"))
        assert n == 1
        assert "no upstream" in path.read_text(encoding="utf-8")

    def test_a_successful_push_is_not_a_problem(self, tmp_path):
        path = tmp_path / "errors.log"
        n = run_all.write_errors(
            path, "x", opts(), [], {},
            run_all.Published(True, "exported, committed and pushed 355 urls"))
        assert n == 0
