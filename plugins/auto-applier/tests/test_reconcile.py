"""Rebuilding the record from the site.

The local record is a cache and caches drift - a run that dies between the
Submit click and the write leaves a submitted application recorded as failed.
These cover the parts that decide what gets overwritten, which is where a bug
would quietly re-apply to a job already applied to.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from app.record import DRAFT, FAILED, SUBMITTED, Applications
from reconcile import FROM_POSTING_STATE, known_links

A = "https://x/job/Toulouse-Area/Application-Manager-for-SE_JR10426904"
B = "https://x/job/Toulouse-Area/Ground-Segment-Engineer--m-f-_JR10435170"
C = "https://x/job/Toulouse-Area/Never-Recorded_JR10000001"


class TestPostingStateMapping:
    def test_the_site_saying_submitted_wins(self):
        assert FROM_POSTING_STATE["submitted"][0] == SUBMITTED

    def test_an_open_draft_is_a_draft(self):
        assert FROM_POSTING_STATE["draft"][0] == DRAFT

    def test_nothing_started_goes_back_on_the_retry_list(self):
        """A posting still offering "Apply" has no application on file,
        whatever the local record claims."""
        assert FROM_POSTING_STATE["new"][0] == FAILED

    def test_unknown_is_not_mapped_at_all(self):
        """Expired and pulled postings read as "unknown". Overwriting a
        confirmed submission with a guess is worse than leaving it alone."""
        assert "unknown" not in FROM_POSTING_STATE

    def test_every_mapping_carries_a_reason(self):
        for state, why in FROM_POSTING_STATE.values():
            assert state in (SUBMITTED, DRAFT, FAILED)
            assert why and isinstance(why, str)


class TestKnownLinks:
    def _views(self, tmp_path, **files):
        for name, urls in files.items():
            (tmp_path / name).write_text("".join(u + "\n" for u in urls),
                                         encoding="utf-8")

    def test_picks_up_the_append_only_era_files(self, tmp_path, monkeypatch):
        """The first reconcile after switching to the keyed store has to find
        everything the .txt files left behind."""
        import reconcile
        monkeypatch.setattr(reconcile, "OUTPUT_DIR", tmp_path)
        self._views(tmp_path, **{"succ_links.txt": [A],
                                 "missed_links.txt": [B, B, B],
                                 "skipped_links.txt": [C]})
        links = known_links(Applications(tmp_path))
        assert sorted(links) == sorted([A, B, C])

    def test_does_not_repeat_a_url(self, tmp_path, monkeypatch):
        """missed_links.txt held the same url nine times; reconciling it nine
        times would be nine page loads for one answer."""
        import reconcile
        monkeypatch.setattr(reconcile, "OUTPUT_DIR", tmp_path)
        self._views(tmp_path, **{"missed_links.txt": [B] * 9,
                                 "succ_links.txt": [B]})
        assert known_links(Applications(tmp_path)) == [B]

    def test_store_entries_come_first_and_are_not_duplicated(self, tmp_path,
                                                             monkeypatch):
        import reconcile
        monkeypatch.setattr(reconcile, "OUTPUT_DIR", tmp_path)
        store = Applications(tmp_path)
        store.record(A, SUBMITTED)
        store.save()
        self._views(tmp_path, **{"missed_links.txt": [A, B]})
        links = known_links(store)
        assert links[0] == A
        assert links.count(A) == 1
        assert B in links

    def test_no_files_at_all_is_not_an_error(self, tmp_path, monkeypatch):
        import reconcile
        monkeypatch.setattr(reconcile, "OUTPUT_DIR", tmp_path)
        assert known_links(Applications(tmp_path)) == []
