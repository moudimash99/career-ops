# Free Motion — cross-ATS field notes

Running log from live dry-runs (fill the whole form, screenshot the final
review screen, **never submit**). One section per ATS family. The point is
Requirement 1: one generic loop, no vendor-specific code — so every entry here
is either a *generic* rule that belongs in `modes/apply-freemotion.md` /
`lib/freemotion-*.mjs`, or a vendor quirk that the generic rules already
absorb. Anything that can only be fixed with an `if (vendor === ...)` is a
design failure and is called out as such.

Run: `fm-2026-09-06-live` (session of 2026-09-06).

---

## Generic rules learned (these belong in the mode, not in a vendor table)

### G1. Never set a form control through `browser_evaluate`

Setting `.checked`/`.value` from injected JS — even calling `el.click()` —
does not reliably run the page framework's own change handling. React,
Angular and the schema-driven form builders several ATS vendors use track
state in their own store, and only a *trusted* browser event updates it.

Observed on Thales/Radancy (2026-09-06): `document.getElementById('fitScoreYes').click()`
visibly ticked the box, but its mutually-exclusive sibling `fitScoreNo` kept
`required = true`, so the step-1 gate refused to advance with
`"is a required property"` naming a field that looked answered. Two real
`browser_click` calls on the same element (untick, re-tick) fixed it
immediately: the sibling flipped to `required = false, disabled = true`.

**Rule:** `browser_evaluate` is for READING the page (field inventory, error
text, validation state). Every write goes through `browser_fill_form`,
`browser_click`, `browser_type` or `browser_select_option`.

### G2. A mutually-exclusive checkbox pair is not a radio group

Consent widgets are often two independent checkboxes wired together in JS
(accept / refuse), each carrying `required`. Ticking one must *disable* the
other. If both read `checked: true`, the page is in a state its own
validator will reject — untick and redo with real clicks (G1).

**Post-condition to assert after answering such a pair:** exactly one checked,
the other `disabled: true` and `required: false`.

### G3. Read validation errors from the DOM, not from the page text

`document.body.innerText` flattened the Thales error to
`"Veuillez saisir tous les champs obligatoires : is a required property"` —
true but useless, because it does not say *which* property. Walking
`[class*="error"]` elements and resolving each one's nearest
`input/select/textarea` ancestor named the field (`fitScoreNo`) directly.
This is already the shape `lib/freemotion-validate.mjs` uses; the field-naming
walk is worth keeping there.

### G4. Cascading selects invalidate snapshot refs

Choosing a value in one select re-renders the dependent block and every
`[ref=...]` below it goes stale mid-`browser_fill_form`. Two consequences:

- Fill cascade parents **one at a time**, re-reading after each.
- Prefer **stable CSS selectors over refs** for everything else:
  `[id="cntryFields.firstName"]` survives a re-render, `f9e161` does not.

### G5. A CV upload that "auto-fills" is a two-capture problem

Where the page says fields will be overwritten from the CV, upload *before*
filling anything you care about, then re-read every field. On Thales the
upload changed nothing, but the check is cheap and the failure is silent.

### G6. A file input is usually 1×1px and unclickable — click its trigger

Modern ATS forms hide the real `<input type=file>` (a 1×1 pixel box) behind a
styled dropzone. Clicking the input itself fails with a pointer-interception
error naming the dropzone; clicking the *dropzone* often does nothing either,
because the click handler lives on a button inside it.

**Reliable order:** measure `getBoundingClientRect()` on the file input. If it
is ~1×1 (or `display:none`), walk up to its container and click the first
`button`, `label` or `[role=button]` inside — that is what opens the chooser.
Only then does `browser_file_upload` have modal state to attach to. Observed on
Ashby: `input#_systemfield_resume` is 1×1, the dropzone div intercepts, and the
container's "Upload File" `<button>` is the working trigger.

### G7. Answer text-vs-textarea with the accessibility role, not the DOM tag

`lib/freemotion-answers.mjs` treats free text as `['textbox','searchbox']`
because the Playwright accessibility tree reports BOTH `<input type=text>` and
`<textarea>` as `textbox`. Anyone enumerating the form with a
`browser_evaluate` DOM sweep instead passes `textarea`, which silently missed
every hand-written essay in `config/apply-essays.yml` — the question fell
through to `needs-model-judgment` and got improvised while a written answer sat
unused. Fixed by accepting `textarea` as a free-text role too (2026-09-06);
the underlying lesson is that the two vocabularies coexist and code taking a
`role` must tolerate both.

### G8. Strip icon markup before reading a label — and mind the tag CASE

Reading a container's `innerText` to derive a label picks up decoration. On a
real form an inline `<svg>` fallback string became the label of a CV upload
and of a notice-period field: both came back as *"SVGs not supported by this
browser."*, which is then what reaches the answer resolver as the question.

Filtering `<svg>`, `<img>`, `<button>` and nested controls out of the text walk
fixes it — **but the filter must upper-case `tagName` before comparing.**
`tagName` is upper-cased for HTML elements only; an inline `<svg>` and its
children are in the SVG namespace, where the author's case is preserved and
`tagName` is the lower-case `"svg"`. A `{ SVG: 1 }` lookup therefore never
matches the one element the filter exists to remove, and the bug survives the
fix that was supposed to kill it. With the case fixed, the same two fields read
*"Resume Choose file"* and *"Notice period / availability"*.

### G9. Two questions that mean "do not automate this application"

Some forms carry an explicit integrity gate. Seen on one posting, both
required:

- *"Can you confirm that everything in this application is true and your own,
  including your experience and identity?"*
- *"Did you start your first written answer below with the exact phrase we
  asked for in the job description?"* — a phrase planted in the JD body,
  present precisely to detect applications generated without reading it.

Neither is a field to guess. The first is an attestation of authorship; the
second is a deliberate automation tripwire. **The rule is not "answer them
carefully", it is: a posting carrying either one is handed to the user rather
than filled.** Free Motion exists to remove typing, not to sign a statement on
the candidate's behalf or to defeat a check the employer put there on purpose —
and AGENTS.md's "quality, not quantity" line is the same instruction from the
other direction. Log it as an anomaly, finalize the posting unfilled, move on.

### G10. A required field with no truthful source is a stop, not a guess

The same posting required a **GitHub profile URL**, and `config/profile.yml`
has `github: ""`. "Answer every question" (Requirement 5) and "never fabricate"
(the Source-of-Truth Boundary) meet here, and the boundary wins: a URL is a
factual claim that either resolves to the candidate's work or does not.
Inventing one, or substituting the portfolio URL and calling it GitHub, is the
fabrication pattern AGENTS.md names explicitly.

The distinction that matters, and the one to apply everywhere:

- A question whose answer is *implied* by user-layer files but not written
  down verbatim (years of experience, a seniority band, a preference) → infer
  it, fill it, log the reasoning. This is what Requirement 5 is about.
- A question asking for an *identifier or credential that either exists or
  does not* (a profile URL, a licence number, a street address, a referral
  name) → it is either in the user layer or the run stops on it.

Both of the live examples so far are the second kind, and both are one line of
`config/apply-answers.yml` away from never blocking again.

### G11. A cookie/consent wall makes a form look like it does not exist

An inventory that returns zero controls while the page renders fine is almost
always a consent overlay, not a missing form. Seen live: a working application
page reported 0 fields and exactly four buttons, all of them cookie controls.

**Signal:** `counts.fields === 0` AND the only visible buttons match a consent
vocabulary (accept/reject/cookies/consent/préférences/zustimmen). **Action:**
dismiss it, then re-read the inventory — never conclude "no form" on the first
empty read. Prefer the *reject* control where one exists: it is the
privacy-preserving choice and, on the page tested, left the form fully working.

### G12. The way IN is not the same vocabulary as the way ON

`submits` looks for advance/finish words (Submit, Suivant, Continue). The link
that *opens* an application uses a different and wider vocabulary — the live
example was **"I'm interested"**, which matches none of them. Others in the
wild: "Start application", "Je postule", "Bewerben", "Apply now".

Keep the two concepts apart. Conflating them risks clicking an entry point as
if it were a submit. When a JD page has no form, look for an entry link by the
wider vocabulary, follow it, and re-inventory; the form usually lives on
another URL entirely (one ATS moved from `/{id}` to a separate `oneclick-ui`
host).

### G13. Shadow DOM — the single biggest blind spot

Covered in `lib/freemotion-inventory.mjs` in detail. The short version:

- `document.querySelectorAll` stops at every shadow boundary. One live form
  exposed **1 input at document level and 1814 open shadow roots** holding the
  real 13. Without piercing, that page reads as "no form".
- **Playwright's CSS engine DOES pierce open shadow roots**, so a plain
  `input[id="x"]` or `[data-test="y"] input[id="x"]` selector works for the
  caller even though the same string scores 0 hits from inside the page. Do not
  "validate" such a selector with `document.querySelectorAll` and conclude it
  is broken. (Playwright's old `>>>` deep combinator no longer exists — plain
  descendant is both correct and current; `>>>` fails to match.)
- **Ids are unique per root, not per document.** Two instances of one component
  each held an `id="file-input"`, and a component wrapper shared its id with
  the native control inside it (`<spl-input id=x>` around `<input id=x>`).
  Disambiguate in this order: bare id → tag-qualified (`input[id=x]`) →
  host-attribute-scoped (`[data-test=host] input[id=x]`).
- Labels are frequently projected from OUTSIDE the boundary, on the host. The
  label cascade has to climb out through `getRootNode().host` or every field
  comes back unlabelled.

### G14. `fill` is not typing — some components only listen to keystrokes

A city field on an autocomplete component accepted `fill()` with no error and
then reported itself empty and required on validation. `pressSequentially`
(Playwright's real per-character typing, `browser_type` with `slowly: true`)
set the same field correctly.

**Rule:** if a field reads back empty, or a required error persists on a field
you just filled, retype it slowly before concluding anything else is wrong.
Autocomplete, masked and combobox inputs are the usual suspects.

### G15. Verify an upload by the rendered filename, not by `input.files`

Two ATS moved or replaced the file input after a successful upload: one removed
it from the DOM entirely (so re-reading `#resume.files` throws on null), the
other kept several file inputs of which the one holding the file was not the
one clicked. In both cases the attached filename was plainly visible in the
page text.

**Rule:** confirm an upload by searching the rendered text for the filename.
`input.files.length` is unreliable at exactly the moment it matters.

### G16. Three different reasons a rendered page reports "no fields"

An empty inventory is never enough information to conclude the posting is
broken. All three of these look identical from a single read, and each has a
different fix — `lib/freemotion-inventory.mjs` now names which one it is:

| Signal in the inventory | Cause | Fix |
|---|---|---|
| `consentWall: true` | a cookie overlay is covering the form | click a `consentButtons` entry (prefer reject), re-read |
| `entryPoints` non-empty | you are on the job ad, not the form | follow the link (often another host), re-read |
| `frames` non-empty | the form is in an iframe | navigate to the frame's own `src` as a top-level page, re-read |

The iframe case deserves emphasis because no amount of shadow-piercing helps:
`browser_evaluate` runs in the TOP frame only, and a cross-origin frame is
unreadable from it by design. Seen live on a company careers site whose entire
application was an embedded ATS frame — 0 fields, no entry link, one iframe
whose `src` was the ATS's own application URL. Navigating straight to that URL
produced a normal, fully readable page.

### G17. A `<label>` often wraps the FIELD too — skip control-bearing subtrees

The commonest label-pollution shape is not decoration, it is structure:

```html
<label>
  <div class="application-label">Current location</div>
  <div class="application-field">
    <input ...>
    <div>No location found. Try entering a different location</div>
  </div>
</label>
```

Read whole, that label is *"Current location No location found. Try entering a
different location"* — the question with the widget's live dropdown state
welded on, and it changes while the form is being used. Another field on the
same form came back as *"Resume/CV ATTACH RESUME/CV Couldn't auto-read resume.
Analyzing resume"*.

The precise rule is **drop any subtree that contains a form control** when
deriving a caption: the caption is the text outside the control's own wrapper.
This beats "take the first block", which is a guess about ordering; the
control-containment test is structural and was right on every field of the
live form (`Resume/CV`, `Current location`, `Full name ✱`, `LinkedIn URL ✱`).

It applies to caption derivation only. Group-question resolution still reads
whole ancestors deliberately — there the text around the options IS the
question.

### G18. An iframe has two remedies, and the obvious one often fails

G16 said "navigate to the frame's own src". That works for an embedded board
whose frame URL is a real standalone page. It does NOT work for an ATS that
renders the application in a frame pointing at its own host and strips the
marker parameter when you open it top-level: the request bounces straight back
to the wrapper, still showing no form. Seen live on an iCIMS tenant, where
`.../login?in_iframe=1` redirected to `.../login` with 0 fields.

Two remedies, in order:

1. **Navigate to the frame src.** Cheap, and correct for an embedded board on
   a different host (0 fields became 25 on an embedded Greenhouse).
2. **Read into the frame.** If the frame is SAME-ORIGIN, its
   `contentDocument` is readable from the injected script and the fields were
   one hop away all along — `lib/freemotion-inventory.mjs` now descends into
   same-origin frames as part of the same sweep that pierces shadow roots. On
   the iCIMS gate this took the count from 2 fields to 7.

A cross-origin frame is readable by neither: script access throws by design.
That one stays in the inventory's `frames` list, and the caller either
navigates to it or drives it with Playwright's own frame API
(`page.frames()`), which does cross the boundary for clicks and fills even
where `browser_evaluate` cannot.

---

### G19. A phone field with a country-prefix widget rewrites what you typed

Typing `+33 7 53 37 78 23` into a phone input fronted by an international
prefix picker leaves `07 53 37 78 23` in the field, with the `+33` living in
the widget beside it. Nothing was lost and nothing needs retyping.

What breaks is verification. A check that compares the field's value to the
answer string sees a mismatch, decides the fill failed, and retries — and a
retry into a normalising widget is how a number ends up doubled. Compare the
**digits only, from the right**: the answer's trailing digits must be a suffix
of the field's digits, or the reverse. That holds whether the widget strips a
prefix, inserts spaces, or adds parentheses.

Confirmed live on a Workable form 2026-09-09.

---

### G20. Not every question inside an application form is an application question

A Workable form carried, between the consent checkbox and the submit button:

> How was your experience on this website today? Select an option from 1 to 5,
> with 1 being Hate and 5 being Love

with five emoji radio options. It is the ATS vendor's own satisfaction survey,
sitting in the candidate's form. It is optional, it is not read by the
employer, and it is not a question about the candidate.

Two things followed from it, both worth keeping:

1. **A rule keyed on a bare noun matches far more than it should.** The rule
   `portfolio|personal website|website|blog` matched this question on the word
   *website* and answered a satisfaction survey with a portfolio URL. The rule
   now requires the question to be asking FOR a site (`personal website`,
   `website url`, `site web`) rather than merely mentioning one. Every generic
   single-word alternative in an answer rule deserves the same suspicion.

2. **Option-label matching is what caught it.** The answer resolved to a URL,
   the widget offered `["😠","☹️","😐","🙂","😍"]`, nothing matched, and the
   plan reported `NO OPTION MATCH` with both lists instead of forcing a value.
   A planner that typed free text into whatever it was handed would have
   silently submitted a URL as a satisfaction rating. Report the mismatch; do
   not coerce.

---

## Per-ATS notes

### Radancy career site proxying Workday (`careers.thalesgroup.com`)

4-step wizard: `personalInformation` → `jobSpecificQuestions` →
`voluntaryInformation` → `applicationReview`, tracked in the URL as
`&step=N&stepname=...` — a free, reliable progress signal, no DOM parsing.

- Stable ids throughout: `sourceType`, `applicantSource`, `country`,
  `cntryFields.*`, `email`, `deviceType`, `phoneWidget.*`, `fitScore*`,
  `shareProfile`, `emailCommunication`, `eeoUSA.genderIdentity`.
- `sourceType` → `applicantSource` is a cascade (G4). Picking `Website`
  narrows the second select to a single valid option.
- Phone must be digits only, no spaces (`0753377823`).
- Consent pair `fitScoreYes` / `fitScoreNo` — see G1/G2. This is where the
  whole build nearly failed silently.
- **Tenant dedupes by candidate email across requisitions.** A second
  application from the same address short-circuits at the step-1 Next
  straight to `applythankyou?status=alreadyApplied` with
  `Job_Application_ID=undefined`. Nothing is submitted and no error is
  shown — the wizard simply ends. Detect it by reading `status=` in the URL
  after any Next, not just after Submit.

---


### Ashby (`jobs.ashbyhq.com/{company}`)

Single-page form, no wizard — everything is on `/{jobId}/application`.

- Field ids are a mix of stable system names (`_systemfield_name`,
  `_systemfield_email`, `_systemfield_resume`, `currentCompany`,
  `currentLocation`, `phone`, `additionalInformation`, `LinkedIn`, `Twitter`,
  `GitHub`, `Portfolio`, `Other`) and **per-question UUIDs** for everything the
  employer added. The UUIDs are stable per posting but meaningless across
  postings — exactly the case Requirement 1 is about, and the generic
  label-driven classifier handles it without a vendor table.
- `_systemfield_name` is labelled **"First name"**, and last name is a UUID
  field. Do not assume the system field is the full name.
- Radio groups: each option is its own input, id
  `{groupUuid}-labeled-radio-{n}`, and the label on the input is only the
  option text ("Yes"/"No"). **The question lives on an ancestor** — walk up
  until an element's text is longer than the option labels. Without that walk
  three different Yes/No groups are indistinguishable.
- Resume upload: see G6.
- **Invisible reCAPTCHA is present** (`textarea[name=g-recaptcha-response]`,
  hidden) and only fires on submit. Filling is unaffected, which is why a
  no-submit dry run says nothing about whether real submission would clear it.
  Ashby therefore belongs in the same "verify before trusting auto-submit"
  bucket as Lever, not in the safe list.


### Greenhouse (`job-boards.greenhouse.io/{company}`)

Single page, the friendliest of the four so far.

- Core fields have plain semantic ids: `first_name`, `last_name`, `email`,
  `phone`, `resume`, `cover_letter`; employer questions are `question_{id}`,
  and a multi-checkbox question is `question_{id}[]_{optionId}`.
- Country, and every employer picklist, is a **react-select ARIA combobox**:
  an `<input role="combobox">` with options in a separate listbox that only
  exists while expanded. Sequence: real click to open → read `[role=option]`
  → click the option by id. Typing into it filters rather than commits, so
  typing alone leaves the field empty.
- The page's only listbox while collapsed belonged to the *phone* widget
  (`iti-0__country-listbox`, 244 entries), not to the field being answered —
  the exact trap the containment/`aria-controls` rule in
  `lib/freemotion-inventory.mjs` exists to avoid.
- Cover letter offers **"Enter manually"**, which swaps the file control for a
  `#cover_letter_text` textarea. Worth preferring: it fills an optional field
  with tailored text at no PDF-generation cost.
- **After a successful upload the file input is REMOVED from the DOM** and
  replaced by a filename chip. Verifying an upload by re-reading
  `#resume.files` throws on null; check for the filename in the page instead.
- Invisible reCAPTCHA present, submit-time only.

### Workable (`apply.workable.com/{company}/j/{id}/apply/`)

Single page, and structurally the richest seen: 3 required Yes/No groups,
3 required long-form essays, required GitHub and LinkedIn URLs, an ARIA
combobox, plus optional summary / cover letter / expected salary.

- Core ids are plain (`firstname`, `lastname`, `email`, `summary`,
  `cover_letter`); employer fields are `CA_{id}` (company attributes) and
  `QA_{id}` (screening questions); radio options get random ids and are
  grouped only by shared `name`.
- Long-form answers are `<input type=text>`, **not** `<textarea>` — so a
  free-text detector keyed on the tag alone misses them. Another reason G7's
  role-based check has to tolerate both vocabularies.
- The upload and combobox labels are where G8's SVG bug surfaced.
- This posting also supplied G9 and G10, and was therefore **left unfilled on
  purpose** — an integrity attestation, a JD-phrase tripwire, and a required
  GitHub URL that does not exist in the user layer. It is a bad fit on the
  merits too (low-level storage/Rust vs. a cloud/data profile), so filling it
  would have been the wrong answer twice over.


A second Workable shape, reached from the public board (`jobs.workable.com`)
rather than a company subdomain, is a **modal over the posting**: the "Apply
now" button opens a `<dialog>` in the same page, so the URL never changes and
a URL-based "did I reach the form?" check reads as a failure. Two submit
buttons live in the dialog and a third `Next` is present but disabled, which
is why the inventory reports `submits` as a list with disabled flags instead
of guessing which one finishes the form.

**This is the form the fill plan drove end to end (2026-09-09).** No
site-specific code: the inventory read the modal (7 fields, 1 group, 1 upload,
6 required-empty), `lib/freemotion-fillplan.mjs --resolve` produced 8 ordered
actions from `config/apply-answers.yml` and reported the one question it could
not answer, and executing those actions in the order given left every required
field satisfied with the submit button enabled. Stopped there — not submitted.

Two more things about this shape, both relevant to the parked-tab workflow:

- **The file input id is regenerated per modal instance** (`input_files_input_{random}`),
  so a plan saved to disk and replayed after a reload targets an id that no
  longer exists. Re-read the inventory instead of persisting a plan.
- **An unsubmitted draft survives the tab.** Reopening the posting and clicking
  Apply now restored every field, the consent tick and the attached CV from the
  browser session. A parked application is therefore recoverable after the tab
  is closed, which is worth knowing before re-filling one from scratch.

It also produced G19 and G20, and exposed a gap that had been invisible for
the whole build: **`config/apply-answers.yml` had no rule for email or phone.**
The two fields every ATS asks for reached the model as open questions on every
single form, and each hand-written filler had quietly supplied them from the
profile instead. A generic driver surfaces that immediately; a per-site script
never does, because whoever writes it already knows the answer.


### SmartRecruiters (`jobs.smartrecruiters.com` → `oneclick-ui`)

The hardest of the six structurally, and the one that produced G11-G15.

- The JD page carries no form. The entry link is **"I'm interested"**
  (`#st-apply`, repeated five times on the page — click by id, not by text) and
  leads to a different host: `/oneclick-ui/company/{co}/publication/{uuid}`.
- A cookie wall must be dismissed first (G11), or the apply page reports zero
  fields.
- **The entire form is web components with open shadow roots** (G13). Field ids
  are stable and meaningful once you can see them: `first-name-input`,
  `last-name-input`, `email-input`, `confirm-email-input`, `linkedin-input`,
  `facebook-input`, `twitter-input`, `website-input`,
  `hiring-manager-message-input`, plus generated `spl-form-element_{n}` for
  city and phone.
- Each field's host carries a `data-test` (`personal-info-first-name`,
  `resume-upload`, `apply-with-resume-container`), which is the reliable
  disambiguator when an id repeats.
- The resume dropzone has **no button** — the trigger is a `<label>`, and the
  label is itself intercepted by the file input. Clicking the *input* directly
  (host-scoped) opens the chooser and works.
- Phone is normalized on blur (`+33753377823` became `7 53 37 78 23` with the
  prefix moved to a separate country control) — expected, not an error.
- City is an autocomplete that silently ignores `fill` (G14).


### Lever (`jobs.lever.co/{company}/{postingId}/apply`)

Single page, simple markup — and **hCaptcha**, which is why AGENTS.md's CAPTCHA
policy names Lever as a proactive skip. Two `newassets.hcaptcha.com` iframes
are present on load, before any interaction.

- Ids are plain and stable: `name` (a SINGLE "Full name" field, not first/last
  — do not assume the two-field shape), `email`, `phone`, `org`
  ("Current company"), `location-input`, `resume-upload-input`, and bracketed
  URL fields `urls[LinkedIn]`, `urls[GitHub]`, `urls[Twitter]`,
  `urls[Portfolio]`, `urls[Other]`.
- **LinkedIn URL is required** on the posting tested; GitHub is optional here
  (contrast with the Workable posting where GitHub was required — see G10).
- This is where G17 came from: `<label>` wraps the caption and the field, and
  the location widget's dropdown state was being read as part of the question.
- Left unfilled: with hCaptcha on the page, a dry run proves nothing about
  whether a real submission would go through, and the standing policy is to
  skip the platform rather than probe it.


### iCIMS (`careers-<tenant>.icims.com`)

Nested-frame architecture and a gate before the form.

- The job page and every application step render inside an iframe on the SAME
  host, marked `?in_iframe=1`. Opening that URL top-level strips the parameter
  and redirects to the wrapper, so the frame-src remedy fails here (G18).
  Same-origin `contentDocument` traversal is what works.
- Applying starts at a **GDPR/consent gate**, not the form: an email field, a
  "time-based consent" select, an "I accept" checkbox and a submit. The real
  application comes after it, so an inventory taken on the first screen
  describes the gate and nothing else.
- **hCaptcha is present** (two `newassets.hcaptcha.com` frames), which puts
  iCIMS in the same proactive-skip bucket as Lever for auto-submit.
- The tenant tested (Nortal) posts in Estonia, Poland and Germany, so nothing
  there fits a France-only search. Structure captured, no application made.

### SuccessFactors (`careers.<company>.com`, SAP RMK)

- The public search UI returned **zero results for every query**, including
  the empty one ("The 0 most recent jobs posted by..."), while the repo's own
  `scan.mjs` pulled 28 live postings from the same tenant's feed in the same
  minute. The browser board is bot-gated; the feed is not.
- **Consequence for the applier:** never conclude a company has no openings
  from its rendered careers page. Check the scanner's feed output first. This
  is a fourth reason a page looks empty, on top of G16's three, and the only
  one that is invisible from inside the browser.

### Workday tenants that gate the form behind an account

Some Workday tenants let a guest reach the form; others do not, and the
difference is invisible from the posting. Checked 2026-09-09 on
`accenture.wd103.myworkdayjobs.com`: the posting offers three routes —
**Autofill with Resume**, **Apply Manually**, **Use My Last Application** —
and *both* of the first two land on the same `Sign In` page (`Sign in with
Google` / `Sign in with email`), with zero form controls. The URL keeps the
`/apply/autofillWithResume` or `/apply/applyManually` path while the title
becomes `Sign In`, so a "did I reach the form?" check keyed on the URL reports
success on a page that has no form at all. Check for controls, not for a path.

**This gates most of the high-score backlog.** The 4.0+ evaluated roles that
have never been applied to sit almost entirely on Workday tenants — Accenture,
Sanofi, NTT, Thales — and a Workday account is **per tenant**, so each one
needs its own registration plus its own email verification. That makes
`lib/freemotion-inbox.mjs` (Phase 9) the thing standing between this backlog
and an automated run, and it is currently unconfigured: `readInboxConfig()`
returns defaults and `getAccessToken()` throws for want of OAuth client
credentials. Until that exists, each tenant costs the user one manual
verification click, and the applier cannot resume unattended.

---

## Open gaps

1. **`data/freemotion-submissions.tsv` has no outcome for "the ATS refused
   before we ever reached Submit".** `alreadyApplied` was recorded as
   `errored`, which is the closest of the seven valid outcomes and still
   wrong: nothing errored, the run worked correctly and the employer said no.
   A `not-applicable` / `already-applied` outcome would make the ledger
   honest. Worth adding to `VALID_OUTCOMES`.
2. **No outcome for a deliberate dry run either.** These no-submit rehearsals
   are being recorded as `validation-failed` with an explanatory note (the
   precedent set on 2026-09-01). A `rehearsal` outcome would stop dry runs
   from polluting the failure statistics.
3. **No authentic writing sample exists**, so generated prose is de-slopped
   against `voice-dna.md` but not matched to how the user actually writes.
   `lib/voice-check.mjs`'s `styleCalibration()` now says so on every run
   rather than letting "clean" imply "sounds like you". One past cover letter
   or LinkedIn About in `writing-samples/` closes it.
4. **Phase 10 has never been exercised against a real verification wall, and
   it is now the top blocker.** Gmail OAuth is unconfigured, so
   `getAccessToken()` throws for want of client credentials. The Workday note
   above explains why that gates most of the 4.0+ backlog.
5. **Two 4.5+ scored roles are outside France** (#930 UK home office, #931
   Nairobi), which the Passeport Talent route rules out. Location is not
   weighted hard enough in scoring to disqualify them, so the top of the
   backlog reads better than it is.


### Closed since the first version of this document

- **The fill side is now generic** (2026-09-09).
  `lib/freemotion-fillplan.mjs` turns an inventory plus resolved answers into
  an ordered, typed action list, and drove a previously unseen Workable modal
  end to end with no site-specific code. This was the honest hole in the Free
  Motion premise: the reader generalised, the filler was a script rewritten by
  hand per ATS. Six of those existed at one point, each re-deriving G1, G4,
  G5, G6 and G14 from memory and each free to forget one.
- **`config/apply-answers.yml` had no street address**, so every optional
  address line was left empty on the grounds that an address is a factual
  claim and not inventable. The user supplied it 2026-09-08; the rules now
  cover line 1, line 2 and postcode.
- **`config/apply-answers.yml` had no email or phone rule.** Found by the
  first generic run, on the two fields every ATS asks for. See the Workable
  note above for why a per-site filler could never have surfaced it.
