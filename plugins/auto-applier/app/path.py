# Locators below carrying a data-automation-id were read off the live board on
# 2026-08-19. Prefer automation ids: they survive re-layout and are the same in
# every UI language, unlike positional or text matches.
#
# The two previous sign-in locators were both wrong, verified live:
#   "(//button)[2]"                     -> matched "Accept Cookies"
#   "(//div[@aria-label='Sign In'])[1]" -> matched nothing at all
signin_xpath = "//button[@data-automation-id='utilityButtonSignIn']"
signin2_xpath = "//button[@data-automation-id='signInLink']"

# The posting's call to action. Same automation id whether it reads "Apply" or
# "Continue Application", so click by this and tell the two apart by their text.
apply_button_path = (
    "//a[@data-automation-id='adventureButton']"
    " | //a[normalize-space()='Apply']"
)

# The posting is a SPA: driver.get() returns long before the call to action
# exists. Wait for one of these before reading the posting's state, or an
# empty page gets classified "unknown" and the run stops for a human.
posting_ready = ("//a[@data-automation-id='adventureButton']"
                 " | //*[@data-automation-id='jobPostingHeader']"
                 " | //a[normalize-space()='Apply']")

# Cookie consent sits above the page and swallows clicks until dismissed.
cookie_accept = "//button[@data-automation-id='legalNoticeAcceptButton']"

# "Start Your Application" offers three routes before the wizard proper.
apply_manually = "//a[@data-automation-id='applyManually']"
autofill_with_resume = "//a[@data-automation-id='autofillWithResume']"

# Sign-in / create-account wall; the wizard is unreachable until past it.
create_account_form = (
    "//button[@data-automation-id='createAccountSubmitButton']"
    " | //div[@data-automation-id='createAccountPage']"
)

# Honeypot. Workday renders a hidden text input labelled "for robots only" to
# catch bots that fill in every field. Never write to it.
honeypot_field = "//input[@data-automation-id='beecatcher']"
HONEYPOT_NAMES = ("beecatcher",)


use_last_button_path = "(//a[normalize-space()='Use My Last Application'])[1]"
continue_button_path = "(//a[normalize-space()='Continue Application'])[1]"
# "How did you hear about us?" - the dropdown button, then one of its options.
# The button carries a stable id; the text match is kept as a fallback only.
# Airbus renders this as a button dropdown; Accenture as a multiselect whose
# control is an <input>. One locator so the flow does not need to know which.
how_hear_any = ("//button[@id='source--source']"
                " | //input[@id='source--source']"
                " | //*[@data-automation-id='formField-source']//button"
                " | //*[@data-automation-id='formField-source']//input")

# The Voluntary Disclosures page differs per tenant: Airbus asks for
# nationality and date of birth, Accenture only for gender, pronoun and the
# terms checkbox. Waiting on the Airbus-only field timed the page out.
disclosures_ready = ("//input[@id='personalInfoPerson--additionalNationalities']"
                     " | //*[@data-automation-id='formField-gender']"
                     " | //button[@id='personalInfoPerson--gender']"
                     " | //input[@id='termsAndConditions--acceptTermsAndAgreements']")

terms_checkbox = "//input[@id='termsAndConditions--acceptTermsAndAgreements']"

how_hear_path = ("//button[@id='source--source']"
                 " | (//button[normalize-space()='Select One'])[1]")

# The options are <li role="option">, NOT divs. The old locator
#   "(//div[normalize-space()='Airbus Careers Website'])[1]"
# matched nothing, so the run waited out the timeout and died here with a bare
# TimeoutException. Read off the live dropdown on 2026-08-19, which offers:
# Airbus Careers Website, Airbus Employee Referral, Debut, Facebook, Glassdoor,
# Google, Instagram, Job Board, Job Fair / Careers Event, LinkedIn, Other,
# Temp Agency, Twitter, University Or School Careers Site, YouTube.
career_website_button_path = (
    "//li[@role='option'][normalize-space()='Airbus Careers Website']")
worked_no = "(//input[@id='zphz5'])[1]"
worked_yes = "(//input[@id='zphz4'])[1]"
worker_code_id = "(//input[@id='previousWorker--employeeID'])[1]"
delete_file = "//button[@data-automation-id='delete-file']"
# Workday's footer button. The automation id is the same on every wizard step
# and in every UI language, unlike the English label.
save_cont_path = ("//button[@data-automation-id='pageFooterNextButton']"
                  " | (//button[normalize-space()='Save and Continue'])[1]")
submit = "(//button[normalize-space()='Submit'])[1]"
semester_level_path = "(//textarea[@id='input-274'])[1]"
uni_name_path = "(//textarea[@id='input-276'])[1]"
course_path = "(//textarea[@id='input-278'])[1]"
finish_studies = "(//textarea[@id='input-280'])[1]"

kind_internship = "(//button[@id='primaryQuestionnaire--ac8482cbac9710014b9fd5af795f0000'])[1]"
kind_internship_answer = "(//div[contains(text(),'I am looking for an internship in the frame of my ')])[1]"
compulsary_internship = "(//button[@id='primaryQuestionnaire--d88b76473de410014b353bd4d28a0004'])[1]"
compulsary_internship_answer = "(//div[contains(text(),'yes, my internship is mandatory to validate my yea')])[1]"
single_period_internship = "(//button[@id='primaryQuestionnaire--d88b76473de410014b353c6e9e690000'])[1]"
single_period_internship_answer = "(//div[normalize-space()='My internship takes place over a single period'])[1]"
duration_internship = "(//textarea[@id='primaryQuestionnaire--d88b76473de410014b353c6e9e690003'])[1]"
level_study = "(//textarea[@id='primaryQuestionnaire--d88b76473de410014b353c6e9e690004'])[1]"



eng_rate="(//button[@id='input-292'])[1]"
fluent = "(//div[normalize-space()='Negotiation / Fluent'])[1]"

fen_rate="(//button[@id='input-294'])[1]"
intm = "(//div[normalize-space()='Intermediate'])[1]"

# Scoped, not positional. The old "(//button[normalize-space()='Select One'])[1]"
# grabbed the FIRST such button anywhere on the page, which on this wizard is
# "How Did You Hear About Us?" - the same trap that made the original sign-in
# locator click Accept Cookies. If none of these match, final_page skips gender
# and says so, which is far better than answering the wrong question.
gend = ("//*[@data-automation-id='formField-gender']//button"
        " | //button[@id='personalInfoPerson--gender']"
        " | //*[@data-automation-id='formField-personalInfoPerson--gender']//button")
male = "(//div[normalize-space()='Male'])[1]"
bd = "(//div[@id='personalInfoPerson--dateOfBirth-dateSectionMonth-display'])[1]"
nation = "(//button[@id='personalInfoPerson--nationality'])[1]"
liban = "(//div[contains(text(),'Lebanon')])[1]"
add_nat = "(//input[@id='personalInfoPerson--additionalNationalities'])[1]"
accept = '(//label[@for="termsAndConditions--acceptTermsAndAgreements"])[1]'


# --- posting state -------------------------------------------------------
# Workday swaps the call-to-action depending on whether a draft already exists,
# so these are probed (not waited on) to work out which state we are in.
continue_application_path = "(//a[normalize-space()='Continue Application'])[1]"

# Markers that an application already went in for this posting.
submitted_markers = (
    "//*[normalize-space()='View Application']"
    " | //*[normalize-space()='Application Submitted']"
    " | //*[normalize-space()='Withdraw Application']"
)

# --- attachments ---------------------------------------------------------
attachments_group = (
    "//div[@role='group'][@aria-labelledby='Application-attachments-section']"
)
# Candidate locations for an uploaded file's name; Workday's markup varies, so
# app/pages.py tries each in turn.
# Workday renders dropdown options differently per tenant: Airbus uses
# <li role="option">, Accenture uses divs carrying promptOption /
# promptLeafNode. Matching only the first found nothing on Accenture and the
# run reported "0 options offered" on a menu that was plainly open.
dropdown_options_any = ("//li[@role='option']"
                        " | //*[@data-automation-id='promptOption']"
                        " | //*[@data-automation-id='promptLeafNode']")

# Accenture's My Experience has three upload areas: one per certification and
# one for the CV, and the certification inputs come first in the DOM. An
# unscoped "first file input" put the CV on a certification row and left the
# required Resume upload empty, which Workday reported only as "The field
# Upload a file (5MB max) is required" (2026-08-21).
RESUME_SECTION_CSS = ('[data-automation-id="resumeAttachments--attachments"],'
                      ' [id="resumeAttachments--attachments"]')
resume_upload_input = ("//button[@id='resumeAttachments--attachments']"
                       "/ancestor::*[.//input[@type='file']][1]"
                       "//input[@type='file']")

attachment_name_candidates = (
    "//div[@data-automation-id='file-preview-name']",
    "//div[@data-automation-id='filePreview']//div[@data-automation-id='promptOption']",
    "//*[@data-automation-id='attachments-FileUpload']//*[@role='listitem']",
    # Accenture's tenant, read live 2026-08-21. Without this the run counted a
    # delete button but could not name the file, so it was about to replace an
    # attachment it could not identify.
    "//*[@data-automation-id='file-upload-item-name']",
)

# --- sign-in form (verified live 2026-08-19) -----------------------------
login_email = "//input[@data-automation-id='email']"
login_password = "//input[@data-automation-id='password']"
login_submit = "//button[@data-automation-id='signInSubmitButton']"

# Some tenants (Accenture) front the login with social sign-in and hide the
# email form behind this button; Airbus shows the form straight away. Clicking
# it when it is not there is harmless, so the flow always tries.
sign_in_with_email = ("//button[@data-automation-id='SignInWithEmailButton']"
                      " | //button[normalize-space()='Sign in with email']")

# --- My Information: identity (read off the live form 2026-08-19) ---------
# These cannot be left to prefill. "Use My Last Application" fills nothing when
# the account has no previous application - Workday says so in a page alert -
# and Save and Continue then fails validation without navigating anywhere, so
# the run carries on believing it reached the next step.
first_name = "//input[@name='legalName--firstName']"
last_name = "//input[@name='legalName--lastName']"
phone_number = "//input[@name='phoneNumber']"
address_line1 = "//input[@name='addressLine1']"
city_field = "//input[@name='city']"
postal_code = "//input[@name='postalCode']"

# Set on any field the page rejected, and the matching message elements.
invalid_field = "//input[@aria-invalid='true'] | //textarea[@aria-invalid='true']"
validation_message = "//*[starts-with(@id,'error1-')]"

# --- My Experience: education (read off the live form 2026-08-19) ---------
# The section is collapsed until its "Add" button is clicked, and the entry
# index in the automation id is generated per session (education-43--school),
# so these match on the suffix rather than the whole id.
# Scoped through the wrapper, which is what actually carries the automation
# id. The controls themselves are identified only by a generated id
# (education-26--school), so matching them on data-automation-id finds nothing
# - the same trap as accountSettingsButton in app/session.py.
education_school = "//*[@data-automation-id='formField-school']//input"
education_degree = "//*[@data-automation-id='formField-degree']//button"
education_field_of_study = ("//*[@data-automation-id='formField-fieldOfStudy']"
                            "//input")


def dropdown_option(label: str) -> str:
    """A Workday prompt option by its exact visible text."""
    return f"//li[@role='option'][normalize-space()=\"{label}\"]"

# --- My Experience: languages --------------------------------------------
# Same wrapper trick as education. The proficiency dropdowns beside it carry
# hashed ids (language-30--f5811cef...) and are not touched.
language_choice = "//*[@data-automation-id='formField-language']//button"

# A multiselect's chosen values live in these nodes, NOT in the input's value
# attribute - the search box always reads "". Reading value alone reports a
# populated School field as empty, which is exactly the wrong conclusion.
education_school_selected = ("//*[@data-automation-id='formField-school']"
                             "//*[@data-automation-id='selectedItem']")


# =========================================================================
# Capgemini - SAP SuccessFactors (careers.capgemini.com)
# =========================================================================
# Not Workday. There are no data-automation-ids here, so these match on
# element id where SuccessFactors provides a stable one (fbclc_*, tor__*) and
# on visible French text where it does not.
#
# Ported from career-ops/scripts/apply-capgemini.mjs, whose selectors were
# verified against the live form on 2026-08-20. Keep that file as the
# reference when one of these breaks - its comments record which failures are
# real (see app/capgemini.py's header).
#
# The colon in "9:_input" is legal in an id but not in a CSS selector, which
# is why every combobox below is XPath.

_XP_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ"
_XP_LOWER = "abcdefghijklmnopqrstuvwxyzàâäéèêëîïôöùûüç"


def xpath_literal(text: str) -> str:
    """`text` as an XPath 1.0 string literal, apostrophes and all.

    XPath 1.0 has no escape sequence inside a string literal, so "j'accepte"
    written between single quotes ends the literal at the apostrophe and the
    whole expression fails to parse - which is exactly what happened to
    CAP_COOKIE_ACCEPT, CAP_DIALOG_CONFIRM and CAP_SUBMITTED_MARKERS, all three
    of which carry French text with an apostrophe in it. Switching quote
    character covers every needle here; concat() is the general fallback.
    """
    if "'" not in text:
        return f"'{text}'"
    if '"' not in text:
        return f'"{text}"'
    parts = "', \"'\", '".join(text.split("'"))
    return f"concat('{parts}')"


def ci_contains(node: str, needle: str) -> str:
    """Case-insensitive contains() for XPath 1.0, which has no lower-case().

    `needle` must already be lower case, accents included - it is compared
    against `node` folded through translate().
    """
    return (f"contains(translate({node}, '{_XP_UPPER}', '{_XP_LOWER}'), "
            f"{xpath_literal(needle)})")


def ci_equals(node: str, needle: str) -> str:
    """Case-insensitive equality, for needles too short to use contains() on.

    "ok" as a contains() needle matches "Accepter tous les cookies" - c-ok-ies
    - which is how a hidden cookie button came to shadow a confirmation
    dialog's real OK. Short words have to match the whole label.
    """
    return (f"translate({node}, '{_XP_UPPER}', '{_XP_LOWER}') = "
            f"{xpath_literal(needle)}")


def _any_text(tag: str, needles: tuple[str, ...], node: str = "normalize-space(.)") -> str:
    return " | ".join(f"//{tag}[{ci_contains(node, n)}]" for n in needles)


# Cookie banner. The real button reads "Accepter tous les cookies"; the other
# wordings are fallbacks. It does not block the job pages but does block the
# candidate portal, so it has to go before anything else is clicked.
CAP_COOKIE_ACCEPT = _any_text("button", (
    "accepter tous les cookies", "accept all cookies", "tout accepter",
    "j'accepte", "accepter",
))

# The posting's call to action, then the menu it opens. Capgemini's fixed
# navbar overlaps this control at some window sizes and intercepts the click -
# UX.click already falls back to a JS click, which is what gets past it.
CAP_POSTULER = ("//button[normalize-space()='Postuler']"
                " | //a[normalize-space()='Postuler']")
CAP_POSTULER_NOW = ("//*[@role='menuitem']"
                    f"[{ci_contains('normalize-space(.)', 'postuler maintenant')}]")

# Which of the two forms loaded. Signed out, SuccessFactors serves a
# register-and-apply form (so only the FIRST application of a batch could ever
# submit); signed in, a short one that draws from the candidate profile.
CAP_ANON_EMAIL = "//input[@id='fbclc_userName']"
CAP_AUTH_PHONE = "//input[@id='tor__fcellPhone']"
CAP_REGISTER_MARKER = "//input[@id='fbclc_pwdConf']"   # only on the anon form

# A posting this account has already applied to. SuccessFactors serves the
# register-and-apply form to a signed-out visitor even then, and only reveals
# it after the login: the page becomes "Vous avez deja postule pour ce poste"
# with a single "Revenir a la liste" button, and the url grows
# isApplicationDenied=true. Read off the live form on 2026-08-22.
# Without this the flow just waits 30s for a form that is never coming and
# reports the posting as closed.
CAP_ALREADY_APPLIED = _any_text("*", (
    "vous avez déjà postulé", "you have already applied",
), node="normalize-space(text())") + " | //button[@id='fbja_back']"

# Sign-in, reachable only from inside an apply page.
CAP_SIGNIN_LINK = f"//a[{ci_contains('normalize-space(.)', 'connectez-vous')}]"
CAP_LOGIN_DIALOG = f"//*[@role='dialog'][{ci_contains('.', 'connexion')}]"
CAP_LOGIN_USER = ("//*[@role='dialog']//input[@type='text']"
                  " | //*[@role='dialog']//input[@type='email']")
CAP_LOGIN_PASS = "//*[@role='dialog']//input[@type='password']"
CAP_LOGIN_SUBMIT = "//*[@role='dialog']//button[normalize-space()='Connexion']"

# Anonymous-form text inputs and its two real <select> elements.
CAP_EMAIL = "//input[@id='fbclc_userName']"
CAP_EMAIL_CONFIRM = "//input[@id='fbclc_emailConf']"
CAP_FIRST_NAME = "//input[@id='fbclc_fName']"
CAP_LAST_NAME = "//input[@id='fbclc_lName']"
CAP_PHONE_ANON = "//input[@id='fbclc_phoneNumber']"
CAP_PASSWORD = "//input[@id='fbclc_pwd']"
CAP_PASSWORD_CONFIRM = "//input[@id='fbclc_pwdConf']"
CAP_ITU_CODE = "//select[@id='fbclc_ituCode']"
CAP_COUNTRY_SELECT = "//select[@id='fbclc_country']"

# Documents. Clicking an upload control opens a source dialog and injects the
# real input[type=file], which we set directly rather than driving the dialog.
# The document controls are NOT buttons. Read off the live signed-in form on
# 2026-08-22: each slot is a div.attachWrapper holding a glyphicon <span> with
# role="button", and the words "Modifier le document" / "Supprimer le
# document" live in a sibling span.hiddenAriaContent, not in the control. So
# every _any_text("button", ...) locator here matched nothing, and a run
# reported "no CV control found" while quietly leaving the previous
# application's CV attached.
#
# Two anchors, both language-neutral and neither positional:
#   .qaResume / .qaCoverLetter   - which slot this is
#   addAttachments / removeAttachments - what the icon does
# The `NN:` id prefixes are positional like the comboboxes, so they are
# matched by suffix (_attachIcon) rather than by number.
def _attach_icon(slot: str, action: str = "") -> str:
    icon = "//span[contains(@id, '_attachIcon')"
    if action:
        icon += f" and contains(@class, '{action}')"
    return (f"//div[contains(@class, 'attachWrapper')]"
            f"[.//*[contains(@class, '{slot}')]]" + icon + "]")


# The CV slot takes whichever icon it is showing: a pencil when a document is
# already attached (replace), a plus when it is empty.
CAP_CV_CONTROL = (_attach_icon("qaResume")
                  + " | " + _any_text("button", ("charger un cv",)))
# The letter offers only delete once it holds a document, so attaching and
# removing are two different icons in the same slot - see app/capgemini.py.
CAP_LETTER_CONTROL = (_attach_icon("qaCoverLetter", "addAttachments")
                      + " | "
                      + _any_text("button", ("joindre une lettre de motivation",)))
CAP_LETTER_DELETE = (_attach_icon("qaCoverLetter", "removeAttachments")
                     + " | " + _any_text("button", ("supprimer le document",)))
CAP_FILE_INPUT = "//input[@type='file']"

# Privacy declaration - a legal consent, opened as a modal.
CAP_PRIVACY_BUTTON = _any_text("button", ("déclaration de confidentialité",))
# The dialog currently on screen. The cookie manager is also role="dialog" and
# stays in the DOM hidden after it is dismissed, so an unqualified
# //*[@role='dialog'] matches it too - and because UX.click waits for the
# FIRST match to become clickable, a hidden cookie button makes the click time
# out and return quietly. Read off the live form on 2026-08-22: SAP marks the
# open one with fd-dialog--active.
CAP_DIALOG_ACTIVE = "//*[@role='dialog'][contains(@class, 'fd-dialog--active')]"

# "Voulez-vous vraiment supprimer ce fichier ?" -> Annuler / OK. `title` and
# `name` carry the same word as the label and survive a translation of it.
CAP_DIALOG_CONFIRM = (
    f"{CAP_DIALOG_ACTIVE}//button[@title='OK' or @name='OK']"
    + "".join(
        f" | {CAP_DIALOG_ACTIVE}//button[{ci_equals('normalize-space(.)', n)}]"
        for n in ("ok", "oui", "confirmer", "supprimer"))
    + "".join(
        f" | {CAP_DIALOG_ACTIVE}//button[{ci_contains('normalize-space(.)', n)}]"
        for n in ("j'accepte", "accepter")))

# The custom comboboxes SAP renders as an <input> plus a popup <li> list. The
# numeric prefix is POSITIONAL - it shifts if Capgemini adds or removes a
# question, so a run that reports a combo "still empty" should be checked
# against the live form before the value is blamed.
CAP_COMBO_COUNTRY = 9
CAP_COMBO_WORK_AUTH = 13
CAP_COMBO_FORMER_EMPLOYEE = 17
CAP_COMBO_DISABILITY_CONSENT = 21
CAP_COMBO_DISABILITY = 25
CAP_COMBO_GENDER_CONSENT = 29
CAP_COMBO_GENDER = 33
CAP_COMBO_WHATSAPP = 37

# What an unset combobox reads as, and so what "I filled it" must not equal.
CAP_UNSET = "- Sélectionner -"


def cap_combo(index: int) -> str:
    """One of the SuccessFactors comboboxes, by its positional id."""
    return f"//*[@id='{index}:_input']"


CAP_POPUP_OPTION = "//li"   # filtered to the visible ones in Python

# --- Submitting -----------------------------------------------------------
# The career-ops script never clicked these, by policy, so unlike everything
# above they are NOT yet confirmed against the live form. Verify with
# tools/apply_capgemini.py --inspect before trusting a real run.
# Ordered by preference, most specific first. "postuler" is LAST because it is
# also the posting page's own call to action - matching it first would risk
# clicking the wrong control entirely. app/capgemini.py walks these in order
# and takes the first visible, enabled hit.
CAP_SUBMIT_NEEDLES = (
    "envoyer ma candidature", "soumettre ma candidature", "envoyer",
    "soumettre", "postuler",
)

# The union, for --inspect and diagnostics. The flow itself uses the tuple
# above so that it can tell the candidates apart.
CAP_SUBMIT = _any_text("button", CAP_SUBMIT_NEEDLES)

# Clicking Submit is not evidence of submitting (AGENTS.md). Confirm against
# these before recording a success.
# The first entry is the wording the live form actually uses, read off a
# confirmed submission on 2026-08-22 ("Votre candidature a ete envoyee. Merci
# !"). The rest are guesses carried over from career-ops and kept as
# fallbacks - none of them matched, so the first two real submissions were
# recorded as drafts even though they had gone through.
CAP_SUBMITTED_MARKERS = _any_text("*", (
    "votre candidature a été envoyée",
    "merci d'avoir postulé", "votre candidature a bien été",
    "candidature envoyée", "candidature soumise",
    "nous avons bien reçu votre candidature",
    "thank you for applying", "application received",
), node="normalize-space(text())")

# A field the form rejected, and the message next to it.
CAP_INVALID = ("//*[@aria-invalid='true']"
               " | //*[contains(@class,'error') and normalize-space(text())]")
