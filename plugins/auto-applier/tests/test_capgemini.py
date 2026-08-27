"""The Capgemini (SuccessFactors) flow, against local mock pages.

Same approach as tests/test_browser.py: drive real Chrome over markup that
imitates the live form, so the code paths are genuinely exercised without
sending an application to Capgemini.

What these prove: the port's logic works in a browser - the combobox retry,
the consent gate, the readback, and the refusal to call an unconfirmed submit
a success.
What they do NOT prove: that the selectors match Capgemini's real DOM. Only
`tools/apply_capgemini.py --inspect` against a signed-in session settles that,
and the submit locators in particular have never been run live - the script
this was ported from refused to click them on principle.

Run with:  .venv/Scripts/python.exe -m pytest tests/test_capgemini.py -q

Do not run two browser suites at once. These fixtures allow 3 seconds for a
control to appear, which is ample idle and not ample when a second pytest
session is driving its own Chrome: doing that on 2026-08-22 failed 14 of the
15 tests that load a page, all with timeouts, and every one of them passed on
a quiet machine straight afterwards.
"""
import json
import sys
from pathlib import Path

import pytest
from selenium import webdriver

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import app.capgemini as cg
import app.path as loc
from app.capgemini import CapgeminiForm, Outcome


# -------------------------------------------------------------------------
# Mock markup
# -------------------------------------------------------------------------
# A SAP combobox: a readonly input plus a popup <ul> of <li>. `opens_on` is how
# many clicks it takes before the list actually appears - the live form does
# not reliably open on the first one under load, which is finding 3 in
# app/capgemini.py.
def combo(index, options, opens_on=1, disabled=False, gated_by=None):
    opts = "".join(f"<li>{o}</li>" for o in options)
    return f"""
<input id="{index}:_input" readonly value="- Sélectionner -"
       {'disabled' if disabled else ''}>
<ul id="pop{index}" style="display:none">{opts}</ul>
<script>
(function() {{
  var input = document.getElementById("{index}:_input");
  var pop = document.getElementById("pop{index}");
  var clicks = 0;
  input.addEventListener('click', function() {{
    clicks++;
    if (clicks >= {opens_on}) pop.style.display = 'block';
  }});
  pop.querySelectorAll('li').forEach(function(li) {{
    li.addEventListener('click', function() {{
      input.value = li.textContent;
      pop.style.display = 'none';
      {f'''var gated = document.getElementById("{gated_by}:_input");
      if (gated) gated.disabled = false;''' if gated_by else ''}
    }});
  }});
}})();
</script>"""


SIGNED_IN_FORM = (
    '<input id="tor__fcellPhone" value="">'
    + combo(9, ["France", "Allemagne"])
    + combo(13, ["Oui", "Non"])
    + combo(17, ["Oui", "Non"])
)

# Disability: the consent at 21 ungates the detail at 25, which starts
# disabled. Finding 2.
GATED_DISABILITY = (
    combo(21, ["Oui", "Non"], gated_by=25)
    + combo(25, ["Oui", "Non"], disabled=True)
)

# A combobox that ignores the first click. Finding 3.
STICKY_COMBO = combo(37, ["Oui", "Non"], opens_on=2)


# The document slots, trimmed from the live signed-in form (2026-08-22). The
# shape is the whole point: the control is a glyphicon <span role="button">,
# the words "Modifier le document" / "Supprimer le document" sit in a SIBLING
# span.hiddenAriaContent, and the only stable way to tell the two slots apart
# is the qaResume / qaCoverLetter class on a hidden validation div.
def attach_slot(index, qa_class, action, filename):
    verb = "Modifier" if action == "addAttachments" else "Supprimer"
    icon = "pencil" if action == "addAttachments" else "trash"
    return f"""
<div id="{index}:_attachWrapper" class="attachWrapper">
  <div id="{index}:_requiredfieldWrapper" class="requiredFieldWrapper">
    <div id="{index}:_attach" class="successBtn">
      <div role="button" id="{index}:_attachDownloadLabel" class="attachmentLabel">
        <span id="{index}:_attachDownloadLabelLink">{filename}</span>
      </div>
      <div class="attachActions">
        <span tabindex="0" role="button" id="{index}:_attachIcon"
              class="glyphicon glyphicon-{icon} {action}"></span>
        <span class="hiddenAriaContent" role="tooltip" id="{index}:_ariaActionLabel"
          >{verb} le document {filename} Ouvre une boîte de dialogue</span>
      </div>
    </div>
    <div id="{index}:_validationMsg"
         class="rcmValidationMsgArea displayNone {qa_class}"></div>
  </div>
</div>"""


# displayNone really is display:none on the live form. The qa* anchor is
# therefore an invisible element, which is fine because it is only ever a
# predicate - but if that ever stops being true these tests should fail.
# .glyphicon is given a size because the live one is a font icon with
# dimensions: an empty <span> has none, and Selenium calls that neither
# displayed nor interactable, which would make these tests fail for a reason
# the real page does not have.
HIDE_CSS = ("<style>.displayNone{display:none}.hidden{display:none}"
            ".glyphicon{display:inline-block;width:16px;height:16px}</style>")

DOCUMENTS = HIDE_CSS + (
    attach_slot(67, "qaResume", "addAttachments", "cv-ancien.pdf")
    + attach_slot(69, "qaCoverLetter", "removeAttachments", "lettre-ancienne.pdf")
)


def letter_delete_page():
    """The cover-letter slot, its trash icon, and the confirmation it opens.

    Clicking the icon opens "Voulez-vous vraiment supprimer ce fichier ?" and
    only OK actually removes the file - which is the step that silently did
    not happen while the confirm locator was matching a hidden cookie button.
    """
    return DOCUMENTS + """
<div role="dialog" id="cookie-manager" class="cookieDialog hidden">
  <button id="cookie-ok">Accepter tous les cookies</button>
</div>
<div role="dialog" id="74:wrapper" class="dialogBoxWrapper fd-dialog hidden">
  <span>Voulez-vous vraiment supprimer ce fichier ?</span>
  <button title="Annuler" name="Annuler">Annuler</button>
  <button title="OK" name="OK">OK</button>
</div>
<script>
var dlg = document.getElementById("74:wrapper");
document.getElementById("69:_attachIcon").addEventListener('click', function() {
  dlg.classList.remove('hidden');
  dlg.classList.add('fd-dialog--active');
});
dlg.querySelector('button[name="OK"]').addEventListener('click', function() {
  document.getElementById("69:_attachWrapper").remove();
  dlg.classList.add('hidden');
  dlg.classList.remove('fd-dialog--active');
});
</script>"""


def submit_page(confirms=True, invalid=False):
    """A form whose submit either confirms or silently refuses."""
    reveal = ("document.getElementById('done').style.display = 'block';"
              if confirms else "")
    bad = ('<input id="tor__fcellPhone" aria-invalid="true" '
           'aria-label="Téléphone">' if invalid
           else '<input id="tor__fcellPhone">')
    return f"""
{bad}
<button id="go">Envoyer ma candidature</button>
<p id="done" style="display:none">Merci d'avoir postulé chez Capgemini</p>
<script>
document.getElementById('go').addEventListener('click', function() {{
  {reveal}
}});
</script>"""


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
        page.write_text(
            f'<html><head><meta charset="utf-8"></head><body>{html}</body></html>',
            encoding="utf-8")
        driver.get(page.as_uri())
        return driver
    return _load


@pytest.fixture
def form(driver):
    # Local pages; nothing needs waiting for.
    return CapgeminiForm(driver, timeout_s=3, micro_wait_s=0.05)


@pytest.fixture(autouse=True)
def quick_waits(monkeypatch, tmp_path):
    """The live waits make a submit test take 19 seconds. Shrink them.

    SNAPSHOT_DIR is redirected too: an unconfirmed submit saves the page, and
    two of these tests submit something that is refused on purpose - so a
    plain `pytest` run was dropping unconfirmed-*.txt files into the real
    output/capgemini/ beside the genuine capture from a live run.
    """
    monkeypatch.setattr(cg, "POST_SUBMIT_SETTLE_S", 0.2)
    monkeypatch.setattr(cg, "CONFIRM_TIMEOUT_S", 2.0)
    monkeypatch.setattr(cg, "DELETE_SETTLE_S", 0.2)
    monkeypatch.setattr(cg, "MODAL_SETTLE_S", 0.2)
    monkeypatch.setattr(cg, "UPLOAD_SETTLE_S", 0.2)
    monkeypatch.setattr(cg, "SNAPSHOT_DIR", tmp_path / "snapshots")


# -------------------------------------------------------------------------
# Pure logic
# -------------------------------------------------------------------------

class TestXPathLiteral:
    """The bug the headless validation pass caught: French text has
    apostrophes, and XPath 1.0 cannot escape a quote inside a literal."""

    def test_plain_text_uses_single_quotes(self):
        assert loc.xpath_literal("accepter") == "'accepter'"

    def test_apostrophe_switches_to_double_quotes(self):
        assert loc.xpath_literal("j'accepte") == '"j\'accepte"'

    def test_both_quote_kinds_fall_back_to_concat(self):
        got = loc.xpath_literal("it's a \"test\"")
        assert got.startswith("concat(")
        assert '"\'"' in got

    def test_ci_equals_matches_the_whole_label(self, load, driver):
        """Why ci_equals exists: "ok" as a contains() needle matches
        "Accepter tous les cookies" - c-OK-ies."""
        from selenium.webdriver.common.by import By

        load('<button id="a">Accepter tous les cookies</button>'
             '<button id="b">OK</button>')
        loose = "//button[%s]" % loc.ci_contains("normalize-space(.)", "ok")
        exact = "//button[%s]" % loc.ci_equals("normalize-space(.)", "ok")

        assert {e.get_attribute("id")
                for e in driver.find_elements(By.XPATH, loose)} == {"a", "b"}
        assert [e.get_attribute("id")
                for e in driver.find_elements(By.XPATH, exact)] == ["b"]

    def test_every_locator_is_parseable(self, driver):
        """A malformed XPath fails only when Selenium runs it, which on a live
        run means part way through an application."""
        driver.get("about:blank")
        check = ("try { document.evaluate(arguments[0], document, null, "
                 "XPathResult.ANY_TYPE, null); return 'ok'; } "
                 "catch (e) { return e.message; }")
        names = [n for n in dir(loc)
                 if n.startswith("CAP_") and isinstance(getattr(loc, n), str)
                 and getattr(loc, n).startswith(("//", "(//"))]
        assert names, "no Capgemini locators found to check"
        for name in names:
            assert driver.execute_script(check, getattr(loc, name)) == "ok", name


class TestNationalNumber:
    """SuccessFactors takes the country code separately, so the trunk 0 has to
    come off or the number goes out as +33 07..."""

    def test_drops_the_trunk_zero(self):
        assert cg.national_number("07 53 37 78 23") == "753377823"

    def test_leaves_a_number_without_one_alone(self):
        assert cg.national_number("753377823") == "753377823"

    def test_strips_punctuation(self):
        assert cg.national_number("07.53.37.78-23") == "753377823"

    def test_international_format_is_not_handled(self):
        """Documenting a real limit rather than pretending it away.

        CandidateData holds the national format, which is what this is for. A
        number written +33... keeps its country code, and would go out beside
        the form's own +33 selector - so if that profile field ever changes
        format, national_number has to change with it.
        """
        assert cg.national_number("+33 7 53 37 78 23") == "33753377823"

    def test_empty_is_empty(self):
        assert cg.national_number("") == ""


class TestUnsetFields:
    def test_selectionner_counts_as_empty(self, form):
        rb = {"genre": loc.CAP_UNSET, "handicap": "Non"}
        assert form.unset_fields(rb) == ["genre"]

    def test_missing_documents_are_reported(self, form):
        assert "documents" in form.unset_fields({"documents": []})

    def test_a_full_readback_reports_nothing(self, form):
        assert form.unset_fields({"documents": ["cv.pdf"], "genre": "Masculin"}) == []


class TestLoadRoles:
    def test_resolves_documents_and_drops_missing_ones(self, tmp_path, capsys):
        from apply_capgemini import load_roles

        docs = tmp_path / "docs"
        docs.mkdir()
        (docs / "cv-cloud.pdf").write_bytes(b"%PDF-1.4")

        shortlist = tmp_path / "shortlist.json"
        shortlist.write_text(json.dumps({"roles": [{
            "tracker": 1, "url": "https://x/1", "title": "Lead Cloud",
            "family": "cloud", "cv": "cv-cloud.pdf",
            "letter": "letter-that-is-not-there.pdf",
        }]}), encoding="utf-8")

        roles = load_roles(shortlist, docs)
        assert len(roles) == 1
        assert roles[0].cv == docs / "cv-cloud.pdf"
        # Missing document: dropped, but said out loud rather than swallowed.
        assert roles[0].letter is None
        assert "missing document" in capsys.readouterr().out


# -------------------------------------------------------------------------
# The form, in a browser
# -------------------------------------------------------------------------

class TestComboboxes:

    def test_picks_an_option_and_reads_it_back(self, load, form):
        load(SIGNED_IN_FORM)
        log = []
        assert form.pick_combo(13, "Oui", "autorisation", log) is True
        assert log == ["autorisation"]
        assert form.readback()["autorisation de travail"] == "Oui"

    def test_retries_when_the_popup_ignores_the_first_click(self, load, form):
        """Finding 3: one click is not enough under load."""
        load(STICKY_COMBO)
        log = []
        assert form.pick_combo(37, "Oui", "whatsapp", log) is True
        assert form.readback()["WhatsApp"] == "Oui"

    def test_a_single_click_would_have_failed(self, load, driver):
        """Guard on the fixture: without the retry the list stays shut."""
        load(STICKY_COMBO)
        driver.find_element("xpath", loc.cap_combo(37)).click()
        pop = driver.find_element("id", "pop37")
        assert not pop.is_displayed()

    def test_first_matching_wording_wins(self, load, form):
        """Gender is offered as a list because the wording varies per posting."""
        load(combo(33, ["Homme", "Femme"]))
        log = []
        assert form.pick_combo(
            33, ["Masculin", "Homme", "Male"], "genre", log) is True
        assert form.readback()["genre"] == "Homme"

    def test_unmatched_wording_reports_failure(self, load, form):
        load(combo(33, ["Autre"]))
        assert form.pick_combo(33, ["Masculin", "Homme"], "genre", []) is False

    def test_accents_and_case_do_not_matter(self, load, form):
        load(combo(9, ["ISRAËL", "FRANCE"]))
        assert form.pick_combo(9, "France", "pays", []) is True
        assert form.readback()["pays de residence"] == "FRANCE"

    def test_an_accented_option_matches_an_accented_answer(self, load, form):
        load(combo(13, ["Oui, je suis autorisé à travailler"]))
        assert form.pick_combo(
            13, "OUI, JE SUIS AUTORISÉ À TRAVAILLER", "auth", []) is True

    def test_a_gated_field_is_left_alone_until_its_consent(self, load, form):
        """Finding 2: the detail field is disabled until consent is given."""
        load(GATED_DISABILITY)
        assert form.pick_combo(25, "Non", "handicap", []) is False

        assert form.pick_combo(21, "Oui", "consentement", []) is True
        assert form.pick_combo(25, "Non", "handicap", []) is True
        rb = form.readback()
        assert rb["consentement handicap"] == "Oui"
        assert rb["handicap"] == "Non"


class TestReadback:
    def test_reports_untouched_fields_as_empty(self, load, form):
        load(SIGNED_IN_FORM)
        empty = form.unset_fields(form.readback())
        assert "pays de residence" in empty
        assert "autorisation de travail" in empty

    def test_phone_is_read_from_either_form(self, load, form):
        load('<input id="fbclc_phoneNumber" value="753377823">')
        assert form.readback()["telephone"] == "753377823"


class TestDocumentControls:
    """The document controls are not buttons.

    Every _any_text("button", ...) locator matched nothing on the live form,
    so a run reported "no CV control found" and quietly left the PREVIOUS
    application's CV attached. Caught on 2026-08-22 by a dry run whose
    readback still named the last role's documents.
    """

    def _matches(self, driver, xpath):
        from selenium.webdriver.common.by import By
        return driver.find_elements(By.XPATH, xpath)

    def test_the_cv_control_is_a_span_not_a_button(self, load, driver):
        load(DOCUMENTS)
        found = self._matches(driver, loc.CAP_CV_CONTROL)
        assert [e.get_attribute("id") for e in found] == ["67:_attachIcon"]
        assert found[0].tag_name == "span"

    def test_the_old_button_locator_would_have_found_nothing(self, load, driver):
        """The regression itself, stated outright."""
        load(DOCUMENTS)
        old = loc._any_text("button", ("modifier le document", "charger un cv"))
        assert self._matches(driver, old) == []

    def test_delete_and_attach_are_different_icons_in_one_slot(self, load, driver):
        """The letter offers only Supprimer once it holds a document, so the
        attach locator must not match the trash icon and fire a delete."""
        load(DOCUMENTS)
        assert [e.get_attribute("id")
                for e in self._matches(driver, loc.CAP_LETTER_DELETE)] \
            == ["69:_attachIcon"]
        assert self._matches(driver, loc.CAP_LETTER_CONTROL) == []

    def test_the_slots_are_told_apart_by_their_qa_class(self, load, driver):
        """Not by position: the NN: ids shift when a question is added."""
        load(DOCUMENTS)
        cv = self._matches(driver, loc.CAP_CV_CONTROL)[0]
        letter = self._matches(driver, loc.CAP_LETTER_DELETE)[0]
        assert cv.get_attribute("id") != letter.get_attribute("id")

    def test_the_control_is_found_although_its_anchor_is_hidden(self, load, form):
        """The qaResume div carries displayNone. Anchoring on it is only safe
        because it is a predicate, never something we wait to see."""
        load(DOCUMENTS)
        assert form.ux.visible(loc.CAP_CV_CONTROL)


class TestDialogConfirm:
    """The confirm dialog, and the cookie manager that used to shadow it."""

    def test_only_the_active_dialog_matches(self, load, driver):
        from selenium.webdriver.common.by import By

        load(letter_delete_page())
        driver.find_element(By.ID, "69:_attachIcon").click()
        found = driver.find_elements(By.XPATH, loc.CAP_DIALOG_CONFIRM)
        assert [e.text for e in found] == ["OK"]

    def test_the_hidden_cookie_dialog_no_longer_wins(self, load, driver):
        """The old locator matched the cookie button FIRST, and UX.click waits
        for the first match to become clickable - so the click timed out, the
        deletion was never confirmed, and nothing was raised."""
        from selenium.webdriver.common.by import By

        load(letter_delete_page())
        driver.find_element(By.ID, "69:_attachIcon").click()
        old = ("//*[@role='dialog']//button["
               + " or ".join(loc.ci_contains("normalize-space(.)", n)
                             for n in ("accepter", "oui", "ok"))
               + "]")
        assert "cookie-ok" in {e.get_attribute("id")
                               for e in driver.find_elements(By.XPATH, old)}
        assert "cookie-ok" not in {
            e.get_attribute("id")
            for e in driver.find_elements(By.XPATH, loc.CAP_DIALOG_CONFIRM)}


class TestClearLetter:
    """The cover-letter slot arrives holding the LAST application's letter."""

    def test_the_stale_letter_is_removed(self, load, form, driver):
        from selenium.webdriver.common.by import By

        load(letter_delete_page())
        assert form.clear_letter() is True
        assert driver.find_elements(By.ID, "69:_attachWrapper") == []

    def test_an_empty_slot_reports_nothing_to_clear(self, load, form):
        load(HIDE_CSS + attach_slot(67, "qaResume", "addAttachments", "cv.pdf"))
        assert form.clear_letter() is False

    def test_a_role_with_no_letter_still_clears_the_slot(self, load, form,
                                                         monkeypatch):
        """Where the bug bit: replace_letter was only called when the role HAD
        a letter, so a role without one inherited the previous role's."""
        from app.config import CandidateData

        load(letter_delete_page())
        monkeypatch.setattr(form, "open_apply_form", lambda url: "authenticated")
        role = cg.Role(url="x", title="t", cv=None, letter=None)

        out = cg.apply_one(form, role, CandidateData(), {},
                           files_required=False, dry_run=True)
        assert any("lettre supprimee" in str(f) for f in out.filled)
        assert "no tailored letter" in out.note


class TestAlreadyApplied:
    """Capgemini refuses a second application, and says so only after login."""

    REFUSAL = ('<h1>Vous avez déjà postulé pour ce poste.</h1>'
               '<button id="fbja_back">Revenir à la liste</button>')

    def test_the_refusal_page_is_recognised(self, load, form):
        load(self.REFUSAL)
        assert form.ux.visible(loc.CAP_ALREADY_APPLIED)

    def test_a_normal_form_is_not_mistaken_for_it(self, load, form):
        """The marker includes the back button, which is the risky half."""
        load(SIGNED_IN_FORM)
        assert not form.ux.visible(loc.CAP_ALREADY_APPLIED)

    def test_it_counts_as_submitted_and_touches_nothing(self, form, monkeypatch):
        """record.SUBMITTED is "confirmed in the wizard, or already applied".
        Recording it as failed would send the posting round again every run."""
        monkeypatch.setattr(form, "open_apply_form",
                            lambda url: "already_applied")
        monkeypatch.setattr(form, "submit", lambda out: pytest.fail(
            "submit must not be reached for an already-applied posting"))

        out = cg.apply_one(form, cg.Role(url="x", title="t"), None, {})
        assert out.submitted is True
        assert "already applied" in out.note
        assert out.filled == []


class TestLetters:
    """The payload handed to career-ops' renderer. No browser, no node."""

    def test_every_per_role_letter_names_its_own_requisition(self):
        """The reference number is printed in the letter body, which is why a
        per-role letter may never be reused on another posting."""
        from app import letters

        content = letters.load_content()
        assert content, "no letter content found"
        per_role = {k: v for k, v in content.items() if k.isdigit()}
        assert per_role
        for req_id, entry in per_role.items():
            assert req_id in entry["role_title"], req_id

    def test_family_letters_name_no_requisition_at_all(self):
        """The opposite guarantee, and the one that makes them reusable: a
        family letter goes to every posting in its family, so a reference
        number in it would be wrong on all but one of them."""
        import re

        from app import letters

        families = {k: v for k, v in letters.load_content().items()
                    if k.startswith("family:")}
        assert families, "no family letters found"
        for key, entry in families.items():
            blob = " ".join(str(v) for v in entry.values())
            assert not re.search(r"\b\d{7,}\b", blob), key
            assert "réf" not in blob.casefold(), key

    def test_the_payload_carries_the_account_the_forms_use(self):
        """career-ops' own copy of this block says machaka.mohammad@gmail.com,
        which would put a different address on the letter than the one
        Capgemini has on file for the account applying."""
        from app import letters

        content = letters.load_content()
        req_id = next(iter(content))
        payload = letters.payload_for(req_id, content)
        assert payload["candidate"]["email"] == "moudimash99@gmail.com"
        assert payload["letter"]["role_title"].endswith(f"{req_id})")
        assert payload["output_path"].endswith(
            f"lettre-motivation-capgemini-{content[req_id]['slug']}.pdf")

    def test_a_posting_with_no_letter_is_an_error_not_a_default(self, tmp_path):
        """Falling back to some other role's letter is the failure mode this
        whole keying scheme exists to prevent."""
        from app import letters

        with pytest.raises(letters.LetterError, match="no letter written"):
            letters.build("0000000000", tmp_path, content={})

    def test_a_missing_renderer_is_reported(self, tmp_path):
        from app import letters

        content = {"1": {"slug": "x", "role_title": "X (réf. 1)",
                         "opening": "o", "profile_intro": "p"}}
        with pytest.raises(letters.LetterError, match="renderer not found"):
            letters.build("1", tmp_path, content=content,
                          career_ops=tmp_path / "nowhere")


class TestSubmit:
    """AGENTS.md: clicking Submit is not evidence of submitting."""

    def test_confirmed_submit_reports_success(self, load, form):
        load(submit_page(confirms=True))
        out = Outcome()
        assert form.submit(out) is True
        assert any("Envoyer ma candidature" in str(f) for f in out.filled)

    def test_refused_submit_is_not_reported_as_success(self, load, form):
        """The button clicks, nothing happens, and the run must notice."""
        load(submit_page(confirms=False))
        out = Outcome()
        assert form.submit(out) is False
        assert "no confirmation appeared" in out.note

    def test_refusal_names_the_rejected_field(self, load, form):
        load(submit_page(confirms=False, invalid=True))
        out = Outcome()
        assert form.submit(out) is False
        assert "Téléphone" in out.note

    def test_missing_submit_control_is_reported(self, load, form):
        load("<p>nothing to click</p>")
        out = Outcome()
        assert form.submit(out) is False
        assert "no submit control found" in out.note

    def test_prefers_the_specific_wording_over_postuler(self, load, form):
        """Both are on the page; "Postuler" is the posting's own call to
        action and must not be the one clicked."""
        load('<button>Postuler</button>'
             '<button>Envoyer ma candidature</button>')
        text, _ = form._find_submit()
        assert text == "Envoyer ma candidature"
