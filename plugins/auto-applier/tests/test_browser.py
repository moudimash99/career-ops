"""Browser tests against local mock pages that imitate Workday's markup.

These drive real Chrome, so they exercise the actual code paths - the
inspector's JavaScript, the attachment replace loop, and the replace-not-append
typing - without touching Airbus.

What they prove: the logic and the JS work in a real browser.
What they do NOT prove: that the selectors match Airbus's real DOM. Only a live
run against a signed-in session settles that.

Run with:  .venv/Scripts/python.exe -m pytest tests/test_browser.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By

import app.path as loc
from app.inspector import snapshot_page
from app.pages import (ApplicationStateError, ApplicationWizard, JobPage,
                       blank_required_fields, validation_errors)
from app.session import looks_signed_in
from app.ux import UX, FieldWriteError

# -------------------------------------------------------------------------
# Mock pages
# -------------------------------------------------------------------------

POSTING_TEMPLATE = """
<h1 data-automation-id="jobPostingHeader">Test Engineer (m/f)</h1>
<div>
  <a href="#" data-automation-id="signIn">Sign In</a>
  {cta}
</div>
"""

CTA_NEW = '<a href="/apply" data-automation-id="adventureButton">Apply</a>'
CTA_DRAFT = '<a href="/cont" data-automation-id="adventureButton">Continue Application</a>'
CTA_SUBMITTED = '<a href="/view">View Application</a>'

# Attachments area: one CV already there, as prefill always leaves behind.
ATTACHMENTS_PAGE = """
<h2>My Experience</h2>
<div role="group" aria-labelledby="Application-attachments-section">
  <span id="Application-attachments-section">Resume/CV</span>
  <div data-automation-id="attachments-FileUpload">
    <ul id="filelist">
      <li role="listitem" class="row">
        <div data-automation-id="file-preview-name">old_prefilled_cv.pdf</div>
        <button data-automation-id="delete-file">Delete</button>
      </li>
    </ul>
  </div>
  <input type="file" multiple
         data-automation-id="file-upload-input-ref"
         style="display:none">
</div>
<button id="savecont">Save and Continue</button>

<script>
// Remove a row when its delete button is clicked, like the real list does.
document.getElementById('filelist').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-automation-id="delete-file"]');
  if (btn) btn.closest('li').remove();
});

// Adding files appends rows, so uploading without clearing first leaves
// duplicates - which is the bug these tests are here to catch.
document.querySelector('input[data-automation-id="file-upload-input-ref"]')
  .addEventListener('change', function () {
    for (const f of this.files) {
      const li = document.createElement('li');
      li.setAttribute('role', 'listitem');
      li.className = 'row';
      li.innerHTML =
        '<div data-automation-id="file-preview-name">' + f.name + '</div>' +
        '<button data-automation-id="delete-file">Delete</button>';
      document.getElementById('filelist').appendChild(li);
    }
  });
</script>
"""

# A field that behaves like a React controlled input.
#
# Measured, not guessed: Selenium's clear() fires focus, change and blur, but
# never `input`. React wires onChange to the native `input` event, so a clear()
# is invisible to it and its next render puts the old value back - after which
# send_keys appends, giving "OLD VALUENEW VALUE".
#
# This mock reproduces exactly that: a change with no preceding input event is
# treated as a state the component never agreed to, and gets reverted.
STUBBORN_FIELD = """
<label for="f">University</label>
<input id="f" value="OLD VALUE">
<script>
const el = document.getElementById('f');
let sawInput = false;
el.addEventListener('input', () => { sawInput = true; });
el.addEventListener('change', () => {
  if (!sawInput) { el.value = 'OLD VALUE'; }   // re-render from component state
  sawInput = false;
});
</script>
"""

# Same, but it never lets go - used to prove we refuse rather than submit junk.
IMPOSSIBLE_FIELD = """
<label for="f">University</label>
<input id="f" value="STUCK">
<script>
const el = document.getElementById('f');
el.addEventListener('input', () => {
  if (el.value !== 'STUCK') { el.value = 'STUCK'; }
});
</script>
"""


# -------------------------------------------------------------------------
# Fixtures
# -------------------------------------------------------------------------

@pytest.fixture(scope="module")
def driver():
    opts = webdriver.ChromeOptions()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    d = webdriver.Chrome(options=opts)
    d.implicitly_wait(0.5)
    yield d
    d.quit()


@pytest.fixture
def load(driver, tmp_path):
    def _load(html: str):
        page = tmp_path / "page.html"
        page.write_text(html, encoding="utf-8")
        driver.get(page.as_uri())
        return driver
    return _load


@pytest.fixture
def ux(driver):
    # Short timeout: these pages are local and nothing needs waiting for.
    return UX(driver, timeout=3, micro_wait=0.05)


# -------------------------------------------------------------------------
# Posting state
# -------------------------------------------------------------------------

class TestPostingStateInBrowser:
    def test_detects_fresh_posting(self, load, ux):
        load(POSTING_TEMPLATE.format(cta=CTA_NEW))
        assert JobPage(ux).posting_state() == "new"

    def test_detects_draft_on_revisit(self, load, ux):
        load(POSTING_TEMPLATE.format(cta=CTA_DRAFT))
        assert JobPage(ux).posting_state() == "draft"

    def test_detects_submitted(self, load, ux):
        load(POSTING_TEMPLATE.format(cta=CTA_SUBMITTED))
        assert JobPage(ux).posting_state() == "submitted"

    def test_labels_include_plain_anchors(self, load, ux):
        """Apply is a bare <a>; it must be picked up."""
        load(POSTING_TEMPLATE.format(cta=CTA_NEW))
        assert "Apply" in JobPage(ux).action_labels()


# -------------------------------------------------------------------------
# Inspector
# -------------------------------------------------------------------------

class TestInspectorInBrowser:
    def test_js_runs_and_reports_anchor_actions(self, load, driver):
        load(POSTING_TEMPLATE.format(cta=CTA_NEW))
        snap = snapshot_page(driver)
        texts = [a["text"] for a in snap["actions"]]
        # The old selector was 'button, a[role="button"]', which missed this.
        assert "Apply" in texts
        apply_action = next(a for a in snap["actions"] if a["text"] == "Apply")
        assert apply_action["tag"] == "a"
        assert apply_action["automation_id"] == "adventureButton"

    def test_reports_existing_attachments(self, load, driver):
        load(ATTACHMENTS_PAGE)
        snap = snapshot_page(driver)
        att = snap["attachments"]
        assert att["group_found"] is True
        assert att["delete_buttons"] == 1
        found = [n for names in att["by_selector"].values() for n in names]
        assert "old_prefilled_cv.pdf" in found


# -------------------------------------------------------------------------
# Attachments: the duplicate-CV bug
# -------------------------------------------------------------------------

class TestAttachmentReplacement:
    def test_reads_prefilled_attachment(self, load, ux):
        load(ATTACHMENTS_PAGE)
        assert JobPage(ux).attached_filenames() == ["old_prefilled_cv.pdf"]

    def test_deletes_everything_present(self, load, ux):
        load(ATTACHMENTS_PAGE)
        job = JobPage(ux)
        assert job.delete_all_attachments() == 1
        assert job.attached_filenames() == []

    def test_upload_replaces_rather_than_duplicates(self, load, ux, tmp_path):
        """The whole point: end with one CV, not the old one plus the new."""
        cv = tmp_path / "new_cv.pdf"
        cv.write_bytes(b"%PDF-1.4 fake\n")

        load(ATTACHMENTS_PAGE)
        job = JobPage(ux)
        assert job.attached_filenames() == ["old_prefilled_cv.pdf"]

        job.experience_page(files=[cv])

        names = job.attached_filenames()
        assert names == ["new_cv.pdf"], f"expected exactly one CV, got {names}"

    def test_naive_upload_would_have_duplicated(self, load, ux, tmp_path):
        """Guard on the mock itself: without the delete step you get two.

        If this ever fails, the fixture stopped reproducing the bug and the
        test above would pass for the wrong reason.
        """
        from app.file_uploader import upload_files_example

        cv = tmp_path / "new_cv.pdf"
        cv.write_bytes(b"%PDF-1.4 fake\n")
        driver = load(ATTACHMENTS_PAGE)
        upload_files_example(driver, [cv])
        assert JobPage(ux).attached_filenames() == [
            "old_prefilled_cv.pdf", "new_cv.pdf"]

    def test_refuses_when_attachments_cannot_be_removed(self, load, ux, tmp_path,
                                                        monkeypatch):
        cv = tmp_path / "new_cv.pdf"
        cv.write_bytes(b"%PDF-1.4 fake\n")
        load(ATTACHMENTS_PAGE)
        job = JobPage(ux)
        # Simulate deletion silently failing.
        monkeypatch.setattr(job, "delete_all_attachments", lambda: 0)
        with pytest.raises(ApplicationStateError):
            job.experience_page(files=[cv])


# -------------------------------------------------------------------------
# Text fields: replace, never append
# -------------------------------------------------------------------------

class TestTypeReplaces:
    def test_replaces_value_on_a_react_style_field(self, load, ux):
        load(STUBBORN_FIELD)
        ux.type("//input[@id='f']", "NEW VALUE")
        assert ux.value_of(ux.find("//input[@id='f']")) == "NEW VALUE"

    def test_does_not_append_to_existing_text(self, load, ux):
        load(STUBBORN_FIELD)
        ux.type("//input[@id='f']", "NEW VALUE")
        value = ux.value_of(ux.find("//input[@id='f']"))
        assert "OLD VALUE" not in value

    def test_plain_field_still_works(self, load, ux):
        load('<input id="f" value="prefilled">')
        ux.type("//input[@id='f']", "typed")
        assert ux.value_of(ux.find("//input[@id='f']")) == "typed"

    def test_raises_rather_than_submitting_wrong_text(self, load, ux):
        load(IMPOSSIBLE_FIELD)
        with pytest.raises(FieldWriteError):
            ux.type("//input[@id='f']", "NEW VALUE")


# -------------------------------------------------------------------------
# Overlay-covered buttons
# -------------------------------------------------------------------------

# Workday's sign-in submit, as it is actually served: the <button> is
# aria-hidden and carries no handler of its own, while a transparent sibling
# div (data-automation-id="click_filter") sitting exactly on top of it holds
# the click listener. Verified live on 2026-08-19 - clicking the button did
# nothing at all, with no error shown on the page.
OVERLAID_BUTTON = """
<div style="position:relative;width:220px;height:40px">
  <button type="submit" data-automation-id="signInSubmitButton"
          aria-hidden="true" tabindex="-2"
          style="position:absolute;left:0;top:0;width:100%;height:100%">
    Sign In
  </button>
  <div role="button" aria-label="Sign In" tabindex="0"
       data-automation-id="click_filter"
       style="position:absolute;left:0;top:0;width:100%;height:100%"></div>
</div>
<div id="result" style="margin-top:80px">not clicked</div>
<script>
  // Only the overlay listens. The button underneath is inert, exactly as on
  // the real page.
  document.querySelector('[data-automation-id="click_filter"]')
    .addEventListener('click', function () {
      document.getElementById('result').textContent = 'submitted';
    });
</script>
"""


class TestOverlaidButton:
    def test_click_reaches_the_overlay_handler(self, load, ux):
        d = load(OVERLAID_BUTTON)
        ux.click(loc.login_submit)
        assert d.find_element(By.ID, "result").text == "submitted"

    def test_mock_reproduces_the_bug(self, load, ux):
        """Guard on the fixture itself.

        A synthetic click on the button - the old JS fallback - must still be a
        no-op here. If this ever passes as 'submitted', the mock stopped
        reproducing the defect and the test above proves nothing.
        """
        d = load(OVERLAID_BUTTON)
        el = d.find_element(By.XPATH, loc.login_submit)
        d.execute_script("arguments[0].click();", el)
        assert d.find_element(By.ID, "result").text == "not clicked"


# -------------------------------------------------------------------------
# Late-rendering posting
# -------------------------------------------------------------------------

# Workday draws the Apply button with JavaScript well after the document has
# loaded. This mock reproduces that: the CTA appears 1.2s in.
LATE_POSTING = """
<h1>Loading...</h1>
<div id="cta"></div>
<script>
  setTimeout(function () {
    document.getElementById('cta').innerHTML =
      '<a href="/apply" data-automation-id="adventureButton">Apply</a>';
  }, 1200);
</script>
"""


class TestLateRenderingPosting:
    def test_waits_for_the_call_to_action(self, load, ux):
        load(LATE_POSTING)
        job = JobPage(ux)
        assert job.wait_for_posting() is True
        assert job.posting_state() == "new"

    def test_reading_state_too_early_sees_nothing(self, load, ux):
        """Guard on the fixture: without the wait the posting looks empty.

        This is the live failure - state came back "unknown" and the run
        stopped for a human on a perfectly ordinary posting.
        """
        load(LATE_POSTING)
        assert JobPage(ux).posting_state() == "unknown"


# -------------------------------------------------------------------------
# Obstruction that is not a click proxy
# -------------------------------------------------------------------------

# The previous-employee radio, with Workday's sticky page footer over it. The
# footer intercepts the click but is NOT a stand-in for the label: clicking it
# would tick nothing and silently skip the question.
FOOTER_OVER_LABEL = """
<div style="height:600px">scroll filler</div>
<input type="radio" name="candidateIsPreviousWorker" value="false" id="r1">
<label for="r1">No</label>
<div style="height:600px">scroll filler</div>
<div data-automation-id="pageFooter"
     style="position:fixed;top:30%;left:0;right:0;bottom:0;background:#eee"
     onclick="document.title='FOOTER CLICKED'"></div>
"""


class TestNonProxyObstruction:
    def test_radio_is_ticked_despite_the_footer(self, load, ux):
        d = load(FOOTER_OVER_LABEL)
        ux.click("//label[@for='r1']")
        assert d.find_element(By.ID, "r1").is_selected()

    def test_the_footer_itself_is_never_clicked(self, load, ux):
        """The obstruction must not be mistaken for a click proxy.

        Clicking the footer would look like success while leaving the question
        unanswered.
        """
        d = load(FOOTER_OVER_LABEL)
        ux.click("//label[@for='r1']")
        assert d.title != "FOOTER CLICKED"


# -------------------------------------------------------------------------
# Session detection
# -------------------------------------------------------------------------

# The signed-in utility bar, as Workday renders it. The account button is
# identified by its *id*; its data-automation-id is the generic
# utilityMenuButton, shared with the language and settings menus.
SIGNED_IN_BAR = """
<button data-automation-id="utilityMenuButton" id="languageSelectorButton">English</button>
<button data-automation-id="utilityMenuButton" id="accountSettingsButton">a@b.com</button>
<button data-automation-id="navigationItem-Candidate Home">Candidate Home</button>
"""

SIGNED_OUT_BAR = """
<button data-automation-id="utilityMenuButton" id="languageSelectorButton">English</button>
<button data-automation-id="utilityButtonSignIn">Sign In</button>
"""


class TestSessionDetection:
    def test_recognises_a_signed_in_bar(self, load):
        d = load(SIGNED_IN_BAR)
        assert looks_signed_in(d) is True

    def test_recognises_a_signed_out_bar(self, load):
        d = load(SIGNED_OUT_BAR)
        assert looks_signed_in(d) is False

    def test_account_button_is_matched_by_id_not_automation_id(self, load):
        """The live false negative: matching accountSettingsButton as a
        data-automation-id finds nothing, so a good session reads as signed
        out and the run tries to sign in again on every posting."""
        d = load(SIGNED_IN_BAR)
        assert not d.find_elements(
            By.XPATH, "//button[@data-automation-id='accountSettingsButton']")
        assert d.find_elements(By.XPATH, "//button[@id='accountSettingsButton']")

    def test_undecided_page_is_not_reported_as_signed_in(self, load):
        """Neither marker present yet - must not guess optimistically."""
        d = load("<div>still loading</div>")
        assert looks_signed_in(d) is False


# -------------------------------------------------------------------------
# Dropdown that ignores the first click
# -------------------------------------------------------------------------

# Workday's "How did you hear about us" prompt, reproducing the live flake:
# the handler is not attached for the first click, so the list stays shut and
# the option never appears.
FLAKY_DROPDOWN = """
<button id="source--source">Select One</button>
<ul id="opts" style="display:none">
  <li role="option">Airbus Careers Website</li>
  <li role="option">LinkedIn</li>
</ul>
<div id="picked">none</div>
<script>
  var clicks = 0;
  document.getElementById('source--source').addEventListener('click', function () {
    clicks += 1;
    // The first click is swallowed, exactly as observed live.
    if (clicks > 1) document.getElementById('opts').style.display = 'block';
  });
  document.querySelectorAll('#opts li').forEach(function (li) {
    li.addEventListener('click', function () {
      document.getElementById('picked').textContent = li.textContent;
    });
  });
</script>
"""


class TestFlakyDropdown:
    def test_retries_until_the_list_opens(self, load, ux):
        d = load(FLAKY_DROPDOWN)
        ux.choose_option("//button[@id='source--source']",
                         "//li[@role='option'][normalize-space()='Airbus Careers Website']")
        assert d.find_element(By.ID, "picked").text == "Airbus Careers Website"

    def test_a_single_click_would_have_failed(self, load, ux):
        """Guard on the fixture: one click leaves the list shut.

        This is the live failure - the run then waited out the full timeout on
        an option that was never going to appear.
        """
        d = load(FLAKY_DROPDOWN)
        ux.click("//button[@id='source--source']")
        option = "//li[@role='option'][normalize-space()='Airbus Careers Website']"
        # Present in the DOM the whole time - which is exactly why the old code
        # found it and then waited out the timeout for it to become clickable.
        assert ux.exists(option)
        assert not ux.visible(option)


# -------------------------------------------------------------------------
# Save and Continue that did not go anywhere
# -------------------------------------------------------------------------

# Workday re-renders the same page with an error summary when a required field
# is empty. Nothing about the click itself fails, so the run believes it
# advanced - and the next step's code then runs against the page it never left.
REJECTED_PAGE = """
<input name="legalName--firstName" aria-invalid="true" aria-required="true">
<div id="error1-name--legalName--firstName">
  The field Given Name(s) is required and must have a value.
</div>
<input name="phoneNumber" aria-invalid="true" aria-required="true">
<div id="error1-phoneNumber--phoneNumber">
  The field Phone Number is required and must have a value.
</div>
<button data-automation-id="pageFooterNextButton">Save and Continue</button>
"""

ACCEPTED_PAGE = """
<input name="legalName--firstName" aria-invalid="false" value="Mohammad">
<button data-automation-id="pageFooterNextButton">Save and Continue</button>
"""


class TestRejectedPage:
    def test_reports_what_the_page_rejected(self, load, ux):
        load(REJECTED_PAGE)
        errors = validation_errors(ux)
        assert any("Given Name(s)" in e for e in errors)
        assert any("Phone Number" in e for e in errors)

    def test_accepted_page_reports_nothing(self, load, ux):
        load(ACCEPTED_PAGE)
        assert validation_errors(ux) == []

    def test_save_and_continue_refuses_to_pretend_it_worked(self, load, ux):
        load(REJECTED_PAGE)
        with pytest.raises(ApplicationStateError):
            JobPage(ux).save_and_continue("My Information")

    def test_save_and_continue_passes_on_a_clean_page(self, load, ux):
        load(ACCEPTED_PAGE)
        JobPage(ux).save_and_continue("My Information")   # must not raise


# -------------------------------------------------------------------------
# Field that re-renders while being written
# -------------------------------------------------------------------------

# React replaces the input element as soon as it is first written to, which
# invalidates Selenium's handle. Observed live on a resumed draft.
SELF_REPLACING_FIELD = """
<div id="host"><input id="f" value=""></div>
<script>
  var swapped = false;
  document.getElementById('host').addEventListener('input', function () {
    if (swapped) return;
    swapped = true;
    // Replace the node, exactly as a re-render would.
    var old = document.getElementById('f');
    var fresh = document.createElement('input');
    fresh.id = 'f';
    fresh.value = '';
    old.parentNode.replaceChild(fresh, old);
  });
</script>
"""


class TestSelfReplacingField:
    def test_write_survives_the_re_render(self, load, ux):
        d = load(SELF_REPLACING_FIELD)
        ux.type("//input[@id='f']", "Mohammad")
        assert d.find_element(By.ID, "f").get_attribute("value") == "Mohammad"


# -------------------------------------------------------------------------
# Reading the current wizard step
# -------------------------------------------------------------------------

PROGRESS_BAR = """
<ul>
  <li data-automation-id="progressBarInactiveStep">step 1 of 5 My Information</li>
  <li data-automation-id="progressBarActiveStep">current step 2 of 5 My Experience</li>
  <li data-automation-id="progressBarInactiveStep">step 3 of 5 Application Questions</li>
</ul>
"""


class TestCurrentStep:
    def test_reads_the_active_step(self, load, ux):
        load(PROGRESS_BAR)
        assert JobPage(ux).current_step() == "My Experience"

    def test_empty_off_the_wizard(self, load, ux):
        load("<div>a job posting</div>")
        assert JobPage(ux).current_step() == ""


# -------------------------------------------------------------------------
# Prefilled identity must survive
# -------------------------------------------------------------------------

# "Use My Last Application" brings the candidate's own previous answers across.
# Overwriting them with configured defaults is a regression, not a fix - the
# live prefill had "Machaka" and "07 53 37 78 23" where the config held
# "MACHAKA" and "0753377823".
PREFILLED_IDENTITY = """
<div data-automation-id="formField-legalName--firstName">
  <input name="legalName--firstName" value="Mohammad">
</div>
<div data-automation-id="formField-legalName--lastName">
  <input name="legalName--lastName" value="Machaka">
</div>
<div data-automation-id="formField-phoneNumber">
  <input name="phoneNumber" value="07 53 37 78 23">
</div>
<div data-automation-id="formField-addressLine1">
  <input name="addressLine1" value="">
</div>
"""


class _Candidate:
    given_name = "Mohammad"
    family_name = "MACHAKA"
    phone_number = "0753377823"
    address_line1 = "39 allee d'Ancely"
    city = ""
    postal_code = ""


class TestPrefilledIdentity:
    def test_existing_values_are_left_alone(self, load, ux):
        d = load(PREFILLED_IDENTITY)
        JobPage(ux).fill_personal_information(_Candidate())
        assert d.find_element(By.NAME, "legalName--lastName").get_attribute("value") == "Machaka"
        assert d.find_element(By.NAME, "phoneNumber").get_attribute("value") == "07 53 37 78 23"

    def test_empty_fields_are_still_filled(self, load, ux):
        d = load(PREFILLED_IDENTITY)
        JobPage(ux).fill_personal_information(_Candidate())
        assert d.find_element(By.NAME, "addressLine1").get_attribute("value") == "39 allee d'Ancely"


# -------------------------------------------------------------------------
# A save that silently goes nowhere
# -------------------------------------------------------------------------

# Live on 2026-08-19: My Experience refused to advance because School was
# unfillable, but no field carried aria-invalid, so the error check came back
# clean and the run reported success. Not moving is the signal.
STUCK_PAGE = """
<ul>
  <li data-automation-id="progressBarActiveStep">current step 2 of 5 My Experience</li>
</ul>
<button data-automation-id="pageFooterNextButton">Save and Continue</button>
"""

ADVANCING_PAGE = """
<ul>
  <li data-automation-id="progressBarActiveStep">current step 2 of 5 My Experience</li>
</ul>
<button data-automation-id="pageFooterNextButton" onclick="
  document.querySelector('[data-automation-id=progressBarActiveStep]').textContent
    = 'current step 3 of 5 Application Questions';">Save and Continue</button>
"""


class TestSaveThatGoesNowhere:
    def test_raises_when_the_step_does_not_change(self, load, ux):
        load(STUCK_PAGE)
        with pytest.raises(ApplicationStateError):
            JobPage(ux).save_and_continue("My Experience")

    def test_no_flagged_field_is_not_proof_of_success(self, load, ux):
        """Guard on the fixture: nothing here is aria-invalid."""
        load(STUCK_PAGE)
        assert validation_errors(ux) == []

    def test_passes_when_the_step_advances(self, load, ux):
        load(ADVANCING_PAGE)
        JobPage(ux).save_and_continue("My Experience")   # must not raise


# -------------------------------------------------------------------------
# Prefilled education must survive
# -------------------------------------------------------------------------

# A Workday multiselect keeps its chosen values in selectedItem nodes; the
# search input's value is always "". Reading the input alone reported a
# populated School field as empty and typed over the candidate's real schools.
PREFILLED_EDUCATION = """
<div data-automation-id="formField-school">
  <div data-automation-id="selectedItem">Universite Paul Sabatier - Toulouse 3 (UPS)</div>
  <input id="education-9--school" value="">
</div>
<div data-automation-id="formField-degree"><button>FR- Master (LMD)</button></div>
"""


class TestPrefilledEducation:
    def test_leaves_a_populated_section_alone(self, load, ux):
        d = load(PREFILLED_EDUCATION)

        class Data:
            university = "SOMETHING ELSE"
            course = "Other"
            degree = "FR- Master (LMD)"

        ApplicationWizard(d, ux, Data(), dry_run=True).fill_education()
        assert d.find_element(By.ID, "education-9--school").get_attribute("value") == ""

    def test_the_input_value_is_empty_even_when_filled(self, load, ux):
        """Guard on the fixture: this is why reading value misled us."""
        d = load(PREFILLED_EDUCATION)
        assert d.find_element(By.ID, "education-9--school").get_attribute("value") == ""
        assert ux.exists(loc.education_school_selected)


# -------------------------------------------------------------------------
# Prefilled previous-employment answer must survive
# -------------------------------------------------------------------------

# Live: prefill had Yes (the candidate works at Airbus), the configured default
# was No. Overwriting it would put a false statement on a job application.
PREFILLED_PREVIOUS_WORKER = """
<input type="radio" name="candidateIsPreviousWorker" value="true" id="y" checked>
<label for="y">Yes</label>
<input type="radio" name="candidateIsPreviousWorker" value="false" id="n">
<label for="n">No</label>
"""


class TestPreviousWorkerPrefill:
    def test_prefilled_yes_is_not_flipped_to_no(self, load, ux):
        d = load(PREFILLED_PREVIOUS_WORKER)

        class Data:
            previous_worker = False      # the wrong default

        JobPage(ux)._answer_previous_worker(Data())
        assert d.find_element(By.ID, "y").is_selected()
        assert not d.find_element(By.ID, "n").is_selected()

    def test_unanswered_question_still_gets_answered(self, load, ux):
        d = load(PREFILLED_PREVIOUS_WORKER.replace(" checked", ""))

        class Data:
            previous_worker = False

        JobPage(ux)._answer_previous_worker(Data())
        assert d.find_element(By.ID, "n").is_selected()


# -------------------------------------------------------------------------
# Prefilled languages must survive
# -------------------------------------------------------------------------

# Live 2026-08-20: prefill supplied three languages; forcing "English" onto the
# first row overwrote one and left English listed twice.
PREFILLED_LANGUAGES = """
<div data-automation-id="formField-language"><button id="l5">Arabic</button></div>
<div data-automation-id="formField-language"><button id="l6">English</button></div>
<div data-automation-id="formField-language"><button id="l7">French</button></div>
"""

EMPTY_LANGUAGES = """
<div data-automation-id="formField-language"><button id="l5">Select One</button></div>
"""


class TestPrefilledLanguages:
    def test_chosen_languages_are_left_alone(self, load, ux):
        d = load(PREFILLED_LANGUAGES)
        ApplicationWizard(d, ux, object(), dry_run=True).set_languages()
        assert d.find_element(By.ID, "l5").text == "Arabic"
        assert [d.find_element(By.ID, i).text for i in ("l5", "l6", "l7")] \
            == ["Arabic", "English", "French"]

    def test_an_unset_row_is_still_detected_as_empty(self, load, ux):
        """Guard on the fixture: 'Select One' must not count as chosen."""
        d = load(EMPTY_LANGUAGES)
        chosen = [e.text for e in ux.find_all(loc.language_choice)]
        assert chosen == ["Select One"]


# -------------------------------------------------------------------------
# An already-answered question is not unanswered
# -------------------------------------------------------------------------

# Live 2026-08-20: the candidate answered the disability question in the
# browser; the run parked it anyway and stopped a complete page.
ANSWERED_QUESTION = """
<div><p>I am severely disabled according to section 152 SGB IX, and would like
it taken into account during the application process.</p>
<button id="primaryQuestionnaire--abc123">No</button></div>
"""

UNANSWERED_QUESTION = ANSWERED_QUESTION.replace(">No<", ">Select One<")


class TestAlreadyAnsweredQuestion:
    def test_existing_answer_is_left_alone_and_not_parked(self, load, ux):
        d = load(ANSWERED_QUESTION)
        wiz = ApplicationWizard(d, ux, object(), dry_run=True)
        assert wiz.answer_questions({}) == []
        assert d.find_element(By.ID, "primaryQuestionnaire--abc123").text == "No"

    def test_unanswered_question_is_still_parked(self, load, ux):
        """Guard on the fixture: 'Select One' must still count as unanswered."""
        d = load(UNANSWERED_QUESTION)
        wiz = ApplicationWizard(d, ux, object(), dry_run=True)
        parked = wiz.answer_questions({})
        assert len(parked) == 1
        assert "severely disabled" in parked[0]["question"]


# -------------------------------------------------------------------------
# Dropdown answers are full sentences, not "Yes"/"No"
# -------------------------------------------------------------------------

# Live 2026-08-20: the OETH question offers
#   "Yes, I am a beneficiary of the OETH" / "No, I am not a beneficiary ..."
# so an exact match on "No" waits out the timeout on an option that is not
# there.
SENTENCE_OPTIONS = """
<button id="q1">Select One</button>
<ul id="opts" style="display:none">
  <li role="option">Select One</li>
  <li role="option">Yes, I am a beneficiary of the OETH</li>
  <li role="option">No, I am not a beneficiary of the OETH</li>
  <li role="option">I do not wish to answer</li>
</ul>
<div id="picked">none</div>
<script>
  document.getElementById('q1').addEventListener('click', function () {
    document.getElementById('opts').style.display = 'block';
  });
  document.querySelectorAll('#opts li').forEach(function (li) {
    li.addEventListener('click', function () {
      document.getElementById('picked').textContent = li.textContent;
    });
  });
</script>
"""


class TestSentenceOptions:
    def test_short_answer_matches_the_full_sentence(self, load, ux):
        d = load(SENTENCE_OPTIONS)
        ux.choose_option_by_text("//button[@id='q1']", "No")
        assert d.find_element(By.ID, "picked").text == \
            "No, I am not a beneficiary of the OETH"

    def test_it_does_not_pick_the_yes_option(self, load, ux):
        d = load(SENTENCE_OPTIONS)
        ux.choose_option_by_text("//button[@id='q1']", "No")
        assert "Yes" not in d.find_element(By.ID, "picked").text

    def test_exact_text_locator_would_have_missed(self, load, ux):
        """Guard on the fixture: there is no option whose text is just "No"."""
        d = load(SENTENCE_OPTIONS)
        d.find_element(By.ID, "q1").click()
        assert not ux.exists("//li[@role='option'][normalize-space()='No']")

    def test_unknown_answer_reports_what_was_offered(self, load, ux):
        load(SENTENCE_OPTIONS)
        with pytest.raises(FieldWriteError) as e:
            ux.choose_option_by_text("//button[@id='q1']", "Maybe")
        assert "beneficiary" in str(e.value)


# -------------------------------------------------------------------------
# Submit that was clicked but never landed
# -------------------------------------------------------------------------

# The only irreversible click on the flow, and the one the run was taking on
# faith: submit() returned True as soon as the click returned. A Review page
# that refuses looks exactly like this - the button is still there, nothing
# raised - and the posting was written to succ_links.txt and never retried.
SUBMIT_REFUSED = """
<ul>
  <li data-automation-id="progressBarActiveStep">current step 5 of 5 Review</li>
</ul>
<button>Submit</button>
"""

SUBMIT_ACCEPTED = """
<div id="page">
  <ul>
    <li data-automation-id="progressBarActiveStep">current step 5 of 5 Review</li>
  </ul>
  <button onclick="
    document.getElementById('page').innerHTML =
      '<h2>Application Submitted</h2>';">Submit</button>
</div>
"""


class _Silent:
    """Stand-in for CandidateData; submit() reads nothing off it."""


class TestSubmitConfirmation:
    def _wizard(self, driver, ux):
        w = ApplicationWizard(driver, ux, _Silent(), dry_run=False)
        w.SUBMIT_CONFIRM_S = 2      # keep the refused case quick
        return w

    def test_unconfirmed_submit_is_not_reported_as_submitted(self, load, ux,
                                                             driver):
        load(SUBMIT_REFUSED)
        assert self._wizard(driver, ux).submit() is False

    def test_confirmed_submit_is_reported_as_submitted(self, load, ux, driver):
        load(SUBMIT_ACCEPTED)
        assert self._wizard(driver, ux).submit() is True

    def test_dry_run_never_clicks(self, load, ux, driver):
        d = load(SUBMIT_ACCEPTED)
        w = ApplicationWizard(driver, ux, _Silent(), dry_run=True)
        assert w.submit() is False
        # The page is untouched: Submit is still there to be clicked.
        assert d.find_elements(By.XPATH, loc.submit)

    def test_the_old_click_and_hope_would_have_passed(self, load, ux, driver):
        """Guard on the fixture: the refused page raises nothing on click."""
        d = load(SUBMIT_REFUSED)
        ux.click(loc.submit)
        assert not d.find_elements(By.XPATH, loc.submitted_markers)


# -------------------------------------------------------------------------
# Voluntary Disclosures must be saved like every other step
# -------------------------------------------------------------------------

# This page was the one exception: it clicked Save and Continue and returned,
# so a refused Voluntary Disclosures page fell straight through to Submit -
# the single click on this flow that cannot be undone.
DISCLOSURES = """
<ul>
  <li data-automation-id="progressBarActiveStep">{step}</li>
</ul>
<div id="personalInfoPerson--dateOfBirth-dateSectionMonth-display">MM</div>
<input id="personalInfoPerson--additionalNationalities">
<button id="personalInfoPerson--nationality">Select One</button>
<div>Lebanon</div>
<label for="termsAndConditions--acceptTermsAndAgreements">I accept</label>
<div data-automation-id="formField-gender"><button>Select One</button></div>
<div>Male</div>
<button data-automation-id="pageFooterNextButton" {onclick}>Save and Continue</button>
"""

STUCK_DISCLOSURES = DISCLOSURES.format(
    step="current step 4 of 5 Voluntary Disclosures", onclick="")

ADVANCING_DISCLOSURES = DISCLOSURES.format(
    step="current step 4 of 5 Voluntary Disclosures",
    onclick="""onclick="
  document.querySelector('[data-automation-id=progressBarActiveStep]').textContent
    = 'current step 5 of 5 Review';" """)


class _Disclosable:
    birth_mmddyyyy = "06101999"


class TestDisclosuresSaveIsChecked:
    def test_raises_when_the_page_does_not_advance(self, load, ux, driver):
        load(STUCK_DISCLOSURES)
        wiz = ApplicationWizard(driver, ux, _Disclosable(), dry_run=False)
        with pytest.raises(ApplicationStateError):
            wiz.final_page()

    def test_passes_when_the_page_advances(self, load, ux, driver):
        load(ADVANCING_DISCLOSURES)
        wiz = ApplicationWizard(driver, ux, _Disclosable(), dry_run=False)
        wiz.final_page()      # must not raise
        assert JobPage(ux).current_step() == "Review"


# -------------------------------------------------------------------------
# A refusal that names what is actually empty
# -------------------------------------------------------------------------

# Live on 2026-08-21: My Experience refused to advance and the run reported
# "no field was flagged", because Workday marks these aria-required but only
# sets aria-invalid once it decides to complain. Three empty School inputs were
# sitting in the captured HTML the whole time.
SILENTLY_REFUSING = """
<ul>
  <li data-automation-id="progressBarActiveStep">current step 2 of 5 My Experience</li>
</ul>
<label for="education-8--school">School or University*</label>
<input id="education-8--school" aria-required="true" value="">
<label for="education-9--school">School or University*</label>
<input id="education-9--school" aria-required="true" value="">
<input id="legalName--firstName" aria-required="true" value="Mohammad">
<button data-automation-id="pageFooterNextButton">Save and Continue</button>
"""


class TestRefusalNamesTheEmptyField:
    def test_lists_the_blank_required_fields(self, load, ux):
        load(SILENTLY_REFUSING)
        blank = blank_required_fields(ux)
        assert any("School or University" in b for b in blank)
        assert any("education-8--school" in b for b in blank)

    def test_a_filled_required_field_is_not_listed(self, load, ux):
        load(SILENTLY_REFUSING)
        assert not any("firstName" in b for b in blank_required_fields(ux))

    def test_the_error_says_what_is_empty(self, load, ux):
        load(SILENTLY_REFUSING)
        with pytest.raises(ApplicationStateError) as e:
            JobPage(ux).save_and_continue("My Experience")
        message = str(e.value)
        assert "School or University" in message
        # The old wording gave the operator nothing to act on.
        assert "no field was flagged" not in message

    def test_still_honest_when_nothing_is_empty(self, load, ux):
        """A page refusing with everything filled must not invent a cause."""
        load(STUCK_PAGE)
        with pytest.raises(ApplicationStateError) as e:
            JobPage(ux).save_and_continue("My Experience")
        assert "refusing for a reason it did not show" in str(e.value)

    def test_flagged_errors_still_win(self, load, ux):
        """aria-invalid messages are more specific; they come first."""
        load(REJECTED_PAGE)
        with pytest.raises(ApplicationStateError) as e:
            JobPage(ux).save_and_continue("My Information")
        assert "Given Name(s)" in str(e.value)


# -------------------------------------------------------------------------
# A multiselect's search box is always empty
# -------------------------------------------------------------------------

# Read off Accenture's My Information page, 2026-08-21. Both controls are
# Workday multiselects whose visible input carries value="" no matter what is
# chosen; the truth is in promptAriaInstruction. Reading the input alone
# reported an already-filled Country Phone Code as a blank required field.
MULTISELECTS = """
<label for="source--source">How Did You Hear About Us?*</label>
<div data-automation-id="multiSelectContainer">
  <input id="source--source" aria-required="true" value="">
  <div data-automation-id="promptAriaInstruction">0 items selected</div>
</div>

<label for="open--menu">An open menu*</label>
<div data-automation-id="multiSelectContainer">
  <input id="open--menu" aria-required="true" value="">
  <div data-automation-id="promptAriaInstruction">Expanded</div>
</div>

<label for="phoneNumber--countryPhoneCode">Country/Territory Phone Code*</label>
<div data-automation-id="multiSelectContainer">
  <input id="phoneNumber--countryPhoneCode" aria-required="true" value="">
  <div data-automation-id="promptAriaInstruction">1 item selected, France (+33)</div>
  <ul data-automation-id="selectedItemList"><li>France (+33)</li></ul>
</div>

<label for="education-8--school">School or University*</label>
<div data-automation-id="multiSelectContainer">
  <input id="education-8--school" aria-required="true" value="">
  <div data-automation-id="selectedItem">Universite Paul Sabatier</div>
</div>
"""


class TestMultiselectIsNotBlank:
    def test_an_empty_multiselect_is_still_reported(self, load, ux):
        load(MULTISELECTS)
        blank = blank_required_fields(ux)
        assert any("source--source" in b for b in blank)

    def test_a_chosen_multiselect_is_not_reported(self, load, ux):
        """"1 item selected, France (+33)" is filled, whatever value says."""
        load(MULTISELECTS)
        assert not any("countryPhoneCode" in b
                       for b in blank_required_fields(ux))

    def test_a_selected_item_node_also_counts_as_filled(self, load, ux):
        load(MULTISELECTS)
        assert not any("education-8--school" in b
                       for b in blank_required_fields(ux))

    def test_reading_value_alone_would_have_failed(self, load, ux):
        """Guard on the fixture: every one of these inputs is value=""."""
        d = load(MULTISELECTS)
        for el in d.find_elements(By.CSS_SELECTOR, "input[aria-required]"):
            assert (el.get_attribute("value") or "") == ""


class TestExpandedIsNotASelection:
    """While a Workday multiselect menu is open, promptAriaInstruction reads
    "Expanded" rather than a count. Treating any non-"0" text as a selection
    reported a genuinely empty required field as filled (Accenture,
    2026-08-21) - the opposite of the bug it was added to fix."""

    def test_an_open_menu_is_still_empty(self, load, ux):
        load(MULTISELECTS)
        assert any("open--menu" in b for b in blank_required_fields(ux))

    def test_a_real_count_still_reads_as_filled(self, load, ux):
        load(MULTISELECTS)
        assert not any("countryPhoneCode" in b
                       for b in blank_required_fields(ux))

    def test_zero_items_is_empty(self, load, ux):
        load(MULTISELECTS)
        assert any("source--source" in b for b in blank_required_fields(ux))


# -------------------------------------------------------------------------
# Two answers that share a long prefix
# -------------------------------------------------------------------------

# Accenture's AI-consent question, read live 2026-08-21. Both answers begin
# "I understand and I'm ready to continue with...", so a prefix match picks
# whichever renders first - and picking the wrong one records the opposite of
# the candidate's consent on a real application.
AI_CONSENT = """
<button id="q1">Select One</button>
<ul id="opts" style="display:none">
  <li role="option">I understand and I&rsquo;m ready to continue with my application involving artificial intelligence</li>
  <li role="option">I understand and I&rsquo;m ready to continue without my application involving artificial intelligence</li>
</ul>
<div id="picked">none</div>
<script>
  document.getElementById('q1').addEventListener('click', function () {
    document.getElementById('opts').style.display = 'block';
  });
  document.querySelectorAll('#opts li').forEach(function (li) {
    li.addEventListener('click', function () {
      document.getElementById('picked').textContent = li.textContent;
    });
  });
</script>
"""


class TestSharedPrefixAnswers:
    def test_a_unique_substring_picks_the_right_one(self, load, ux):
        d = load(AI_CONSENT)
        ux.choose_option_by_text(
            "//button[@id='q1']",
            "continue with my application involving artificial intelligence")
        picked = d.find_element(By.ID, "picked").text
        assert "without" not in picked

    def test_the_opposite_choice_is_reachable_too(self, load, ux):
        d = load(AI_CONSENT)
        ux.choose_option_by_text(
            "//button[@id='q1']",
            "continue without my application involving artificial intelligence")
        assert "without" in d.find_element(By.ID, "picked").text

    def test_an_ambiguous_answer_is_refused_not_guessed(self, load, ux):
        """"I understand and I" matches both. Silently taking the first is how
        a consent answer becomes its opposite."""
        load(AI_CONSENT)
        with pytest.raises(FieldWriteError) as e:
            ux.choose_option_by_text("//button[@id='q1']", "I understand and I")
        assert "ambiguous" in str(e.value)

    def test_the_configured_answer_file_is_unambiguous(self):
        """Guard on answers/accenture.json itself."""
        import json
        from pathlib import Path
        answers = json.loads(
            (Path(__file__).resolve().parent.parent / "answers"
             / "accenture.json").read_text(encoding="utf-8"))
        wanted = answers["may use artificial intelligence"]
        options = ["i understand and i'm ready to continue with my application "
                   "involving artificial intelligence",
                   "i understand and i'm ready to continue without my "
                   "application involving artificial intelligence"]
        assert sum(wanted.casefold() in o for o in options) == 1


# -------------------------------------------------------------------------
# Attachments that are already correct
# -------------------------------------------------------------------------

# Accenture's My Experience carries a CV upload *and* one upload area per
# certification. A blanket delete removed a certification document the
# candidate had attached by hand (2026-08-21), and the delete/upload churn
# also left the page silently refusing to advance.
ALREADY_RIGHT = """
<div id="item" data-automation-id="file-upload-item">
  <div data-automation-id="file-upload-item-name">Mohammad_CV_2_Parts.pdf</div>
  <button data-automation-id="delete-file"
          onclick="document.getElementById('item').remove();">Delete</button>
</div>
<input data-automation-id="file-upload-input-ref" type="file">
<button data-automation-id="pageFooterNextButton">Save and Continue</button>
"""


class TestAttachmentAlreadyCorrect:
    def test_identical_attachment_is_left_alone(self, load, ux, tmp_path):
        d = load(ALREADY_RIGHT)
        cv = tmp_path / "Mohammad_CV_2_Parts.pdf"
        cv.write_bytes(b"%PDF-1.4 test")
        JobPage(ux).experience_page(files=[cv])
        # Nothing deleted: the delete button is still there.
        assert d.find_elements(By.CSS_SELECTOR, "button[data-automation-id='delete-file']")
        assert JobPage(ux).attached_filenames() == ["Mohammad_CV_2_Parts.pdf"]

    def test_a_different_file_still_replaces(self, load, ux, tmp_path):
        """The replace-not-append behaviour must survive this shortcut."""
        d = load(ALREADY_RIGHT)
        other = tmp_path / "Some_Other_CV.pdf"
        other.write_bytes(b"%PDF-1.4 test")
        try:
            JobPage(ux).experience_page(files=[other])
        except Exception:
            pass  # upload has no real input in this fixture
        # It got as far as clearing the stale file rather than skipping.
        assert not d.find_elements(
            By.CSS_SELECTOR, "button[data-automation-id='delete-file']")


# -------------------------------------------------------------------------
# A searchable multiselect records nothing until an option is clicked
# -------------------------------------------------------------------------

# Accenture, 2026-08-21: fill_education typed the university name into the
# School box and moved on. The value appeared to go in, and then the page
# refused with "The field School or University is required and must have a
# value" - because typing only filters; nothing is recorded until a click.
SEARCHABLE_SCHOOL = """
<input id="education-1--school" value="">
<ul id="opts" style="display:none">
  <li role="option">Universit&eacute; Toulouse 3 Paul Sabatier</li>
  <li role="option">Universite Toulouse 1 Capitole</li>
</ul>
<div id="picked">none</div>
<script>
  document.getElementById('education-1--school')
    .addEventListener('input', function () {
      document.getElementById('opts').style.display = 'block';
    });
  document.querySelectorAll('#opts li').forEach(function (li) {
    li.addEventListener('click', function () {
      document.getElementById('picked').textContent = li.textContent;
    });
  });
</script>
"""


class TestSearchableMultiselect:
    def test_typing_alone_records_nothing(self, load, ux):
        """Guard on the fixture: this is exactly the failure mode."""
        d = load(SEARCHABLE_SCHOOL)
        ux.type("//input[@id='education-1--school']",
                "Universite Toulouse 3 Paul Sabatier")
        assert d.find_element(By.ID, "picked").text == "none"

    def test_search_and_pick_selects_the_option(self, load, ux):
        d = load(SEARCHABLE_SCHOOL)
        ux.search_and_pick("//input[@id='education-1--school']",
                           "Universite Toulouse 3 Paul Sabatier")
        # The rendered option carries an accent the caller did not type.
        assert "Toulouse 3 Paul Sabatier" in d.find_element(By.ID, "picked").text

    def test_it_does_not_grab_the_similar_university(self, load, ux):
        d = load(SEARCHABLE_SCHOOL)
        ux.search_and_pick("//input[@id='education-1--school']",
                           "UNIVERSITE TOULOUSE III - PAUL SABATIER")
        assert "Capitole" not in d.find_element(By.ID, "picked").text

    def test_no_match_raises_rather_than_pretending(self, load, ux):
        load(SEARCHABLE_SCHOOL)
        with pytest.raises(FieldWriteError):
            ux.search_and_pick("//input[@id='education-1--school']",
                               "Massachusetts Institute of Technology")


class TestBoardsWordSchoolsDifferently:
    """Airbus offers "UNIVERSITE TOULOUSE III - PAUL SABATIER"; Accenture
    "Universite Toulouse 3 Paul Sabatier". Comparing raw text matched neither,
    so the School field stayed empty and the page refused (2026-08-22)."""

    def test_roman_numerals_and_accents_do_not_block_the_match(self, load, ux):
        d = load(SEARCHABLE_SCHOOL)
        ux.search_and_pick("//input[@id='education-1--school']",
                           "UNIVERSITÉ TOULOUSE III - PAUL SABATIER")
        assert "Toulouse 3" in d.find_element(By.ID, "picked").text

    def test_folding_is_accent_and_case_insensitive(self):
        from app.ux import _fold
        assert _fold("UNIVERSITÉ TOULOUSE III - PAUL SABATIER") ==                "universite toulouse iii paul sabatier"

    def test_an_unrelated_school_still_does_not_match(self, load, ux):
        load(SEARCHABLE_SCHOOL)
        with pytest.raises(FieldWriteError):
            ux.search_and_pick("//input[@id='education-1--school']",
                               "American University of Beirut")
