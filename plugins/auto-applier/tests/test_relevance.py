"""Which postings the run will and will not apply to.

Every application goes out under the candidate's real name, so the picks have
to be defensible. These pin the calls that were wrong while tuning against the
live board on 2026-08-20.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.relevance import (days_since_posted, is_interesting,
                           is_lower_bound, posted_within, score_title)


class TestPostedAge:
    def test_reads_workdays_wording(self):
        assert days_since_posted("Posted Today") == 0
        assert days_since_posted("Posted Yesterday") == 1
        assert days_since_posted("Posted 9 Days Ago") == 9
        assert days_since_posted("Posted 1 Day Ago") == 1

    def test_thirty_plus_is_thirty(self):
        assert days_since_posted("Posted 30+ Days Ago") == 30

    def test_unreadable_is_none_not_zero(self):
        """Treating an unknown age as "today" would apply to stale postings."""
        assert days_since_posted("") is None
        assert days_since_posted("Reposted recently") is None

    def test_window_excludes_unknown_ages(self):
        assert posted_within("Posted 9 Days Ago", 30) is True
        assert posted_within("Posted 30+ Days Ago", 29) is False
        assert posted_within("", 30) is False


class TestDisqualified:
    def test_the_bulk_of_the_board_is_rejected(self):
        for title in ("Buyer for Aftersales H/F",
                      "Supply Officer (M/F)",
                      "Qualiticien Machine Outil - (h/f)",
                      "Airbus Atlantic - Responsable d'Equipe Autonome de "
                      "Production A350",
                      "Strategic Buyer - Electrical Systems (PELG) (M/F)"):
            assert is_interesting(title) is False, title

    def test_a_disqualifier_beats_a_strong_match(self):
        # "Software" does not rescue a procurement role.
        score, why = score_title("Software Procurement Buyer")
        assert score < 0 and "buyer" in why

    def test_student_contracts_are_out_of_scope(self):
        # Stage 1 targets normal jobs; the internship flow was removed.
        for title in ("Stage - Data Scientist (H/F)",
                      "Alternance Developpeur Python",
                      "Software Engineering Internship"):
            assert is_interesting(title) is False, title


class TestInteresting:
    def test_core_software_and_ai_roles(self):
        for title in ("AI Software Developer (M,F)",
                      "Junior Data Scientist / AI engineer (m/w/d)",
                      "Project Manager Cyber Toulouse (H/F)",
                      "Ground Segment Engineer (m/f)"):
            assert is_interesting(title) is True, title

    def test_french_it_role_reaches_the_threshold(self):
        assert is_interesting(
            "Ingenieur(e) Infrastructure IT Securisee - "
            "Administrateur(e) Systeme et Reseau (m/f)") is True

    def test_a_lone_weak_term_is_not_enough(self):
        """Acoustic Test Engineer matched "test engineer" and nothing else -
        the same score Ground Segment Engineer used to get."""
        assert is_interesting("Acoustic Test Engineer (f/m)") is False


class TestScoringIsHonest:
    def test_one_word_counts_once(self):
        """"Systeme" matched both "system" and "systeme"; French titles
        outscored identical English ones purely on spelling."""
        fr, _ = score_title("Ingenieur Systeme et Reseau")
        en, _ = score_title("System and Network Engineer")
        assert fr == en

    def test_accents_do_not_change_the_score(self):
        assert score_title("Ingénieur Systéme et Réseau")[0] == \
               score_title("Ingenieur Systeme et Reseau")[0]

    def test_the_reason_names_the_terms(self):
        score, why = score_title("Embedded Software Engineer")
        assert score > 0
        assert "software" in why and "embedded" in why

    def test_an_unmatched_title_says_so(self):
        assert score_title("Responsable Plateau Cabine")[1] == "no matching term"


class TestWordBoundaries:
    """A first pass shortlisted 40 assembly, maintenance and non-destructive
    testing jobs as AI roles: "ai" was matching Airbus and Ajusteur, and "ia"
    was matching industrialisation."""

    def test_ai_does_not_match_airbus_or_ajusteur(self):
        for title in ("Airbus Atlantic - Ajusteur Monteur structure avion",
                      "Airbus Atlantic - Assembleur structure avion",
                      "Aircraft Maintenance Engineer EASA B1 m/f"):
            assert score_title(title)[0] <= 0, title

    def test_ia_does_not_match_industrialisation(self):
        for title in ("Preparateur industrialisation (H/F)",
                      "Technicien Test & Industrialisation (F/H)",
                      "Testia SAS - Technicien.ne en Controle Non Destructif"):
            assert score_title(title)[0] <= 0, title

    def test_ai_still_matches_when_it_is_the_word(self):
        assert "ai" in score_title("AI Software Developer (M,F)")[1]
        assert "ia" in score_title("Ingenieur IA et Donnees (H/F)")[1]

    def test_it_is_a_word_not_a_fragment(self):
        assert "it" in score_title("Ingenieur IT Systeme et Reseau")[1]
        # "it" inside "Digital" / "Suivi" must not fire on its own.
        assert "it" not in score_title("Responsable Suivi Qualite Cabine")[1]

    def test_long_terms_still_match_their_french_ending(self):
        # "logistic" must catch "logistique", "approvisionn" the full word.
        assert score_title("Responsable Logistique (H/F)")[0] < 0
        assert score_title("Approvisionneur Serie (H/F)")[0] < 0


class TestAdjacentButNotTheJob:
    """Roles the keyword model liked for the right words and the wrong reason."""

    def test_patent_attorney_is_not_a_software_role(self):
        assert score_title(
            "Patent Attorney Physics/Electronics/Avionics/Computer Science")[0] < 0

    def test_bid_management_is_sales_side(self):
        for title in ("Bid Manager Defence Digital and Cyber France (h/f)",
                      "Bid & Project Manager en Cybersecurite (H/F)"):
            assert score_title(title)[0] < 0, title

    def test_instructor_roles_teach_rather_than_build(self):
        assert score_title("Instructeur Avionique (h/f)")[0] < 0

    def test_cnc_machining_is_not_digital(self):
        for title in ("Programmeur de machines a Commandes Numeriques (H/F)",
                      "Technicien Programmation Commande Numerique"):
            assert score_title(title)[0] < 0, title


class TestPlusIsAFloorNotAnAge:
    """231 of the 436 Airbus postings on 2026-08-21 read "Posted 30+ Days Ago".
    Treating that as exactly 30 let every one of them through a 30-day window,
    so most of what a "last 30 days" run scanned was older than 30 days."""

    def test_plus_is_recognised_as_a_lower_bound(self):
        assert is_lower_bound("Posted 30+ Days Ago") is True
        assert is_lower_bound("Posted 30 Days Ago") is False
        assert is_lower_bound("Posted Today") is False

    def test_thirty_plus_is_not_within_thirty_days(self):
        assert posted_within("Posted 30+ Days Ago", 30) is False

    def test_exactly_thirty_still_is(self):
        assert posted_within("Posted 30 Days Ago", 30) is True

    def test_a_floor_fits_a_strictly_wider_window(self):
        """At least 30 days old can still be inside 90; it cannot be inside 30."""
        assert posted_within("Posted 30+ Days Ago", 90) is True
        assert posted_within("Posted 30+ Days Ago", 31) is True

    def test_the_floor_value_itself_is_unchanged(self):
        """Callers that only want a number for display still get 30."""
        assert days_since_posted("Posted 30+ Days Ago") == 30
