"""Locator regressions caught by probing the live board on 2026-08-19.

Pure string assertions - no browser, no network. They exist so the two broken
sign-in locators cannot quietly come back, and so the honeypot stays known.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app.path as loc


def test_signin_is_not_positional():
    """"(//button)[2]" matched the cookie-consent Accept button, not Sign In."""
    assert loc.signin_xpath != "(//button)[2]"
    assert "utilityButtonSignIn" in loc.signin_xpath


def test_signin2_targets_a_real_element():
    """The old "//div[@aria-label='Sign In']" matched nothing on the page."""
    assert "aria-label='Sign In'" not in loc.signin2_xpath
    assert "signInLink" in loc.signin2_xpath


def test_apply_locator_covers_the_automation_id():
    # Same id whether the CTA reads Apply or Continue Application.
    assert "adventureButton" in loc.apply_button_path


def test_cookie_banner_locator_exists():
    assert "legalNoticeAcceptButton" in loc.cookie_accept


def test_application_routes_are_defined():
    # "Start Your Application" must be answered or the run stalls there.
    assert "applyManually" in loc.apply_manually
    assert "useMyLastApplication" in loc.use_last_button_path or \
           "Use My Last Application" in loc.use_last_button_path


def test_honeypot_is_known():
    """Workday's bot trap must be identifiable so nothing writes to it."""
    assert "beecatcher" in loc.honeypot_field
    assert "beecatcher" in loc.HONEYPOT_NAMES


def test_source_option_is_a_list_item():
    """Read off the live dropdown: options are <li role="option">, not divs.

    The div form matched nothing, and the run died on a bare TimeoutException
    with no clue as to why.
    """
    assert "div[normalize-space()='Airbus Careers Website']" not in \
        loc.career_website_button_path
    assert "li[@role='option']" in loc.career_website_button_path


def test_save_and_continue_uses_the_footer_automation_id():
    """The English label alone breaks the moment the UI renders in French."""
    assert "pageFooterNextButton" in loc.save_cont_path


def test_education_controls_are_scoped_through_their_wrapper():
    """The inputs carry only a generated id (education-26--school).

    Matching them on data-automation-id finds nothing, which showed up live as
    "fields did not appear" followed by Workday refusing the page for missing
    School and Degree.
    """
    for xpath in (loc.education_school, loc.education_degree,
                  loc.education_field_of_study):
        assert "formField-" in xpath
        assert "--school'" not in xpath.replace("formField-school", "")


def test_gender_locator_is_not_positional():
    """"(//button[normalize-space()='Select One'])[1]" matched the
    "How Did You Hear About Us?" dropdown, not Gender."""
    assert loc.gend != "(//button[normalize-space()='Select One'])[1]"
    assert "gender" in loc.gend.lower()


def test_birth_date_field_names_its_real_format():
    """Workday's date input is MM/DD/YYYY and the digits go in unchanged.

    The old name birth_ddmmyyyy stated the opposite, which reads as an
    off-by-a-month bug and invites someone to "correct" a value that is right.
    """
    from app.config import CandidateData
    assert not hasattr(CandidateData, "birth_ddmmyyyy")
    assert hasattr(CandidateData, "birth_mmddyyyy")
