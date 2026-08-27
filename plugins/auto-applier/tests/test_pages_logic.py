"""Pure-logic tests: no browser, no network."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from app.pages import needs_attachment_reset, posting_state_from_labels
from main import has_questions_step


class TestPostingState:
    def test_fresh_posting_offers_apply(self):
        assert posting_state_from_labels(
            ["Sign In", "Apply", "Save Job"]) == "new"

    def test_revisited_posting_offers_continue(self):
        # The case that used to blow up: Apply is gone, Continue is there.
        assert posting_state_from_labels(
            ["Sign In", "Continue Application"]) == "draft"

    def test_continue_wins_when_both_present(self):
        # Some renderings keep an Apply-ish control around; the draft is the
        # truth, and clicking Apply on a draft is what broke before.
        assert posting_state_from_labels(
            ["Apply", "Continue Application"]) == "draft"

    def test_already_submitted(self):
        for label in ("View Application", "Withdraw Application",
                      "Application Submitted"):
            assert posting_state_from_labels(["Sign In", label]) == "submitted"

    def test_nothing_actionable(self):
        assert posting_state_from_labels(["Sign In", "Search"]) == "unknown"
        assert posting_state_from_labels([]) == "unknown"
        assert posting_state_from_labels(None) == "unknown"

    def test_is_whitespace_and_case_insensitive(self):
        assert posting_state_from_labels(["  continue   APPLICATION "]) == "draft"
        assert posting_state_from_labels(["APPLY"]) == "new"

    def test_apply_now_variant_still_counts_as_new(self):
        assert posting_state_from_labels(["Apply Now"]) == "new"

    def test_unrelated_word_containing_apply_is_not_a_match(self):
        # "Reapply" / "Applied Filters" must not read as a fresh Apply button.
        assert posting_state_from_labels(["Applied Filters"]) == "unknown"


class TestAttachmentReset:
    def test_prefilled_cv_must_be_cleared(self):
        assert needs_attachment_reset(["old_cv.pdf"]) is True

    def test_nothing_attached_needs_no_reset(self):
        assert needs_attachment_reset([]) is False

    def test_multiple_leftovers_still_reset(self):
        assert needs_attachment_reset(["cv.pdf", "cover.pdf"]) is True


class TestQuestionsStepIsOptional:
    """JR10426904, live 2026-08-20.

    The posting had no Application Questions step, so the wizard went My
    Experience -> Voluntary Disclosures. The flow ran the questions block
    anyway, which clicked Save on Voluntary Disclosures before final_page had
    filled it; Workday refused it for a missing Gender, Date of Birth and
    Primary Nationality, and the application was left as a draft.
    """

    def test_recognises_the_questions_step(self):
        assert has_questions_step("Application Questions") is True

    def test_voluntary_disclosures_is_not_the_questions_step(self):
        assert has_questions_step("Voluntary Disclosures") is False

    def test_no_other_wizard_step_matches(self):
        for step in ("My Information", "My Experience", "Review"):
            assert has_questions_step(step) is False

    def test_unreadable_progress_bar_does_not_answer_questions(self):
        # "" means current_step() could not read the bar. Guessing yes there
        # is what caused the failure in the first place.
        assert has_questions_step("") is False
        assert has_questions_step(None) is False


class TestWorkHistoryEmptiness:
    """A draft left by a failed run reopens with empty work rows, and Workday
    refuses the page for a missing Job Title/Company/From/To - while prefill
    never runs again (Accenture, 2026-08-21)."""

    class _Field:
        def __init__(self, value):
            self._value = value

        def get_attribute(self, name):
            return self._value

    class _Driver:
        def __init__(self, values):
            self._values = values

        def find_elements(self, *_):
            return [TestWorkHistoryEmptiness._Field(v) for v in self._values]

    def test_no_rows_at_all_is_empty(self):
        from main import work_history_is_empty
        assert work_history_is_empty(self._Driver([])) is True

    def test_rows_that_exist_but_are_blank_are_empty(self):
        from main import work_history_is_empty
        assert work_history_is_empty(self._Driver(["", "  ", None])) is True

    def test_one_filled_row_is_not_empty(self):
        """Prefilled history is the candidate's own record - never overwrite."""
        from main import work_history_is_empty
        assert work_history_is_empty(self._Driver(["", "Airbus SAS"])) is False


class TestUnattendedNeverBlocks:
    """An unrenderable posting made an unattended batch wait 300 seconds for a
    human, then fail with EOFError anyway (2026-08-22)."""

    def test_unknown_state_raises_instead_of_prompting(self):
        import app.pages as pages

        class _UX:
            d = None
            def find_all(self, *_): return []
        class _Page(pages.JobPage):
            def __init__(self): self.u = _UX(); self.gate = lambda *_: None
            def wait_for_posting(self): return True
            def dismiss_cookie_banner(self): return False
            def posting_state(self): return "unknown"

        page = _Page()
        pages.describe = lambda *_a, **_k: ""
        pages.snapshot_page = lambda *_a, **_k: {}
        import pytest
        with pytest.raises(pages.ApplicationStateError):
            page.start_application(interactive=False)
