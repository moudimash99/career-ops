# app/pages.py
"""Page objects for the Workday application wizard.

Two behaviours worth knowing about:

* Workday shows **Apply** on a posting you have never opened and **Continue
  Application** once a draft exists. `JobPage.start_application()` works out
  which and reports it, rather than assuming a first visit.
* With "Use My Last Application" enabled, the wizard arrives prefilled - a CV is
  already attached and text fields already hold values. Everything here replaces
  what is there instead of adding to it.

The trainee questionnaire handling that used to live in `set_contract()` is
gone: it hardcoded element ids belonging to one questionnaire, and regular
postings use several different ones (or none). See git history if needed.
"""
from __future__ import annotations

import time
from pathlib import Path

from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait as W

import app.path as loc
from app.file_uploader import upload_files_example
from app.inspector import describe, snapshot_page
from utils import pause_for_human_resume

# How many attachments we are willing to delete before deciding something is
# wrong, rather than clicking forever.
MAX_ATTACHMENT_DELETES = 8

# Visible text of every link/button, so posting state can be read in one pass.
_ACTION_LABELS_JS = """
const out = [];
document.querySelectorAll('a, button, [role="button"]').forEach(el => {
  const r = el.getBoundingClientRect();
  if (!(r.width || r.height)) return;
  const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
  if (t) out.push(t);
});
return out;
"""


# Defined in app.session, where the sign-in handling lives; re-exported here
# because the wizard is where it gets raised.
from app.session import NotSignedInError  # noqa: F401


class ApplicationStateError(RuntimeError):
    """The posting is not in a state we can apply from."""


# -------------------------------------------------------------------------
# Pure helpers (unit-tested without a browser)
# -------------------------------------------------------------------------

def posting_state_from_labels(labels) -> str:
    """Classify a posting from the visible link/button labels on it.

    Returns "new", "draft", "submitted" or "unknown". Checked in priority
    order: a draft page still shows other buttons, so the specific markers win
    over a bare "Apply".
    """
    norm = {" ".join(str(l).split()).casefold() for l in labels or []}

    def has(*needles) -> bool:
        return any(n in label for n in needles for label in norm)

    if has("continue application"):
        return "draft"
    if has("view application", "application submitted", "withdraw application"):
        return "submitted"
    if any(label == "apply" or label.startswith("apply ") for label in norm):
        return "new"
    return "unknown"


def validation_errors(ux) -> list[str]:
    """Messages for fields the current page has rejected.

    Workday does not navigate when a required field is empty; it re-renders the
    same page with an error summary. Without checking, the run happily calls
    the next step's code against the page it never left, and fails there
    instead - which is how a missing first name surfaced as a missing
    attachments section two steps later.
    """
    if not ux.find_all(loc.invalid_field):
        return []
    seen, out = set(), []
    for el in ux.find_all(loc.validation_message):
        text = " ".join((el.text or "").split())
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out or ["(the page rejected one or more fields)"]


# Workday marks a field aria-required but only sets aria-invalid once it has
# decided to complain, so a page that silently refuses to advance shows
# neither an error summary nor a flagged field. Reading the empty required
# controls directly is the difference between "no field was flagged" and
# "School or University is empty" - which is what actually stopped a posting
# on 2026-08-21, sitting in the captured HTML unread.
_BLANK_REQUIRED_JS = """
// A Workday multiselect's visible input is only a search box - its value is
// always '' however much is chosen, and the real state lives in the
// promptAriaInstruction ('0 items selected' vs '1 item selected, France
// (+33)'). Reading value alone reported a filled Country Phone Code as empty
// on Accenture, 2026-08-21. Same trap fill_education already works around.
function chosen(el) {
  const box = el.closest('[data-automation-id="multiSelectContainer"]');
  if (!box) return false;
  if (box.querySelector('[data-automation-id="selectedItem"]')) return true;
  const note = box.querySelector('[data-automation-id="promptAriaInstruction"]');
  const text = (note && note.textContent || '').trim();
  // Only a real count means something is chosen. While the menu is open
  // this element reads 'Expanded', which a loose test read as filled and
  // then reported an empty required field as fine (Accenture, 2026-08-21).
  const m = text.match(/^([0-9]+) item/);
  return m ? parseInt(m[1], 10) > 0 : false;
}
return Array.from(document.querySelectorAll('input,textarea,select'))
  .filter(e => (e.offsetWidth || e.offsetHeight)
            && e.getAttribute('aria-required') === 'true'
            && !(e.value || '').trim()
            && !chosen(e))
  .map(e => {
    const id = e.id || e.getAttribute('data-automation-id') || '?';
    const lab = e.id
      ? document.querySelector('label[for="' + CSS.escape(e.id) + '"]')
      : null;
    return ((lab && lab.innerText) || id) + ' [' + id + ']';
  })
  .slice(0, 12);
"""


def blank_required_fields(ux) -> list[str]:
    """Visible required controls with nothing in them, labelled."""
    try:
        found = ux.d.execute_script(_BLANK_REQUIRED_JS) or []
    except Exception:
        return []
    return [" ".join(str(item).split()) for item in found]


def _refusal_detail(ux, errors) -> str:
    """Why the page would not advance, in the most specific terms available."""
    if errors:
        return "\n  - " + "\n  - ".join(errors)
    blank = blank_required_fields(ux)
    if blank:
        return ("\n  nothing was flagged, but these required fields "
                "are empty:\n  - " + "\n  - ".join(blank))
    return (" No field was flagged and none are empty, so the page is "
            "refusing for a reason it did not show - read the captured HTML.")


def needs_attachment_reset(current) -> bool:
    """Whether the attachment area must be cleared before uploading.

    With prefill on there is essentially always a leftover CV, so this is True
    whenever anything is present. Named so the intent is testable and obvious
    at the call site.
    """
    return bool(current)


# -------------------------------------------------------------------------
# Pages
# -------------------------------------------------------------------------

class JobPage:
    def __init__(self, ux: "UX", gate=None):
        self.u = ux
        # Called immediately before anything that advances the wizard. The
        # default does nothing; main.py supplies one that waits for the user.
        self.gate = gate or (lambda step: None)

    # -- state ---------------------------------------------------------

    def action_labels(self) -> list[str]:
        try:
            return list(self.u.d.execute_script(_ACTION_LABELS_JS) or [])
        except Exception:
            return []

    def posting_state(self) -> str:
        return posting_state_from_labels(self.action_labels())

    def wait_for_posting(self) -> bool:
        """Block until the posting has actually rendered.

        driver.get() returns as soon as the shell HTML lands, but the Apply /
        Continue button is drawn later by JavaScript. Reading the state before
        then finds no buttons at all, classifies the posting "unknown" and
        stops the run to wait for a human - which is what happened on the live
        run of 2026-08-19.
        """
        try:
            self.u.find(loc.posting_ready)
            return True
        except Exception:
            print("[state] posting did not render within the timeout.")
            return False

    def dismiss_cookie_banner(self) -> bool:
        """Clear the consent overlay, which otherwise intercepts every click.

        Present on a first visit with a fresh profile - exactly the state an
        automated run starts from.
        """
        if self.u.click_if_present(loc.cookie_accept):
            print("[cookies] consent banner dismissed")
            return True
        return False

    ROUTES = {
        "last": loc.use_last_button_path,
        "autofill": loc.autofill_with_resume,
        "manual": loc.apply_manually,
    }

    # Workday accepts a route and then says, in a page alert rather than an
    # error, that it prefilled nothing. Read it: continuing regardless is how a
    # blank identity turned into a missing attachments section two steps later.
    PREFILL_FAILED_MARKERS = (
        "didn't autofill",
        "did not autofill",
        "no previous application",
    )

    def prefill_failed(self) -> str:
        """The alert text if the chosen route prefilled nothing, else ""."""
        try:
            body = self.u.d.find_element(By.TAG_NAME, "body").text or ""
        except Exception:
            return ""
        flat = " ".join(body.split())
        low = flat.casefold()
        for marker in self.PREFILL_FAILED_MARKERS:
            if marker in low:
                start = max(low.find(marker) - 90, 0)
                return flat[start:start + 240].strip()
        return ""

    def choose_application_route(self, route: str = "last"):
        """Handle the "Start Your Application" page.

        Workday offers three routes - Autofill with Resume, Apply Manually, and
        Use My Last Application. Falling through without picking one leaves the
        run stuck on a page with no wizard.

        Returns (route_taken, prefilled). `prefilled` is False when Workday
        accepted the route but filled nothing, which the caller must know: the
        wizard then needs every field written by hand.
        """
        order = {
            "last": ["last", "manual"],
            "autofill": ["autofill", "manual"],
            "manual": ["manual"],
        }.get(route, ["last", "manual"])

        for name in order:
            if not self.u.click_if_present(self.ROUTES[name]):
                continue
            print(f"[route] {name}")
            time.sleep(4)
            alert = self.prefill_failed()
            if alert:
                print(f"[route] WARNING nothing was prefilled - Workday says: {alert}")
                return name, False
            return name, True

        print("[route] none of the routes were offered on this page")
        return None, False

    def require_signed_in(self):
        """Fail clearly if Workday is asking for an account.

        The wizard is not reachable signed out; without this the run would die
        further along on a missing locator with no hint as to why.
        """
        if self.u.exists(loc.create_account_form):
            raise NotSignedInError(
                "Workday is showing Create Account / Sign In. The Chrome "
                "profile has no Airbus session - run tools/login.py once to "
                "sign in, and the session is reused from then on."
            )

    def start_application(self, use_last_application: bool = True,
                          route: str = "last",
                          interactive: bool = True) -> str:
        """Open the wizard, whatever state the posting is in.

        Returns the state found: "new", "draft", "submitted" or "unknown".
        The caller decides what to do about the last two.
        """
        self.wait_for_posting()
        self.dismiss_cookie_banner()
        state = self.posting_state()

        if state == "submitted":
            print("[state] already submitted - leaving this posting alone.")
            return state

        if state == "draft":
            print("[state] draft exists - clicking Continue Application.")
            self.u.click(loc.continue_application_path)
            # Whether Workday resumes mid-wizard or restarts from the top is
            # not something we can assume, so record where it actually landed.
            self._report_resume_point()
            return state

        if state == "unknown":
            print("[state] no Apply or Continue button found on this posting.")
            print(describe(snapshot_page(self.u.d)))
            if not interactive:
                # Nobody is watching. Blocking on input() here cost five
                # minutes per unrenderable posting in an unattended batch and
                # then failed anyway with EOFError (2026-08-22).
                raise ApplicationStateError(
                    "The posting did not offer Apply or Continue - it may have "
                    "expired, or the page did not render.")
            print("[state] Open the application in the browser, then press Enter.")
            pause_for_human_resume(300, raise_on_timeout=True)
            return state

        self.u.click(loc.apply_button_path)
        # Lands on "Start Your Application", which must be answered before the
        # wizard appears. Prefill carries attachments over, which is why every
        # write from here on replaces rather than adds.
        if not use_last_application and route == "last":
            route = "manual"
        self.route_taken, self.prefilled = self.choose_application_route(route)
        self.require_signed_in()
        return state

    def current_step(self) -> str:
        """Which wizard step is showing, per Workday's progress bar.

        Returns something like "My Information" - or "" off the wizard. A
        resumed draft does not necessarily reopen where it left off, so this is
        read rather than assumed.
        """
        for el in self.u.find_all(
                "//*[@data-automation-id='progressBarActiveStep']"):
            text = " ".join((el.text or "").split())
            if not text:
                continue
            # Renders as "current step 2 of 5 My Experience".
            parts = text.split(" of ")
            if len(parts) == 2 and " " in parts[1]:
                return parts[1].split(" ", 1)[1].strip()
            return text
        return ""

    def _report_resume_point(self):
        """Say which wizard step a resumed draft opened on."""
        try:
            snap = snapshot_page(self.u.d)
        except Exception:
            return
        # The progress bar names the step outright; the page heading is just
        # "Careers" and tells us nothing about where the draft reopened.
        print(f"[state] draft resumed at: {self.current_step() or '?'}")
        steps = snap.get("steps") or []
        if steps:
            print(f"[state] wizard steps: {' > '.join(steps)}")

    # -- attachments ---------------------------------------------------

    def resume_scope(self):
        """The CV upload area, when the page separates it from other uploads.

        Accenture's My Experience has one upload area per certification plus
        the CV's; Airbus has a single one. Returns None on pages that do not
        distinguish, so the unscoped behaviour is preserved there.
        """
        try:
            buttons = self.u.d.find_elements(
                By.CSS_SELECTOR, 'button[data-automation-id="select-files"]')
        except Exception:
            return None
        if len(buttons) < 2:
            return None
        for button in buttons:
            if (button.get_attribute("id") or "").startswith("resumeAttachments"):
                node = button
                for _ in range(10):
                    # Walking past <html> yields the document, which is not an
                    # element and raises InvalidSelectorException.
                    if (node.tag_name or "").lower() == "html":
                        return None
                    try:
                        node = node.find_element(By.XPATH, "..")
                    except Exception:
                        return None
                    if node.find_elements(By.CSS_SELECTOR,
                                          'input[type="file"]'):
                        return node
                return None
        return None

    def attached_filenames(self) -> list[str]:
        """Names of files already attached, best effort.

        Workday's markup for this varies, so each known candidate is tried in
        turn. An empty list means "none found", which is not the same as
        "definitely none attached" - delete_all_attachments() works off the
        delete buttons, which are the more reliable signal.
        """
        # Only the CV area when the page has several upload areas, so a
        # certification's document is neither reported as the CV nor compared
        # against it.
        scope = self.resume_scope()
        if scope is not None:
            names = [(e.text or "").strip() for e in scope.find_elements(
                By.CSS_SELECTOR, '[data-automation-id="file-upload-item-name"]')]
            return [n for n in names if n]
        for xp in loc.attachment_name_candidates:
            names = [(e.text or "").strip() for e in self.u.find_all(xp)]
            names = [n for n in names if n]
            if names:
                return names
        return []

    def delete_all_attachments(self) -> int:
        """Remove every attachment currently listed. Returns how many went.

        Re-finds the buttons each pass because React re-renders the list after
        each removal, invalidating any handle held across the change.
        """
        removed = 0
        # Only ever clear the CV area when the page has several. A blanket
        # delete removed a certification document the candidate had attached
        # by hand (Accenture, 2026-08-21).
        scope = self.resume_scope()
        for _ in range(MAX_ATTACHMENT_DELETES):
            buttons = (scope.find_elements(
                By.CSS_SELECTOR, 'button[data-automation-id="delete-file"]')
                if scope is not None else self.u.find_all(loc.delete_file))
            if not buttons:
                break
            try:
                self.u.d.execute_script("arguments[0].click();", buttons[0])
                removed += 1
            except Exception:
                break
            # Let the list re-render before looking again.
            try:
                W(self.u.d, 5).until(
                    lambda d, n=len(buttons): len(
                        d.find_elements(By.XPATH, loc.delete_file)
                    ) < n
                )
            except Exception:
                pass
        return removed

    def experience_page(self, files: list[Path]):
        """Attach exactly `files`, replacing anything already there."""
        before = self.attached_filenames()
        if before:
            print(f"[attach] already present: {', '.join(before)}")

        # If the right document is already on the page, touch nothing. Deleting
        # and re-uploading an identical file is pure churn, and on Accenture it
        # is actively harmful: the page carries per-certification attachment
        # areas as well as the CV, so a blanket delete removed a certification
        # document the candidate had attached by hand. The upload churn also
        # left My Experience silently refusing to advance.
        wanted = {f.name for f in files}
        if before and set(before) == wanted:
            print("[attach] already exactly right - leaving the page alone")
            return

        if needs_attachment_reset(before) or self.u.exists(loc.delete_file):
            removed = self.delete_all_attachments()
            if removed:
                print(f"[attach] removed {removed} existing attachment(s)")

        # Refuse to stack a second CV on top of one we could not remove.
        # Scoped like the delete above: an unscoped check counted the
        # certification attachments as leftovers and refused a clean page.
        scope = self.resume_scope()
        leftover = (scope.find_elements(
            By.CSS_SELECTOR, 'button[data-automation-id="delete-file"]')
            if scope is not None else self.u.find_all(loc.delete_file))
        if leftover:
            raise ApplicationStateError(
                f"{len(leftover)} attachment(s) could not be removed; refusing "
                "to upload on top and end up with duplicates."
            )

        upload_files_example(self.u.d, files)
        print(f"[attach] uploaded {len(files)} file(s)")

        after = self.attached_filenames()
        if after and len(after) != len(files):
            print(f"[attach] WARNING expected {len(files)} attachment(s), "
                  f"page lists {len(after)}: {', '.join(after)}")

        # Education and languages are filled by ApplicationWizard, and the
        # caller saves the page once everything on it is done.

    # -- other steps ---------------------------------------------------

    def fill_personal_information(self, data, overwrite: bool = False):
        """Fill the identity fields on "My Information".

        Every write replaces what is there rather than adding to it, so this is
        safe whether the page arrived blank or prefilled.
        """
        required = (
            (loc.first_name, getattr(data, "given_name", "")),
            (loc.last_name, getattr(data, "family_name", "")),
            (loc.phone_number, getattr(data, "phone_number", "")),
        )
        optional = (
            (loc.address_line1, getattr(data, "address_line1", "")),
            (loc.city_field, getattr(data, "city", "")),
            (loc.postal_code, getattr(data, "postal_code", "")),
        )
        filled, kept = [], []
        for xpath, value in required + optional:
            if not self.u.exists(xpath):
                continue
            # Never clobber what Workday prefilled. "Use My Last Application"
            # brings across the candidate's own previous answers, which are
            # more authoritative than any default configured here - overwriting
            # "Machaka" with "MACHAKA", or a formatted phone number with an
            # unformatted one, makes the application worse, not better.
            existing = self.u.value_of(self.u.find(xpath)).strip()
            if existing and not overwrite:
                kept.append(existing)
                continue
            if not value:
                continue
            self.u.type(xpath, value)
            filled.append(value)

        if kept:
            print(f"[identity] kept {len(kept)} prefilled value(s): "
                  + ", ".join(kept))
        if filled:
            print(f"[identity] filled {len(filled)} empty field(s): "
                  + ", ".join(filled))
        if not kept and not filled:
            print("[identity] nothing to do on this page")

    def _await_step_change(self, before: str, timeout_s: float = 20):
        """Wait for the wizard to move on, or for the page to object.

        Saving is a round trip and the progress bar repaints well after the
        click returns, so deciding immediately reports a perfectly good save as
        stuck. Poll for whichever comes first - a new step, or a flagged field.
        """
        deadline = time.time() + timeout_s
        after, errors = before, []
        while time.time() < deadline:
            time.sleep(1)
            after = self.current_step()
            if before and after != before:
                return after, []
            errors = validation_errors(self.u)
            if errors:
                return after, errors
        return after, errors

    def save_and_continue(self, step: str = "page"):
        """Click Save and Continue, and refuse to pretend it worked.

        Raises ApplicationStateError when the page reports validation errors,
        because Workday stays put in that case and every later step would be
        run against the wrong page.
        """
        self.gate(step)
        before = self.current_step()
        self.u.click(loc.save_cont_path)
        after, errors = self._await_step_change(before)

        # Not advancing is the real signal. Workday does not always mark the
        # offending field aria-invalid, so an empty error list is NOT proof the
        # save worked - on 2026-08-19 that combination reported success while
        # the wizard sat on "My Experience" with an unfillable School field.
        if before and after == before:
            raise ApplicationStateError(
                f"{step} did not advance; still on {after!r}."
                + _refusal_detail(self.u, errors))

        if errors:
            raise ApplicationStateError(
                f"{step} was not accepted; Workday is still on it:\n  - "
                + "\n  - ".join(errors))

    def answer_source(self, path: tuple) -> bool:
        """Answer "How Did You Hear About Us?" by walking a prompt path.

        Accenture nests the options (a category, then a leaf) and renders the
        control as a multiselect input rather than Airbus's button, so the
        answer is configured per employer rather than hardcoded - see
        app/employers.py.
        """
        if not path:
            return False
        for label in path:
            chosen = self.u.choose_option_by_text(loc.how_hear_any, label)
            print(f"[source] {chosen}")
            time.sleep(1.0)
        return True

    def select_source(self, data, overwrite_identity: bool = False,
                      source_answer: tuple = ()):
        """The "My Information" page: source, previous employment, identity."""
        if source_answer:
            self.answer_source(source_answer)
        else:
            self.u.choose_option(loc.how_hear_path,
                                 loc.career_website_button_path)
        self._answer_previous_worker(data)
        self.fill_personal_information(data, overwrite=overwrite_identity)
        self.save_and_continue("My Information")

    def _answer_previous_worker(self, data):
        """Tick yes/no on 'have you worked at Airbus before'.

        Clicked via the <label>, because the radio itself sits under an overlay
        in Workday's rendering and a direct click gets intercepted.
        """
        driver = self.u.d

        # Leave a prefilled answer alone. "Use My Last Application" carries the
        # candidate's own previous answer across, and it is authoritative: on
        # 2026-08-19 prefill said Yes (the candidate works at Airbus) while the
        # configured default said No, and overwriting it would have put a false
        # statement on a real job application. Third time this pattern bit -
        # see fill_personal_information and fill_education.
        already = driver.find_elements(
            By.CSS_SELECTOR, "input[name='candidateIsPreviousWorker']:checked")
        if already:
            current = already[0].get_attribute("value")
            print(f"[previous-worker] keeping prefilled answer: "
                  f"{'Yes' if current == 'true' else 'No'}")
            return

        want = "true" if getattr(data, "previous_worker", False) else "false"
        try:
            radio = driver.find_element(
                By.CSS_SELECTOR,
                f"input[name='candidateIsPreviousWorker'][value='{want}']",
            )
        except Exception:
            return  # not every posting asks

        # Go through UX.click, not a raw click: the label often sits under the
        # sticky page footer, which intercepts a direct click. UX.click scrolls
        # it into the middle first and falls back to a synthetic click, which a
        # <label> forwards to its control anyway.
        self.u.click(f"//label[@for='{radio.get_attribute('id')}']")

        if want == "true" and getattr(data, "employee_id", ""):
            self.u.type(loc.worker_code_id, data.employee_id)


class ApplicationWizard:
    def __init__(self, driver, ux: "UX", data, *, dry_run: bool = False,
                 gate=None):
        self.d = driver
        self.u = ux
        self.data = data
        self.dry_run = dry_run
        self.snapshots: list[dict] = []
        self.gate = gate or (lambda step: None)

    # -- instrumentation -----------------------------------------------

    def snapshot(self, tag: str) -> dict:
        snap = snapshot_page(self.d)
        snap["tag"] = tag
        self.snapshots.append(snap)
        print(f"[inspect] {tag}")
        print(describe(snap))
        return snap

    # -- steps ---------------------------------------------------------

    def handle_questionnaire(self, *, timeout_s: int = 600,
                             interactive: bool = True):
        """Record the questionnaire, then let a human answer it.

        Regular postings carry one of several questionnaires (and sometimes
        none at all). Until we have snapshots of each, guessing at answers
        risks submitting wrong ones - so a person fills this page in.
        """
        snap = self.snapshot("questionnaire")

        if not snap.get("fields"):
            print("[questionnaire] no fields on this page - nothing to answer.")
            return

        ids = snap.get("questionnaire_ids") or []
        print(f"[questionnaire] {len(snap['fields'])} field(s)"
              + (f", questionnaire {', '.join(ids)}" if ids else ""))
        if not interactive:
            # Nobody is watching: recording the questions is useful, blocking
            # ten minutes on an input() that can only ever raise EOFError is
            # not. The caller stops here and reports what the page asked.
            print("[questionnaire] not interactive - recorded, not answered.")
            return snap

        print("[questionnaire] Fill this page in the browser, then press Enter.")
        pause_for_human_resume(timeout_s, raise_on_timeout=True)

        # Re-record once answered: this is the data needed to write an
        # automatic handler for this questionnaire later.
        answered = self.snapshot("questionnaire_answered")
        answered["questionnaire_ids"] = ids

    # The question text is not on the control - Workday puts "Select One" in
    # the label and the actual question in a block above it. Climb until there
    # is enough text to be a question.
    _QUESTION_TEXT_JS = r"""
const el = arguments[0];
let n = el;
for (let i = 0; i < 8 && n; i++) {
  const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
  if (t.length > 40) return t.slice(0, 500);
  n = n.parentElement;
}
return '';
"""

    def await_questionnaire(self, timeout_s: float = 20) -> list:
        """Wait for the questions page body to actually render.

        The progress bar flips to "Application Questions" while the previous
        page is still on screen, so looking straight away finds the *old*
        page's controls and concludes there is nothing to answer. Seen live on
        2026-08-20, where a capture labelled Application Questions still
        contained "Work Experience 1 / Job Title / Company".
        """
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            found = self.questionnaire_controls()
            if found:
                return found
            time.sleep(1)
        return []

    def questionnaire_controls(self) -> list:
        """Visible controls belonging to the posting's questionnaire."""
        out = []
        for el in self.d.find_elements(
                By.CSS_SELECTOR, "[id*='Questionnaire--']"):
            try:
                if el.is_displayed() and el.tag_name in ("button", "input",
                                                         "textarea", "select"):
                    out.append(el)
            except Exception:
                continue
        return out

    def answer_questions(self, answers: dict) -> list[dict]:
        """Fill questions we have answers for; return the ones we do not.

        Matching is on the question's visible text, because the element ids are
        per-tenant uuids (primaryQuestionnaire--f53d8edc72321001...) and differ
        between postings. Anything unmatched is returned untouched - guessing an
        answer on a real job application is not acceptable.
        """
        unanswered = []
        controls = self.await_questionnaire()
        if not controls:
            print("[questions] no questionnaire controls rendered on this page")
        for el in controls:
            try:
                question = self.d.execute_script(self._QUESTION_TEXT_JS, el)
            except Exception:
                question = ""
            flat = " ".join((question or "").split())

            # Already answered - by prefill, or by the candidate in the
            # browser - is not "unanswered". Parking it would stall a complete
            # page, and overwriting it would replace the candidate's own answer
            # with a default. Fifth outing for this pattern; see
            # fill_personal_information, fill_education, _answer_previous_worker
            # and set_languages.
            current = (el.get_attribute("value")
                       or " ".join((el.text or "").split()))
            if current and current != "Select One":
                print(f"[questions] already answered ({current!r}), leaving "
                      f"alone: {flat[:60]!r}")
                continue

            match = None
            for key, value in (answers or {}).items():
                if key.casefold() in flat.casefold():
                    match = (key, value)
                    break

            if not match:
                unanswered.append({
                    "question": flat,
                    "control": el.tag_name,
                    "element_id": el.get_attribute("id"),
                    "current": (el.get_attribute("value")
                                or " ".join((el.text or "").split())),
                })
                continue

            key, value = match
            el_id = el.get_attribute("id")
            try:
                if el.tag_name == "button":
                    chosen = self.u.choose_option_by_text(
                        f"//button[@id='{el_id}']", value)
                    print(f"[questions] chose {chosen!r}")
                else:
                    self.u.type(f"//*[@id='{el_id}']", str(value))
                print(f"[questions] {flat[:70]!r} -> {value!r}")
            except Exception as e:
                print(f"[questions] could not answer {flat[:60]!r}: "
                      f"{type(e).__name__}")
                unanswered.append({
                    "question": flat, "control": el.tag_name,
                    "element_id": el_id, "error": type(e).__name__,
                })
        return unanswered

    def save_and_continue(self, step: str = "page"):
        """Save this page, and refuse to pretend it worked.

        Same check as JobPage.save_and_continue: Workday stays put when a
        required field is empty, so continuing would run the next step's code
        against the page we never left.
        """
        self.gate(step)
        page = JobPage(self.u, gate=self.gate)
        before = page.current_step()
        self.u.click(loc.save_cont_path)
        after, errors = page._await_step_change(before)

        # An empty error list does not mean the save worked - see the note on
        # JobPage.save_and_continue. Not moving is the signal that matters.
        if before and after == before:
            raise ApplicationStateError(
                f"{step} did not advance; still on {after!r}."
                + _refusal_detail(self.u, errors))

        if errors:
            raise ApplicationStateError(
                f"{step} was not accepted; Workday is still on it:\n  - "
                + "\n  - ".join(errors))

    # Each section on "My Experience" hides its fields until Add is clicked.
    # The button carries a generic automation id shared by every section, so it
    # has to be found relative to the section heading rather than globally.
    _ADD_IN_SECTION_JS = """
const wanted = arguments[0];
const heads = Array.from(document.querySelectorAll('h3,h4,label,div'))
  .filter(e => (e.innerText || '').trim() === wanted);
if (!heads.length) return 'no such section';
let node = heads[0];
for (let i = 0; i < 6 && node; i++) {
  const btn = node.querySelector('button[data-automation-id="add-button"]');
  if (btn) { btn.scrollIntoView({block: 'center'}); btn.click(); return 'clicked'; }
  node = node.parentElement;
}
return 'no add button in section';
"""

    def add_entry_to_section(self, section: str) -> bool:
        """Expand a collapsed section by clicking its Add button."""
        try:
            result = self.u.d.execute_script(self._ADD_IN_SECTION_JS, section)
        except Exception as e:
            print(f"[{section.lower()}] could not expand: {type(e).__name__}")
            return False
        if result != "clicked":
            print(f"[{section.lower()}] {result}")
            return False
        time.sleep(2)
        return True

    # -- work history --------------------------------------------------

    def work_entry_prefixes(self) -> list[str]:
        """Ids of the work-experience entries on the page, in page order.

        Workday regenerates these per render (workExperience-11 one load,
        workExperience-362 the next), so they are read rather than stored.
        """
        return [el.get_attribute("id").split("--")[0]
                for el in self.d.find_elements(
                    By.CSS_SELECTOR,
                    "[id^='workExperience-'][id$='--jobTitle']")]

    def set_month_year(self, field_id: str, month: int, year: int) -> None:
        """Write a Workday MM/YYYY pair.

        The real inputs are aria-hidden behind a `-display` div that swallows
        the click, so a direct send_keys raises ElementClickIntercepted and
        typing into the input lands garbage - month 5 arrived as 2. Click the
        display and type MMYYYY; the widget advances month to year itself.
        Same shape as the birth-date field in final_page.
        """
        display = self.d.find_element(
            By.ID, f"{field_id}-dateSectionMonth-display")
        self.d.execute_script(
            "arguments[0].scrollIntoView({block:'center'});", display)
        time.sleep(0.4)
        display.click()
        time.sleep(0.4)
        ActionChains(self.d).send_keys(f"{month:02d}{year:04d}").perform()
        time.sleep(0.8)

    def _tick_currently_works_here(self, prefix: str, current: bool) -> None:
        """Tick "I currently work here", which removes the end-date fields.

        Fiddlier than it looks, and getting it wrong is expensive: the real
        input is opacity:0 under a drawn span, and both sit beneath the sticky
        page footer, so a plain click is intercepted. A JavaScript click does
        tick the box and does hide the end-date fields - but Workday discards
        the whole entry on save, because React never saw a trusted event. That
        silently dropped the candidate's current job from the application on
        2026-08-21 and it only showed up on the Review page.

        So: scroll it clear of the footer and issue a real click.
        """
        box = self.d.find_element(By.ID, f"{prefix}--currentlyWorkHere")
        if box.is_selected() == current:
            return
        self.d.execute_script(
            "arguments[0].scrollIntoView({block:'center'});"
            "window.scrollBy(0, -140);", box)
        time.sleep(1.0)
        try:
            box.click()
        except Exception:
            # Last resort. Known to tick the box without persisting, so the
            # verification below is what actually matters.
            self.d.execute_script("arguments[0].click();", box)
        time.sleep(1.2)

        now = self.d.find_element(
            By.ID, f"{prefix}--currentlyWorkHere").is_selected()
        if now != current:
            raise ApplicationStateError(
                f"Could not set 'I currently work here' to {current} on "
                f"{prefix}; Workday would drop this entry on save.")

    def write_work_entry(self, prefix: str, entry) -> None:
        self.u.type(f"//*[@id='{prefix}--jobTitle']", entry.title)
        self.u.type(f"//*[@id='{prefix}--companyName']", entry.company)
        self.set_month_year(f"{prefix}--startDate",
                            entry.start_month, entry.start_year)
        # Tick before writing the end date: ticking removes those fields, so
        # doing it afterwards throws the value away.
        self._tick_currently_works_here(prefix, entry.current)
        if not entry.current and entry.end_month and entry.end_year:
            self.set_month_year(f"{prefix}--endDate",
                                entry.end_month, entry.end_year)

    def fill_work_history(self, entries) -> bool:
        """Make the Work Experience section match `entries` exactly.

        Only called when the caller has decided the stored history is wrong -
        Accenture's was three years stale. Entries are written positionally,
        most recent first, and missing rows are added.
        """
        if not entries:
            return False
        prefixes = self.work_entry_prefixes()
        while len(prefixes) < len(entries):
            if not self.add_entry_to_section("Work Experience"):
                print(f"[work] could only make {len(prefixes)} of "
                      f"{len(entries)} entries")
                break
            grown = self.work_entry_prefixes()
            if len(grown) == len(prefixes):
                print("[work] Add did not produce a new entry; stopping")
                break
            prefixes = grown

        for entry, prefix in zip(entries, prefixes):
            self.write_work_entry(prefix, entry)
            until = "present" if entry.current else                 f"{entry.end_month:02d}/{entry.end_year}"
            print(f"[work] {entry.company} - {entry.title} "
                  f"({entry.start_month:02d}/{entry.start_year} - {until})")
        return True

    def fill_education(self):
        """Add one education entry: school, degree, field of study.

        Required on regular postings - Save and Continue is refused without it.
        """
        # Never write over a prefilled entry. "Use My Last Application" brings
        # the candidate's real schools across as multiselect selections, and
        # typing into that widget's search box adds noise to a section that was
        # already correct. Checked via the selection nodes, because the search
        # input's value is always "" no matter what is chosen.
        if self.u.exists(loc.education_school_selected):
            chosen = [" ".join((e.text or "").split())
                      for e in self.u.find_all(loc.education_school_selected)]
            chosen = [c for c in chosen if c]
            print(f"[education] already filled, leaving alone: "
                  f"{', '.join(dict.fromkeys(chosen))[:160]}")
            return True

        if not self.u.visible(loc.education_school):
            if not self.add_entry_to_section("Education"):
                return False

        if not self.u.visible(loc.education_school):
            print("[education] fields did not appear; leaving it alone")
            return False

        # Type *and* pick: the school box is a searchable multiselect and
        # records nothing until an option is clicked.
        try:
            chosen = self.u.search_and_pick(loc.education_school,
                                            self.data.university)
            print(f"[education] school {chosen!r}")
        except Exception as e:
            print(f"[education] could not select a school: {e}")
            return False

        degree = getattr(self.data, "degree", "")
        candidates = list(getattr(self.data, "degree_candidates", ()) or ())
        if degree and degree not in candidates:
            candidates.insert(0, degree)
        if candidates and self.u.visible(loc.education_degree):
            for candidate in candidates:
                try:
                    degree = self.u.choose_option_by_text(
                        loc.education_degree, candidate)
                    break
                except Exception:
                    continue
            else:
                print(f"[education] none of {candidates} were offered as a "
                      "Degree; left blank, and Workday requires it")

        if self.u.visible(loc.education_field_of_study):
            try:
                self.u.search_and_pick(loc.education_field_of_study,
                                       self.data.course)
            except Exception:
                # Optional on every board seen so far; a plain type is a
                # reasonable fallback where it is a free-text field.
                try:
                    self.u.type(loc.education_field_of_study, self.data.course)
                except Exception:
                    print("[education] field of study left blank")

        print(f"[education] {self.data.university} / {degree}")
        return True


    def set_languages(self):
        """Fill a language entry, but never create one.

        Languages are optional on regular postings - Save and Continue only
        complains about School and Degree. Clicking Add here would manufacture
        an entry whose Language field is then required, so an unfillable one
        would block the page that was previously fine. Verified live
        2026-08-19.

        The old locators here (input-292 / input-294) were generated ids from
        the internship questionnaire and matched nothing on this form.
        """
        if not self.u.visible(loc.language_choice):
            print("[languages] no entry present - leaving the section empty")
            return False

        # Do not touch a language that is already chosen. Prefill brings the
        # candidate's real languages across, and forcing "English" onto the
        # first row overwrites one of them and leaves a duplicate. Fourth time
        # this pattern appeared - see fill_personal_information, fill_education
        # and _answer_previous_worker.
        chosen = [" ".join((e.text or "").split())
                  for e in self.u.find_all(loc.language_choice)]
        already = [c for c in chosen if c and c != "Select One"]
        if already:
            print(f"[languages] already filled, leaving alone: "
                  f"{', '.join(already)}")
            return True

        try:
            self.u.choose_option(loc.language_choice,
                                 loc.dropdown_option("English"))
            print("[languages] English set")
            return True
        except Exception as e:
            print(f"[languages] skipped: {type(e).__name__}")
            return False

    def accept_terms(self) -> bool:
        """Tick the terms checkbox, which is required to submit.

        The real input is opacity:0 under a drawn span, and both sit beneath
        the sticky page footer, so a plain click is intercepted. Scroll it
        clear and issue a real click - a JavaScript click ticks the box
        without Workday registering it, the same trap as the work-history
        "I currently work here" checkbox.
        """
        boxes = self.d.find_elements(By.XPATH, loc.terms_checkbox)
        if not boxes:
            return False
        box = boxes[0]
        if box.is_selected():
            return True
        self.d.execute_script(
            "arguments[0].scrollIntoView({block:'center'});"
            "window.scrollBy(0, -140);", box)
        time.sleep(1.0)
        try:
            box.click()
        except Exception:
            self.u.click(loc.accept)
        time.sleep(1.2)
        accepted = self.d.find_elements(By.XPATH, loc.terms_checkbox)[0].is_selected()
        if not accepted:
            raise ApplicationStateError(
                "Could not accept the terms and conditions; Workday will not "
                "let the application be submitted without it.")
        print("[disclosures] terms accepted")
        return True

    def final_page(self):
        """Personal information. Each control is optional - postings vary."""
        # Wait for whichever disclosure control this tenant actually shows.
        # Airbus asks for nationality and date of birth; Accenture asks only
        # for gender, a pronoun and the terms checkbox, so waiting on the
        # Airbus-only nationality field timed the page out there.
        W(self.d, self.u.timeout).until(
            EC.presence_of_element_located((By.XPATH, loc.disclosures_ready))
        )
        self.snapshot("personal_information")

        # Gate before writing anything here. This page carries date of birth,
        # nationality and gender - personal data that must not be filled from a
        # stale default without the candidate seeing it first. The snapshot
        # above is printed, so the real control ids are visible before any
        # click happens.
        self.gate("Voluntary Disclosures - about to fill personal details")

        def attempt(what, fn):
            try:
                fn()
            except Exception as e:
                print(f"[final_page] skipped {what}: {type(e).__name__}")

        def birth_date():
            self.u.click(loc.bd)
            ActionChains(self.d).send_keys(self.data.birth_mmddyyyy).perform()

        attempt("date of birth", birth_date)
        attempt("nationality", lambda: (self.u.click(loc.nation),
                                        self.u.click(loc.liban)))
        attempt("terms and conditions", self.accept_terms)
        # choose_option_by_text rather than a text locator: Accenture offers
        # "Only for Admin Use (Please Do Not Select)" alongside the real
        # values, and its options are promptOption divs, not li[role=option].
        attempt("gender", lambda: self.u.choose_option_by_text(
            loc.gend, getattr(self.data, "gender", "Male")))

        # Checked, like every other step. A bare click here would let a
        # refused Voluntary Disclosures page fall straight through to Submit,
        # which is the one click on this flow that cannot be undone.
        self.save_and_continue("Voluntary Disclosures")

    # Workday redraws the page after a successful Submit; until it does, the
    # Review page is still on screen and nothing has gone in. 25s was too
    # short - JR10432151-1 submitted successfully on 2026-08-22 and was
    # recorded as a draft because the confirmation arrived late. A false
    # negative is cheap (the posting is retried, and a resubmit is refused)
    # where a false positive is not, so this errs long.
    SUBMIT_CONFIRM_S = 60

    def submitted_confirmed(self, timeout_s: float = 0) -> bool:
        """Whether Workday has acknowledged the submission.

        Clicking Submit is not evidence that it took: the button is inside the
        sticky footer and a refused Review page leaves it exactly where it was.
        Recording that as a success is worse than failing - the posting lands
        in succ_links.txt and is never applied to again.
        """
        deadline = time.time() + timeout_s
        while True:
            try:
                if self.u.find_all(loc.submitted_markers):
                    return True
            except Exception:
                pass
            if time.time() >= deadline:
                return False
            time.sleep(1)

    def submit(self):
        self.gate("Submit")
        if self.dry_run:
            print("[dry-run] Reached Submit - NOT clicking it. "
                  "The application stays a draft in Workday.")
            return False
        self.u.click(loc.submit)
        if self.submitted_confirmed(self.SUBMIT_CONFIRM_S):
            print("[submit] Workday confirmed the application went in")
            return True
        print("[submit] WARNING clicked Submit but Workday never confirmed it; "
              "treating this posting as NOT applied to.")
        return False
