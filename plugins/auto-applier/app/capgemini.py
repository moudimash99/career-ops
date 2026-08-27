"""Capgemini applications on SAP SuccessFactors (careers.capgemini.com).

Not Workday, so none of app/pages.py applies. Ported from
career-ops/scripts/apply-capgemini.mjs (Node + Playwright), whose selectors and
quirks were established against the live form on 2026-08-20. Keep that file as
the reference: its comments are a field log, and these four findings are the
ones that cost real runs there.

  1. The cover-letter slot arrives holding the PREVIOUS application's letter,
     drawn from the candidate profile. Unlike the CV (whose control reads
     "Modifier le document"), it only offers "Supprimer le document" - so the
     stale file has to be removed before the right one goes on. Skipping this
     silently attaches another role's letter, which is worse than none.
  2. Disability and gender each gate their detail field behind a consent
     dropdown. Answer the consent first or the detail field is disabled.
  3. The combobox popup does not always open on the first click under load, so
     every pick gets two attempts and its value is read back afterwards - a
     click that lands on a closing popup is a silent no-op.
  4. Capgemini's fixed navbar overlaps the Postuler control at some window
     sizes and swallows the click. UX.click's JS-click fallback gets past it.

What this port DROPS on purpose: the original ran a detached Chrome over CDP so
prefilled tabs survived the script exiting, because a human had to review each
one and click Postuler. This submits, so there is nothing to leave open - one
tab, reused, and the ordinary build_driver session.

Two things this repo insists on that the original did not have to:

  - Clicking Submit is not evidence of submitting (AGENTS.md). submit()
    returns False unless a confirmation marker actually appears.
  - Every outcome is recorded in output/capgemini/applications.json by url, so
    a posting already submitted is never applied to twice.
"""
from __future__ import annotations

import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from selenium.common.exceptions import StaleElementReferenceException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select

import app.path as loc
from app.ux import UX

CAREERS = "https://careers.capgemini.com"

# SuccessFactors re-renders the form after an upload; these are how long that
# takes in practice, carried over from the Playwright script's waits.
UPLOAD_SETTLE_S = 3.0
DELETE_SETTLE_S = 2.5
MODAL_SETTLE_S = 2.0

# How long to give the submit round trip. Named rather than inline so the
# browser tests can shrink them; a real run wants the generous values.
POST_SUBMIT_SETTLE_S = 4.0
CONFIRM_TIMEOUT_S = 15.0

# Where a page that could not be confirmed is kept. Alongside the employer's
# other output, not in the repo.
SNAPSHOT_DIR = Path(__file__).resolve().parent.parent / "output" / "capgemini"


def _fold(text: str) -> str:
    """Casefolded and accent-stripped, for comparing French option labels."""
    norm = unicodedata.normalize("NFKD", text or "")
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    return " ".join(norm.casefold().split())


class CapgeminiError(RuntimeError):
    """The flow could not continue on this posting."""


@dataclass
class Role:
    """One shortlisted posting, plus which documents belong to it."""
    url: str
    title: str = ""
    family: str = ""
    location: str = ""
    cv: Optional[Path] = None
    letter: Optional[Path] = None
    tracker: Optional[int] = None


@dataclass
class Outcome:
    """What happened on one posting - the caller turns this into a record."""
    submitted: bool = False
    filled: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    readback: dict = field(default_factory=dict)

    @property
    def note(self) -> str:
        return "; ".join(self.notes)[:300]


# ---------------------------------------------------------------------------
# Generic upload. app/file_uploader.py is Workday-shaped (it looks for
# data-automation-id="file-upload-input-ref"); SuccessFactors has none of that,
# it injects a plain input[type=file] once the upload control is clicked.
# ---------------------------------------------------------------------------
_UNHIDE_JS = """
const el = arguments[0];
el.style.display = 'block';
el.style.visibility = 'visible';
el.style.opacity = 1;
el.removeAttribute('hidden');
"""


def set_file_input(driver, path) -> None:
    """Put `path` into the page's file input, un-hiding it first.

    Playwright's setInputFiles works on a hidden input; Selenium's send_keys
    raises ElementNotInteractableException on one, so the input has to be made
    visible first. This is the single place that difference shows up.
    """
    els = driver.find_elements(By.XPATH, loc.CAP_FILE_INPUT)
    if not els:
        raise CapgeminiError("no input[type=file] on the page")
    el = els[0]
    try:
        driver.execute_script(_UNHIDE_JS, el)
    except Exception:
        pass
    el.send_keys(str(Path(path).expanduser().resolve()))


class CapgeminiForm:
    """The apply form for one posting, driven one control at a time."""

    def __init__(self, driver, timeout_s: int = 20, micro_wait_s: float = 0.4):
        self.d = driver
        self.ux = UX(driver, timeout_s, micro_wait_s)

    # -- page level --------------------------------------------------------

    def dismiss_consent(self) -> None:
        """Clear the cookie banner, which blocks the candidate portal."""
        if self.ux.wait_visible(loc.CAP_COOKIE_ACCEPT, 3):
            self.ux.click_if_present(loc.CAP_COOKIE_ACCEPT)
            time.sleep(0.4)

    def open_apply_form(self, url: str) -> Optional[str]:
        """Load a posting and get into its form.

        Returns "authenticated", "anonymous", "already_applied", or None when
        the form never appeared - which usually means the posting has closed.
        """
        self.d.get(url)
        self.dismiss_consent()
        if "careers.capgemini.com" not in self.d.current_url:
            return None

        if not self.ux.wait_visible(loc.CAP_POSTULER, 10):
            return None
        self.ux.click(loc.CAP_POSTULER)

        # Some postings route through a menu, some go straight to the form.
        if self.ux.wait_visible(loc.CAP_POSTULER_NOW, 6):
            self.ux.click(loc.CAP_POSTULER_NOW)

        deadline = time.time() + 30
        while time.time() < deadline:
            if self.ux.visible(loc.CAP_AUTH_PHONE):
                return "authenticated"
            if self.ux.visible(loc.CAP_ANON_EMAIL):
                return "anonymous"
            # Checked after the two forms, never before: the marker includes
            # the back button, which also exists on pages that are merely on
            # their way to the form.
            if ("isapplicationdenied=true" in self.d.current_url.casefold()
                    or self.ux.visible(loc.CAP_ALREADY_APPLIED)):
                return "already_applied"
            time.sleep(0.3)
        return None

    def sign_in(self, url: str, email: str, password: str) -> bool:
        """Sign in through the "Connectez-vous" modal on an apply page.

        Required, not optional: signed out, SuccessFactors serves the
        register-and-apply form, and only the FIRST application of a batch
        could ever submit. The session then covers every later posting in the
        same Chrome profile.
        """
        form = self.open_apply_form(url)
        if form is None:
            return False
        if form == "authenticated":
            return True
        if form == "already_applied":
            # Only a signed-in visitor is ever told this: signed out, the site
            # serves the register-and-apply form and says nothing about an
            # existing application. So the session is good, and there is no
            # sign-in link left on the page to click.
            return True

        if not self.ux.wait_visible(loc.CAP_SIGNIN_LINK, 5):
            return False
        self.ux.click(loc.CAP_SIGNIN_LINK)
        time.sleep(3.5)

        if not self.ux.wait_visible(loc.CAP_LOGIN_DIALOG, 6):
            return False
        self.ux.type(loc.CAP_LOGIN_USER, email)
        self.ux.type(loc.CAP_LOGIN_PASS, password, secret=True)
        self.ux.click(loc.CAP_LOGIN_SUBMIT)
        time.sleep(11)

        # The url alone is an unreliable signal here. Success is better judged
        # by the login dialog having closed AND the registration-only field
        # being gone.
        dialog_gone = not self.ux.wait_visible(loc.CAP_LOGIN_DIALOG, 2)
        register_gone = not self.ux.wait_visible(loc.CAP_REGISTER_MARKER, 2)
        return dialog_gone and (register_gone
                                or "portalcareer" in self.d.current_url)

    # -- fields ------------------------------------------------------------

    def fill(self, xpath: str, text: str, label: str, log: list) -> bool:
        """Set a text input, recording the label when it takes."""
        if not self.ux.wait_visible(xpath, 1.5):
            return False
        try:
            self.ux.type(xpath, text)
        except Exception:
            return False
        log.append(label)
        return True

    def select_native(self, xpath: str, wanted: str, label: str,
                      log: list) -> bool:
        """One of the two real <select> elements (phone code, country)."""
        if not self.ux.wait_visible(xpath, 1.5):
            return False
        try:
            sel = Select(self.ux.find(xpath))
            want = _fold(wanted)
            for opt in sel.options:
                if _fold(opt.text) == want:
                    sel.select_by_visible_text(opt.text)
                    log.append(label)
                    return True
        except Exception:
            return False
        return False

    def pick_combo(self, index: int, choices, label: str,
                   log: list, type_ahead: bool = False) -> bool:
        """Open a SAP combobox and click one of its options.

        Never presses Enter: in a form Enter can submit, a click cannot. Two
        attempts, because the popup does not reliably open on the first click
        under load, and the value is read back afterwards - clicking an option
        on a popup that is already closing is a silent no-op.
        """
        xpath = loc.cap_combo(index)
        if not self.ux.wait_visible(xpath, 1.5):
            return False
        try:
            if not self.ux.find(xpath).is_enabled():
                return False          # gated behind a consent question
        except StaleElementReferenceException:
            return False

        wanted = [choices] if isinstance(choices, str) else list(choices)

        for attempt in (1, 2):
            try:
                self.ux.click(xpath)
            except Exception:
                pass
            time.sleep(0.7 if attempt == 1 else 1.6)

            if type_ahead:
                try:
                    self.ux.find(xpath).send_keys(wanted[0])
                except Exception:
                    pass
                time.sleep(0.8)

            options = []
            for el in self.ux.find_all(loc.CAP_POPUP_OPTION):
                try:
                    if el.is_displayed():
                        options.append(el)
                except Exception:
                    continue

            for want in wanted:
                target = _fold(want)
                for opt in options:
                    try:
                        if _fold(opt.text) != target:
                            continue
                        opt.click()
                    except Exception:
                        continue
                    time.sleep(0.4)
                    try:
                        got = (self.ux.value_of(self.ux.find(xpath)) or "").strip()
                    except Exception:
                        got = ""
                    if got and got != loc.CAP_UNSET:
                        log.append(label)
                        return True

            try:
                self.ux.find(xpath).send_keys(Keys.ESCAPE)
            except Exception:
                pass
            time.sleep(0.4)
        return False

    # -- documents ---------------------------------------------------------

    def attach(self, control_xpath: str, path, label: str,
               out: "Outcome") -> bool:
        """Click an upload control and set the file input it injects."""
        if not self.ux.wait_visible(control_xpath, 4):
            out.notes.append("no %s control found" % label)
            return False
        try:
            self.ux.click(control_xpath)
        except Exception:
            pass
        time.sleep(1.8)

        if not self.ux.find_all(loc.CAP_FILE_INPUT):
            out.notes.append("%s file input never appeared" % label)
            self._escape()
            return False
        try:
            set_file_input(self.d, path)
        except Exception as e:
            out.notes.append("%s: %s" % (label, type(e).__name__))
            return False
        out.filled.append("%s %s" % (label, Path(path).name))
        time.sleep(UPLOAD_SETTLE_S)
        return True

    def clear_letter(self) -> bool:
        """Remove whatever letter the slot arrived holding. True if one went.

        Finding 1 in this module's header: the slot is pre-populated from the
        candidate profile, so it arrives holding whatever the LAST application
        uploaded. That is true whether or not this role has a letter of its
        own, so clearing is separate from attaching - a role with no tailored
        letter must still not send the previous role's.
        """
        if not self.ux.wait_visible(loc.CAP_LETTER_DELETE, 2.5):
            return False
        try:
            self.ux.click(loc.CAP_LETTER_DELETE)
        except Exception:
            return False
        time.sleep(DELETE_SETTLE_S)
        if self.ux.wait_visible(loc.CAP_DIALOG_CONFIRM, 2.5):
            self.ux.click_if_present(loc.CAP_DIALOG_CONFIRM)
            time.sleep(MODAL_SETTLE_S)
        return True

    def replace_letter(self, path, out: "Outcome") -> bool:
        """Attach the cover letter, clearing the previous one first."""
        self.clear_letter()
        return self.attach(loc.CAP_LETTER_CONTROL, path, "lettre", out)

    def accept_privacy(self, out: "Outcome") -> bool:
        """Acknowledge the privacy declaration modal."""
        if not self.ux.wait_visible(loc.CAP_PRIVACY_BUTTON, 3):
            return False
        try:
            self.ux.click(loc.CAP_PRIVACY_BUTTON)
        except Exception:
            return False
        time.sleep(MODAL_SETTLE_S)
        if self.ux.wait_visible(loc.CAP_DIALOG_CONFIRM, 4):
            self.ux.click_if_present(loc.CAP_DIALOG_CONFIRM)
            out.filled.append("declaration de confidentialite")
            time.sleep(0.8)
            return True
        out.notes.append("privacy modal has no accept button")
        self._escape()
        return False

    # -- verification ------------------------------------------------------

    _READBACK_JS = r"""
const v = (id) => {
  const el = document.getElementById(id);
  return el ? (el.value === undefined ? null : el.value) : null;
};
const docs = document.body.innerText.match(/[\w.\-]+\.pdf/g);
return {
  "documents": docs ? docs.slice(0, 4) : [],
  "telephone": v("tor__fcellPhone") || v("fbclc_phoneNumber"),
  "pays de residence": v("9:_input"),
  "autorisation de travail": v("13:_input"),
  "ancien salarie": v("17:_input"),
  "consentement handicap": v("21:_input"),
  "handicap": v("25:_input"),
  "consentement genre": v("29:_input"),
  "genre": v("33:_input"),
  "WhatsApp": v("37:_input")
};
"""

    def readback(self) -> dict:
        """Read every field back off the page.

        A field that silently failed to take is worse than one never touched,
        because nobody would think to check it.
        """
        try:
            return self.d.execute_script(self._READBACK_JS) or {}
        except Exception:
            return {}

    def unset_fields(self, readback: dict) -> list:
        """Which readback entries are still empty or still say Selectionner."""
        empty = []
        for key, val in (readback or {}).items():
            if key == "documents":
                if not val:
                    empty.append(key)
            elif not val or str(val).strip() == loc.CAP_UNSET:
                empty.append(key)
        return empty

    def submit(self, out: "Outcome", wait_for_captcha: bool = False, role_url: str = "") -> bool:
        """Click the submit control and confirm the application landed.

        Returns False rather than raising when it cannot confirm: an
        unconfirmed application is a draft, not a failure, and recording it as
        submitted would mean never coming back to it.
        """
        button = self._find_submit()
        if button is None:
            out.notes.append("no submit control found")
            return False
        text, xpath = button
        try:
            self.ux.click(xpath)
        except Exception as e:
            out.notes.append("submit click failed: %s" % type(e).__name__)
            return False
        out.filled.append("clicked %r" % text)
        time.sleep(POST_SUBMIT_SETTLE_S)

        # Check for captcha
        has_captcha = False
        try:
            has_captcha = self.d.execute_script('return !!document.querySelector(\\'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="datadome"], iframe[title*="recaptcha" i]\\');')
        except Exception:
            pass

        if has_captcha:
            if wait_for_captcha:
                print("\\n⚠️ Captcha detected. Please solve it in the browser window...")
                deadline = time.time() + 300
                while time.time() < deadline:
                    try:
                        still_there = self.d.execute_script('return !!document.querySelector(\\'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="datadome"], iframe[title*="recaptcha" i]\\');')
                        if not still_there:
                            break
                    except Exception:
                        pass
                    time.sleep(1)
                time.sleep(4)
                out.notes.append("Captcha solved by user")
            else:
                out.notes.append("Captcha appeared on submit. Skipped.")
                if role_url:
                    captcha_file = Path(__file__).resolve().parent.parent / "output" / "captcha_links.txt"
                    with open(captcha_file, "a", encoding="utf-8") as cf:
                        cf.write(role_url + "\\n")
                return False

        if self.confirm_submitted():
            return True

        bad = self._rejected_fields()
        shot = self._snapshot("unconfirmed")
        out.notes.append(
            "clicked %r but no confirmation appeared" % text
            + ("; form rejected: " + ", ".join(bad) if bad else "")
            + ("; page saved to %s" % shot if shot else ""))
        return False

    def _snapshot(self, label: str) -> Optional[Path]:
        """Save the page's text, and return where it went.

        An unconfirmed submit is ambiguous - the application may have landed
        and only the confirmation wording be unknown, which is exactly what
        happened on the first live run here. Without the page text the only
        way to tell the two apart is to reload the posting and read it by
        hand, so the page is kept rather than described.
        """
        try:
            SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
            path = SNAPSHOT_DIR / f"{label}-{time.strftime('%Y%m%d-%H%M%S')}.txt"
            body = self.d.execute_script(
                "return document.body.innerText;") or ""
            path.write_text(f"{self.d.current_url}\n\n{body}",
                            encoding="utf-8", errors="replace")
            return path
        except Exception:
            return None

    def _find_submit(self):
        """The submit control, or None.

        Walks loc.CAP_SUBMIT_NEEDLES in order - see there for why "postuler"
        is last. Returns the visible text alongside the locator so the run log
        says what was actually clicked.
        """
        for needle in loc.CAP_SUBMIT_NEEDLES:
            xpath = "//button[%s]" % loc.ci_contains("normalize-space(.)", needle)
            for el in self.ux.find_all(xpath):
                try:
                    if el.is_displayed() and el.is_enabled():
                        return (" ".join((el.text or "").split()), xpath)
                except Exception:
                    continue
        return None

    def confirm_submitted(self) -> bool:
        """Whether the page actually says the application went through."""
        deadline = time.time() + CONFIRM_TIMEOUT_S
        while time.time() < deadline:
            if self.ux.visible(loc.CAP_SUBMITTED_MARKERS):
                return True
            time.sleep(0.5)
        return False

    def _rejected_fields(self) -> list:
        found = []
        for el in self.ux.find_all(loc.CAP_INVALID):
            try:
                if not el.is_displayed():
                    continue
                label = (el.get_attribute("aria-label")
                         or el.get_attribute("id")
                         or " ".join((el.text or "").split()))
                if label:
                    found.append(label[:60])
            except Exception:
                continue
        return found[:6]

    def _escape(self) -> None:
        try:
            self.d.switch_to.active_element.send_keys(Keys.ESCAPE)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# The flow for one posting
# ---------------------------------------------------------------------------
# Answer keys read from answers/capgemini.json. They live there rather than in
# app/config.py for the reason the repo already gives that directory: work
# authorisation, gender and the disability question are personal declarations,
# and get the same treatment as .env.
A_COUNTRY = "pays de residence"
A_WORK_AUTH = "autorisation de travail"
A_FORMER = "ancien salarie"
A_DISAB_CONSENT = "consentement handicap"
A_DISAB = "handicap"
A_GENDER_CONSENT = "consentement genre"
A_GENDER = "genre"
A_WHATSAPP = "whatsapp"
A_PRIVACY = "accepter confidentialite"

REQUIRED_ANSWERS = (A_COUNTRY, A_WORK_AUTH, A_FORMER)


def national_number(phone: str) -> str:
    """The subscriber digits SuccessFactors wants beside its +33 selector.

    CandidateData holds "07 53 37 78 23" because that is what Workday shows;
    this form takes the country code separately, so the leading trunk 0 has to
    come off or the number is written +33 07...
    """
    digits = "".join(c for c in (phone or "") if c.isdigit())
    return digits[1:] if digits.startswith("0") else digits


def apply_one(form, role, candidate, answers, files_required=True,
              dry_run=False, wait_for_captcha=False) -> "Outcome":
    """Fill one posting and, unless dry_run, submit it.

    Order matters and is not arbitrary: documents first (each upload
    re-renders the form, which would wipe fields written before it), then
    identity, then the questions, then the privacy consent, then submit.
    """
    out = Outcome()

    state = form.open_apply_form(role.url)
    if state is None:
        out.notes.append("apply form did not load - posting may be closed")
        return out
    if state == "already_applied":
        # Not a failure and not something to retry: the application exists.
        # record.SUBMITTED covers "confirmed in the wizard, or already
        # applied", so this stops the posting coming back round every run.
        out.submitted = True
        out.notes.append("already applied - Capgemini refused a second "
                         "application for this posting")
        return out
    if state == "anonymous":
        # Worth stopping for. On the register-and-apply form only the first
        # submission of a batch works, so carrying on would quietly produce a
        # run of failures that all look like something else.
        out.notes.append("not signed in - register-and-apply form; run "
                         "tools/apply_capgemini.py --login")
        return out

    # -- documents, before anything else --------------------------------
    if role.cv:
        form.attach(loc.CAP_CV_CONTROL, role.cv, "CV", out)
    elif files_required:
        out.notes.append("no CV configured for family %r" % role.family)
        return out

    if role.letter:
        form.replace_letter(role.letter, out)
    elif form.clear_letter():
        # Not a detail worth swallowing: this posting goes out with no cover
        # letter, and the alternative was sending the previous role's.
        out.filled.append("lettre supprimee (aucune pour ce poste)")
        out.notes.append("no tailored letter for this posting - the "
                         "pre-filled one was removed, none attached")

    # -- identity -------------------------------------------------------
    form.fill(loc.CAP_AUTH_PHONE, national_number(candidate.phone_number),
              "telephone", out.filled)

    # -- the questions --------------------------------------------------
    form.pick_combo(loc.CAP_COMBO_COUNTRY, answers.get(A_COUNTRY, "France"),
                    A_COUNTRY, out.filled, type_ahead=True)
    form.pick_combo(loc.CAP_COMBO_WORK_AUTH, answers.get(A_WORK_AUTH),
                    A_WORK_AUTH, out.filled)
    form.pick_combo(loc.CAP_COMBO_FORMER_EMPLOYEE, answers.get(A_FORMER),
                    A_FORMER, out.filled)

    # Consent gates its detail field, so it goes first and the detail is only
    # attempted when the consent actually took.
    if answers.get(A_DISAB_CONSENT) and form.pick_combo(
            loc.CAP_COMBO_DISABILITY_CONSENT, answers[A_DISAB_CONSENT],
            A_DISAB_CONSENT, out.filled):
        time.sleep(0.7)
        form.pick_combo(loc.CAP_COMBO_DISABILITY, answers.get(A_DISAB),
                        A_DISAB, out.filled)

    if answers.get(A_GENDER_CONSENT) and form.pick_combo(
            loc.CAP_COMBO_GENDER_CONSENT, answers[A_GENDER_CONSENT],
            A_GENDER_CONSENT, out.filled):
        time.sleep(0.7)
        if not form.pick_combo(loc.CAP_COMBO_GENDER, answers.get(A_GENDER, []),
                               A_GENDER, out.filled):
            out.notes.append("gender wording not matched")

    if answers.get(A_WHATSAPP):
        form.pick_combo(loc.CAP_COMBO_WHATSAPP, answers[A_WHATSAPP],
                        A_WHATSAPP, out.filled)

    if answers.get(A_PRIVACY):
        form.accept_privacy(out)

    # -- confirm what landed, then submit -------------------------------
    out.readback = form.readback()
    empty = form.unset_fields(out.readback)
    if empty:
        out.notes.append("still empty: " + ", ".join(empty))

    if dry_run:
        out.notes.append("dry run - not submitted")
        return out

    out.submitted = form.submit(out, wait_for_captcha=wait_for_captcha, role_url=role.url)
    return out


# ---------------------------------------------------------------------------
# Inspection. app/inspector.py's collector skips a plain <button> (it only
# takes button[aria-haspopup]), and the submit control is exactly a plain
# button - so this lists them, which is what --inspect is for.
# ---------------------------------------------------------------------------
_BUTTONS_JS = r"""
return Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'))
  .map(el => {
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    return {
      text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      id: el.id || null,
      disabled: el.disabled === true,
      visible: !!(r.width || r.height) && s.visibility !== 'hidden' && s.display !== 'none'
    };
  })
  .filter(b => b.visible && b.text);
"""


def visible_buttons(driver) -> list:
    try:
        return driver.execute_script(_BUTTONS_JS) or []
    except Exception:
        return []
