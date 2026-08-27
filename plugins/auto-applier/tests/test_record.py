"""The application record must be able to un-say things.

output/*_links.txt were append-only, so a posting that failed once and
succeeded on the retry stayed in missed_links.txt for good. On 2026-08-20 that
file held 18 lines describing 5 postings, one of them already submitted.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.record import (DRAFT, FAILED, SUBMITTED, Applications, jr_of)

A = "https://x/job/Toulouse-Area/Application-Manager-for-SE_JR10426904"
B = "https://x/job/Toulouse-Area/Ground-Segment-Engineer--m-f-_JR10435170"


class TestRetryOverwritesFailure:
    def test_success_replaces_an_earlier_failure(self, tmp_path):
        s = Applications(tmp_path)
        s.record(A, FAILED)
        s.record(A, SUBMITTED)
        assert s.state_of(A) == SUBMITTED
        assert len(s.entries) == 1

    def test_the_failure_is_gone_from_the_missed_view(self, tmp_path):
        s = Applications(tmp_path)
        s.record(A, FAILED)
        s.record(A, SUBMITTED)
        s.save()
        assert (tmp_path / "missed_links.txt").read_text(encoding="utf-8") == ""
        assert A in (tmp_path / "succ_links.txt").read_text(encoding="utf-8")

    def test_views_are_rewritten_not_appended(self, tmp_path):
        """The bug in one line: writing twice must not produce two lines."""
        s = Applications(tmp_path)
        for _ in range(9):
            s.record(A, FAILED)
            s.save()
        missed = (tmp_path / "missed_links.txt").read_text(encoding="utf-8")
        assert missed.strip().splitlines() == [A]

    def test_attempts_are_counted(self, tmp_path):
        s = Applications(tmp_path)
        for _ in range(3):
            s.record(A, FAILED)
        assert s.entries[A]["attempts"] == 3


class TestPersistence:
    def test_survives_a_reload(self, tmp_path):
        s = Applications(tmp_path)
        s.record(A, SUBMITTED, title="Application Manager for SE")
        s.record(B, DRAFT)
        s.save()

        again = Applications(tmp_path)
        assert again.state_of(A) == SUBMITTED
        assert again.state_of(B) == DRAFT
        assert again.entries[A]["title"] == "Application Manager for SE"

    def test_a_later_write_keeps_an_earlier_title(self, tmp_path):
        s = Applications(tmp_path)
        s.record(A, DRAFT, title="Application Manager for SE")
        s.record(A, SUBMITTED)
        assert s.entries[A]["title"] == "Application Manager for SE"

    def test_a_corrupt_store_is_not_silently_treated_as_empty(self, tmp_path):
        """Starting over from a half-read file would rewrite every view as
        though nothing had ever been applied to - and re-apply to all of it."""
        (tmp_path / "applications.json").write_text("{not json", encoding="utf-8")
        with pytest.raises(RuntimeError):
            Applications(tmp_path)

    def test_unknown_state_is_refused(self, tmp_path):
        s = Applications(tmp_path)
        with pytest.raises(ValueError):
            s.record(A, "probably-fine")


class TestQuerying:
    def test_is_submitted(self, tmp_path):
        s = Applications(tmp_path)
        s.record(A, SUBMITTED)
        s.record(B, FAILED)
        assert s.is_submitted(A) is True
        assert s.is_submitted(B) is False
        assert s.is_submitted("https://x/never-seen") is False

    def test_by_state(self, tmp_path):
        s = Applications(tmp_path)
        s.record(A, SUBMITTED)
        s.record(B, FAILED)
        assert s.by_state(FAILED) == [B]
        assert sorted(s.by_state(SUBMITTED, FAILED)) == sorted([A, B])

    def test_jr_is_extracted_for_labelling(self):
        assert jr_of(A) == "JR10426904"
        assert jr_of("https://x/job/no-id-here") == ""
