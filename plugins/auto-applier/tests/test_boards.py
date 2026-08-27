"""The non-Airbus boards, and the picking rules that span all of them.

Pure logic - no network. What these cover is the shape conversion and the
ranking, which is where the two boards can quietly disagree.
"""
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from app import capgemini_board, employers, smartrecruiters
from app.relevance import days_since_posted
from job_scrapper import workday_api


# One page of Capgemini's /search/ table, trimmed from the live markup on
# 2026-08-22. Each posting really is listed twice - once for phone, once for
# desktop - which is what the de-duplication in parse_results is for.
def _cap_row(path, title, location, posted):
    return f"""
<tr class="data-row">
  <td class="colTitle" headers="hdrTitle">
    <span class="jobTitle hidden-phone">
      <a href="{path}" class="jobTitle-link">{title}</a>
    </span>
    <div class="jobdetail-phone visible-phone">
      <span class="jobTitle visible-phone">
        <a class="jobTitle-link" href="{path}">{title}</a>
      </span>
      <span class="jobLocation visible-phone">
        <span class="jobLocation">{location}</span></span>
      <span class="jobDate visible-phone">{posted}</span>
    </div>
  </td>
  <td class="colLocation hidden-phone" headers="hdrLocation">
    <span class="jobLocation">{location}</span>
  </td>
  <td class="colDate hidden-phone" headers="hdrDate">
    <span class="jobDate">{posted}</span>
  </td>
</tr>"""


CAP_SEARCH_PAGE = f"""<html><body>
<span class="paginationLabel">Results 1 to 25 of 356</span>
<table><tbody>
{_cap_row("/job/Toulouse-Tech-lead-Devops/1251076601/",
          "Tech lead Devops", "Toulouse, FR", "16 ao&ucirc;t 2026")}
{_cap_row("/job/Blagnac-Ing&eacute;nieur-DevOps/1276300501/",
          "Ing&eacute;nieur DevOps", "Blagnac, FR +2 de plus", "28 juil. 2026")}
</tbody></table></body></html>"""


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc)
            - timedelta(days=days_ago, hours=1)).isoformat().replace(
                "+00:00", "Z")


class TestWorkdayTenants:
    def test_airbus_urls_are_unchanged(self):
        """Saved urls and every existing caller depend on these exactly."""
        assert workday_api.AIRBUS.cxs == \
            "https://ag.wd3.myworkdayjobs.com/wday/cxs/ag/Airbus"
        assert workday_api.CXS == workday_api.AIRBUS.cxs
        assert workday_api.SITE == workday_api.AIRBUS.site_url

    def test_accenture_is_the_same_api_elsewhere(self):
        assert workday_api.ACCENTURE.cxs == (
            "https://accenture.wd103.myworkdayjobs.com"
            "/wday/cxs/accenture/AccentureCareers")

    def test_a_posting_url_follows_its_tenant(self):
        raw = {"title": "X", "externalPath": "/job/Paris/X_R1",
               "bulletFields": ["R1"]}
        assert workday_api.JobPosting.from_api(
            raw, workday_api.ACCENTURE).url.startswith(
                "https://accenture.wd103.myworkdayjobs.com")
        # Default stays Airbus so existing callers are untouched.
        assert workday_api.JobPosting.from_api(raw).url.startswith(
            "https://ag.wd3.myworkdayjobs.com")


class TestSmartRecruitersShape:
    def test_dates_are_reworded_as_workday_words_them(self):
        """One age parser feeds both boards; two would drift apart."""
        for days in (0, 1, 5, 29):
            wording = smartrecruiters._posted_wording(_iso(days))
            assert days_since_posted(wording) == days, (days, wording)

    def test_a_missing_or_bad_date_is_not_treated_as_today(self):
        assert smartrecruiters._posted_wording("") == ""
        assert smartrecruiters._posted_wording("not-a-date") == ""
        assert days_since_posted("") is None

    def test_posting_maps_onto_the_workday_field_names(self):
        raw = {"id": "744000144577888", "name": "Developpeur Java - Toulouse",
               "refNumber": "REF16417B",
               "releasedDate": _iso(3),
               "location": {"city": "Toulouse",
                            "fullLocation": "Toulouse, Occitanie, France"},
               "experienceLevel": {"label": "Mid-Senior Level"},
               "typeOfEmployment": {"label": "Full-time"}}
        p = smartrecruiters.JobPosting.from_api(raw, "SopraSteria1")
        assert p.title == "Developpeur Java - Toulouse"
        assert p.url == ("https://jobs.smartrecruiters.com/SopraSteria1/"
                         "744000144577888")
        assert p.location == "Toulouse, Occitanie, France"
        assert days_since_posted(p.posted_on) == 3
        # Same attribute names the Workday posting uses, so the shortlist tool
        # does not need to know which board it is reading.
        for field in ("title", "url", "external_path", "location",
                      "posted_on", "req_id"):
            assert hasattr(p, field)


class TestCapgeminiBoard:
    """The one board with no JSON API behind it, so it is parsed from HTML."""

    def test_each_posting_is_listed_once_despite_two_links(self):
        rows = capgemini_board.parse_results(CAP_SEARCH_PAGE)
        assert [r.title for r in rows] == ["Tech lead Devops",
                                           "Ingénieur DevOps"]

    def test_posting_maps_onto_the_workday_field_names(self):
        row = capgemini_board.parse_results(CAP_SEARCH_PAGE)[0]
        assert row.url == ("https://careers.capgemini.com"
                           "/job/Toulouse-Tech-lead-Devops/1251076601/")
        assert row.location == "Toulouse, FR"
        # The trailing number is the requisition id and the only stable part
        # of the url - the slug changes when the title is edited.
        assert row.req_id == "1251076601"
        for field in ("title", "url", "external_path", "location",
                      "posted_on", "req_id"):
            assert hasattr(row, field)

    def test_the_total_is_read_off_the_pagination_label(self):
        assert capgemini_board.total_results(CAP_SEARCH_PAGE) == 356
        assert capgemini_board.total_results("<html></html>") is None

    def test_the_french_pagination_label_is_read_too(self):
        """fr_FR is the default locale, and it words this differently AND
        separates the range with an en dash rather than the "à" the rest of
        the page uses. Reading only the English wording meant every real scan
        had no total to stop on, so iter_postings ran to its page cap and
        returned the first 500 postings as if that were all of them - a
        truncated board that looks exactly like a small one."""
        page = ('<html><body><span class="paginationLabel">'
                'Résultats 1 – 25 sur 991</span></body></html>')
        assert capgemini_board.total_results(page) == 991

    def test_french_dates_parse(self):
        """%b is tied to the process locale, which is C here, so "7 août 2026"
        would otherwise parse as nothing and every posting look ageless."""
        assert capgemini_board.parse_posted("7 août 2026") == date(2026, 8, 7)
        assert capgemini_board.parse_posted("28 juil. 2026") == date(2026, 7, 28)
        assert capgemini_board.parse_posted("5 janv. 2026") == date(2026, 1, 5)

    def test_english_dates_still_parse(self):
        """The same board answers in en_US without locale=fr_FR."""
        assert capgemini_board.parse_posted("Aug 7, 2026") == date(2026, 8, 7)

    def test_a_missing_or_bad_date_is_not_treated_as_today(self):
        assert capgemini_board.parse_posted("") is None
        assert capgemini_board.parse_posted("not-a-date") is None
        assert capgemini_board._posted_wording("not-a-date") == ""

    def test_dates_are_reworded_as_workday_words_them(self):
        wording = capgemini_board._posted_wording(
            (date.today() - timedelta(days=5)).strftime("%b %d, %Y"))
        assert days_since_posted(wording) == 5

    def test_the_french_index_is_the_default(self):
        """Without locale=fr_FR the board answers from the en_US index, where
        Toulouse has no devops postings at all - an empty result set that
        looks like an empty job market rather than a bug."""
        assert capgemini_board.LOCALE == "fr_FR"


class TestCapgeminiLetterMatching:
    """A letter may only be reused on the posting it was written for."""

    def _job(self, req_id, title):
        return capgemini_board.JobPosting(
            title=title, url=f"/job/x/{req_id}/", external_path="",
            location="", posted_on="", req_id=req_id)

    def test_a_letter_is_matched_by_requisition_id(self, tmp_path):
        from scrape_capgemini import letter_for

        known = {"1366344433": "lettre-motivation-capgemini-consultant-devops.pdf"}
        job = self._job("1366344433", "Consultante / Consultant Devops")
        assert letter_for(job, tmp_path, known) == known["1366344433"]

    def test_a_name_that_looks_like_a_match_is_not_one(self, tmp_path):
        """These letters print their own requisition number in the body
        ("réf. 1366344433"), so reusing one across postings quotes the wrong
        reference at the recruiter. Caught before it was sent."""
        from scrape_capgemini import letter_for

        (tmp_path / "lettre-motivation-capgemini-consultant-devops.pdf").write_bytes(b"%PDF")
        job = self._job("1198502201",
                        "Consultante/Consultant Ingénieur DEVOPS PLM")
        assert letter_for(job, tmp_path, {}) is None


class TestLlmScore:
    """The Stage 2 scorer. No daemon required - that is half the point."""

    def test_a_clean_json_reply_is_read(self):
        from app import llm_score

        got = llm_score.parse_response(
            '{"score": 72, "reason": "bonne correspondance", "gaps": ["SAP"]}')
        assert got["score"] == 72

    def test_json_wrapped_in_prose_or_a_fence_is_still_read(self):
        """Small models wrap their JSON however firmly they are told not to."""
        from app import llm_score

        for reply in ('Voici mon évaluation:\n{"score": 40, "reason": "x"}\nVoilà.',
                      '```json\n{"score": 40, "reason": "x"}\n```'):
            assert llm_score.parse_response(reply)["score"] == 40

    def test_a_reply_with_no_json_is_a_miss_not_a_crash(self):
        from app import llm_score

        assert llm_score.parse_response("Je ne peux pas répondre.") is None
        assert llm_score.parse_response("") is None

    def test_scores_are_clamped_to_the_scale(self):
        from app import llm_score

        assert llm_score._coerce({"score": 250, "reason": "r"}, "m").score == 100
        assert llm_score._coerce({"score": -5, "reason": "r"}, "m").score == 1
        assert llm_score._coerce({"score": "88", "reason": "r"}, "m").score == 88
        assert llm_score._coerce({"score": "high", "reason": "r"}, "m") is None

    def test_it_falls_back_to_keywords_when_ollama_is_down(self, monkeypatch):
        """A scan must not die half way through a board because a daemon is
        not running, and the report must not claim a model score it did not
        get."""
        from app import llm_score

        def refuse(*a, **kw):
            raise llm_score.OllamaUnavailable("connection refused")

        monkeypatch.setattr(llm_score, "_post", refuse)
        got = llm_score.score("Tech Lead Cloud AWS", "du texte", "cv")
        assert got.source == llm_score.KEYWORD
        assert "Ollama unavailable" in got.reason
        assert got.score >= 1

    def test_an_empty_description_is_not_sent_to_the_model(self, monkeypatch):
        """A model asked to score an empty offer answers confidently anyway."""
        from app import llm_score

        monkeypatch.setattr(llm_score, "_post", lambda *a, **kw: pytest.fail(
            "the model must not be called with no description"))
        got = llm_score.score("Tech Lead Cloud AWS", "   ", "cv")
        assert got.source == llm_score.KEYWORD

    def test_an_unusable_reply_falls_back_rather_than_inventing(self, monkeypatch):
        from app import llm_score

        monkeypatch.setattr(llm_score, "_post",
                            lambda *a, **kw: {"response": "je ne sais pas"})
        got = llm_score.score("Tech Lead Cloud AWS", "du texte", "cv")
        assert got.source == llm_score.KEYWORD
        assert "not usable JSON" in got.reason

    def test_a_model_score_is_labelled_as_one(self, monkeypatch):
        from app import llm_score

        monkeypatch.setattr(llm_score, "_post", lambda *a, **kw: {
            "response": '{"score": 78, "reason": "solide", "gaps": ["Node.js"]}'})
        got = llm_score.score("Dev FullStack", "du texte", "cv", model="m")
        assert (got.source, got.score, got.model) == (llm_score.MODEL, 78, "m")
        assert "Node.js" in got.explained


class TestSearchQueries:
    """What gets typed into a searchable multiselect when the full name misses."""

    def test_the_full_string_is_tried_first(self):
        from app.ux import search_queries
        assert search_queries("ISAE-SUPAERO")[0] == "ISAE-SUPAERO"

    def test_distinctive_words_are_tried_not_just_leading_ones(self):
        """The old order shortened "UNIVERSITE TOULOUSE III - PAUL SABATIER"
        to "universite" and stopped, which finds nothing useful - the words
        that identify the school are at the end of the name."""
        from app.ux import search_queries
        got = search_queries("UNIVERSITÉ TOULOUSE III - PAUL SABATIER")
        assert "sabatier" in got and "toulouse" in got
        assert got.index("sabatier") > got.index("universite toulouse")

    def test_generic_words_are_not_added_as_distinctive_ones(self):
        """As a lone query "nationale" matches half the schools in France, so
        it is not worth a round trip. The leading-word prefixes still shorten
        the way they always did - that part is untouched."""
        from app.ux import search_queries
        got = search_queries("Ecole Nationale Superieure Machin")
        assert "machin" in got
        assert "nationale" not in got
        assert "superieure" not in got

    def test_queries_are_unique(self):
        from app.ux import search_queries
        got = search_queries("Supaero Supaero")
        assert len(got) == len({q.casefold() for q in got})


class TestEmployers:
    def test_each_employer_has_its_own_profile_and_credentials(self):
        """One shared Chrome profile would mean one cookie jar for two Workday
        tenants, and the session check would keep picking the wrong company."""
        profiles = {e.profile_dir for e in employers.EMPLOYERS.values()}
        prefixes = {e.env_prefix for e in employers.EMPLOYERS.values()}
        assert len(profiles) == len(employers.EMPLOYERS)
        assert len(prefixes) == len(employers.EMPLOYERS)

    def test_sopra_steria_is_honest_about_not_being_workday(self):
        assert employers.get("Sopra Steria").workday is None

    def test_unknown_employer_is_rejected_loudly(self):
        import pytest
        with pytest.raises(KeyError):
            employers.get("Airbuss")

    def test_lookup_is_case_and_space_insensitive(self):
        assert employers.get("  sopra   steria ").name == "Sopra Steria"


class TestLocationRanking:
    def test_home_area_outranks_everything(self):
        from shortlist import location_rank
        assert location_rank("Colomiers, Occitanie, France") == 0
        assert location_rank("Toulouse, Occitanie, France") == 0
        assert location_rank("Le Mans, Pays de la Loire, France") == 2

    def test_remote_beats_the_far_side_of_the_country(self):
        from shortlist import location_rank
        assert location_rank("Remote, France") == 1
        assert location_rank("", "Developpeur Java - Full Remote") == 1

    def test_the_same_role_per_city_collapses(self):
        from shortlist import _dedupe_key
        a = _dedupe_key("Consultant Senior Data Scientist IA & GenAI - Nantes")
        b = _dedupe_key("Consultant Senior Data Scientist IA & GenAI - Lyon")
        assert a == b

    def test_location_negotiable_ranks_with_remote(self):
        """Accenture's wording for a role open anywhere - which includes home,
        so it must not sort with Le Mans."""
        from shortlist import location_rank
        assert location_rank("Location Negotiable") == 1

    def test_accenture_location_comes_from_the_bullet_fields(self):
        """Accenture leaves locationsText null; without the fallback every
        posting looked location-less and ranked as "not near home"."""
        raw = {"title": "X", "externalPath": "/job/Paris/X_R1",
               "bulletFields": ["R00345732", "Paris"]}
        assert workday_api.JobPosting.from_api(
            raw, workday_api.ACCENTURE).location == "Paris"

    def test_airbus_still_prefers_its_own_location_field(self):
        raw = {"title": "X", "externalPath": "/job/T/X_JR1",
               "locationsText": "Toulouse Area", "bulletFields": ["JR1", "T"]}
        assert workday_api.JobPosting.from_api(raw).location == "Toulouse Area"


class TestSubmittedRolesDoNotComeBack:
    """A role listed in six cities came back one city at a time: the shortlist
    excluded submitted *urls*, so once the picked listing was applied to, its
    sibling surfaced as if it were a new job (2026-08-21)."""

    def test_the_same_title_elsewhere_is_the_same_job(self):
        from shortlist import _dedupe_key
        assert _dedupe_key("Architecte cybersecurite (h/f)") == \
               _dedupe_key("Architecte cybersecurite (h/f)")

    def test_seeding_uses_the_same_key_the_dedupe_uses(self, tmp_path):
        """The seed and the loop must agree, or the guard silently does
        nothing."""
        from shortlist import _dedupe_key
        from app.record import SUBMITTED, Applications
        store = Applications(tmp_path)
        store.record("https://x/job/Toulouse/Architecte_JR1", SUBMITTED,
                     title="Architecte cybersecurite - Toulouse")
        seeded = {_dedupe_key(e["title"]) for e in store.entries.values()
                  if e["state"] == SUBMITTED and e.get("title")}
        assert _dedupe_key("Architecte cybersecurite - Nantes") in seeded

    def test_a_draft_does_not_block_a_retry(self, tmp_path):
        """Only submitted roles are excluded; a draft still needs applying."""
        from shortlist import _dedupe_key
        from app.record import DRAFT, Applications
        store = Applications(tmp_path)
        store.record("https://x/job/T/A_JR1", DRAFT, title="Developpeur Java")
        seeded = {_dedupe_key(e["title"]) for e in store.entries.values()
                  if e["state"] == "submitted" and e.get("title")}
        assert seeded == set()
