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

### G21. Three different ways a control lies about being empty

The "is this field already answered?" test looked obvious — a non-empty value
means answered — and it was wrong three times in one night, each time silently.
A field wrongly judged answered is never planned, so the form refuses to
advance and names a control that looks perfectly filled on screen.

- **A dial prefix.** A phone input fronted by a country picker renders holding
  `+33`. Real value, not an answer. Now: a lone `+` or `00` plus at most four
  digits and nothing else counts as empty.
- **A slider's starting position.** `<input type=range>` always has a value —
  it has to render somewhere. Now: a range is answered only when its value
  differs from the `defaultValue` the markup shipped.
- **A pre-selected placeholder option.** A `<select>` whose first option is
  "Please select" has a value of `''` in well-built forms, but not always.
  Watch for it; not yet a rule here because every case seen so far did use `''`.

The general lesson is that "empty" is a property of the ANSWER, not of the
string in the DOM. Ask what the control looks like before anyone touched it.

---

### G22. A hidden control is clicked by its label (G6, for choices)

Four force-clicks on four custom-styled radios all reported success and left
every group unanswered. The real inputs were 0×0 behind painted labels, so each
click landed on whatever was on top — and a Playwright `force: true` click
suppresses exactly the actionability complaint that would have caught it.

Same shape as the 1×1 file input, same remedy: click the visible thing. A
`<label>` bound to a control toggles it by definition, so there is no guess
about which wrapper is clickable — resolve via `el.labels[0]`, then
`label[for=id]`, then the nearest ancestor `<label>`. The reader now reports
`hidden` and a `clickSelector` per option and per checkbox; the plan prefers it.

On the form that exposed this, clicking labels instead took the same page from
three unanswered required groups to `requiredEmpty: 0`.

---

### G23. A submit control is an `<input>` too

`type=submit`, `button`, `reset` and `image` are all `<input>` elements, so a
naive `input:not([type=hidden])` sweep collects them as fields. One form
reported its submit as an unlabelled textbox whose "value" was the words
*Submit application*, which a planner would then try to type an answer into.
Exclude all four types at the source; the buttons are already reported
separately, classified, in `submits`.

---

### G24. "Required" is often only in the label

Some forms never set the `required` attribute and write the word instead —
"First name * Required". A form like that reports zero required fields, a
readiness check passes, and the submit is refused for a field nobody planned.

Treat a control as required when its own accessible name contains the word, in
the languages a label says it in (`required`, `mandatory`, `obligatoire`,
`requis`, `erforderlich`, `obligatorio`, `obbligatorio`). Only as a fallback,
and only from the control's OWN label, never from surrounding page text.

---

### G25. Not every form on a careers page is the application

A careers page carries other forms: a newsletter signup in the footer, a site
search, a cookie preferences panel. One live page offered a field labelled
"Email address without domain" — a mailing list — and a planner that fills
every field on the page puts the candidate's address into it and calls the
application complete.

Controls now report their owning `<form>` as an index, and the plan keeps to
the one holding the work. Which form that is gets decided by EVIDENCE, not by a
name or a position: its uploads weigh most (a newsletter box never asks for a
CV), then its required fields, then everything else. Two rules keep it safe:

- A control belonging to **no** form is always kept. Plenty of ATS render their
  fields outside a `<form>` element entirely, and dropping those would empty
  the plan on exactly the pages that need it most.
- A page with one form is never filtered.

---

### G26. A honeypot is a field that asks to be left alone

Found live: an `<input>` labelled **"Please leave this field blank"**, optional,
rendered, in an otherwise ordinary application form. The standing instruction
for this project is to fill optional fields too — so it would have been filled,
and filling it is the single thing that marks an application as automated.

Three signals, checked independently. On the live field all three fired:

1. The label asks to be left alone, in whatever language it asks (`leave this
   field blank`, `ne pas remplir`, `nicht ausfüllen`, `dejar en blanco`, …).
2. The control is parked off-screen (`position:absolute; left:-9999px` — the
   live one measured at (-9902, -9759)) or painted to invisibility while still
   reporting as laid out.
3. It is out of the tab order (`tabindex="-1"`) with no label at all. A real
   question is always reachable by keyboard.

**Not** keyed on the field's name or id. That is fingerprinting one
implementation: the moment a form calls its honeypot something other than
`nickname_hpcsaf`, a name-based check is worthless while still looking like it
works. `pendingWork` drops honeypots entirely, required ones included — a
honeypot is not work to schedule, and the only correct action is none.

---

### G27. "Are there any fields?" is the wrong way to ask "am I on the form?"

A job POSTING page routinely carries one or two fields: an "email me this job"
box, a site search, a newsletter signup. Two opposite failures follow from
guessing on the count:

- Keyed on **zero** fields, the caller never clicks Apply on those pages,
  because it thinks it is already on a form.
- Keyed on **any** field, it stops at the posting and fills a mailing list.

`looksLikeApplicationForm()`: an upload settles it (a newsletter box never asks
for a CV), otherwise four or more questions. Both live probes that needed it —
one at one field, one at two — were posting pages with an Apply button.

---

### G28. A cascade does more than re-render: it deletes, renames and re-ids

The original G4 said a cascading select invalidates the refs below it. The live
run went further. Choosing **France** for Country on one form:

- **deleted** the State field outright (France has no state in that form's
  model), so a plan built beforehand listed a field that no longer exists;
- **renamed** "State *" to "Province *" and "ZIP *" to "Postal Code *";
- **re-created** Address, City and Date Available under fresh ids, so four
  fills failed on stale selectors and succeeded immediately on a re-read.

Three consequences worth keeping:

1. Re-read after **each** cascade step, not once after all of them.
2. A field that has vanished is not an error. A caller that treats "the field
   I planned is missing" as a failure fails a form that is perfectly fine.
3. An answer rule must cover both countries' vocabulary for the same concept,
   because the label changes under you. The postcode rule matching `zip`,
   `postal code` and `postcode` is not redundancy, it is this.

---

### G29. A picklist can arrive with no options, or with a default nobody chose

Two more ways a `<select>` misrepresents itself, both live on one form:

- **No options yet.** Both picklists reported exactly one blank option, so a
  ranked answer matched nothing and the plan reported the form as offering no
  valid value. The options are injected when a person opens the control — the
  popup then held 256 countries. Treat a select whose meaningful option count
  is zero as `optionsUnknown` and open it, exactly like a collapsed combobox.
- **A default nobody chose.** Country arrived set to *United States*, which
  reads as perfectly answered and is wrong for most candidates. A REQUIRED
  picklist still sitting on the option the markup shipped (`defaultSelected`)
  has not been answered by anyone. Only required ones: an optional select left
  at a sensible default is a legitimate end state.

---

### G30. Clicking a consent label can open a modal instead of ticking the box

The consent line was *"I have read the Privacy Policy and accepted them"*, with
**Privacy Policy** as a link inside the label. Clicking the label at its centre
hit the link, which opened the policy in a `<dialog>`. That dialog is `:modal`,
so everything behind it became inert, and the next three clicks timed out for
reasons that had nothing to do with the controls they named.

So the click-target preference has an exception: prefer the input once overlays
are clear, and use the label only when the input is genuinely unclickable AND
the label contains no anchor. And check `dialog[open]` / `:modal` before
concluding a control is broken — an open modal explains every timeout on the
page at once.

---

### G31. Dismiss a consent banner even when the form is perfectly readable

G11 covered the case where a cookie wall replaces the form. This is the case
where it merely **covers part of it**: the form read fine, 17 fields and 2
groups, and three controls in the lower half could not be clicked because a
banner sat on top of them. Same 30-second timeouts, no error message, nothing
in the inventory to suggest a cookie problem.

Dismiss the banner first, always, whether or not the form looks readable. One
live page also had a cookie **preferences** form of its own, whose "Strictly
necessary" checkbox showed up in the page's checked-boxes list — another reason
the owning-form filter (G25) exists.

---

### G32. A 200 from the submit endpoint is not a submission

Three Ashby applications to the same employer, submitted minutes apart. All
three fired the submit call and all three got HTTP 200. All three removed the
Submit button. One was accepted. The other two were refused: the employer
takes one application per candidate per 30 days, and the refusal came back as
a normal GraphQL response carrying an error, rendered in the page as "We
couldn't submit your application".

So none of the network signals decide success: not the status code, not the
request having fired, not the button disappearing. Read the page's own status
text after submit and match it against both outcomes, success ("successfully
submitted", "thank you for applying", "candidature envoyée") and refusal
("couldn't submit", "already applied", "within the last N days"). If neither
matches, the outcome is unknown. Check the inbox for an acknowledgement before
recording anything, and never re-click.

A refusal like this is also a per-employer cooldown, not a per-posting one.
Once one employer refuses on those grounds, skip that employer's remaining
postings for the rest of the batch.

---

### G33. A restored draft can carry an upload that has already expired

Workable keeps an unfinished application in localStorage
(`evergreen-persistence-{jobId}`) and restores it when the posting is opened
again. Everything comes back: name, phone, cover letter, salary, consent, and
the resume. But the resume is only a pointer to a temporary S3 object under
`tmp/ttl-1d/`, and a draft filled two days earlier points at a file that no
longer exists. The widget shows the filename as if all is well. Submit then
fails with a 400 and "Your resume failed to upload", which reads like an
upload problem and is not one.

Two things did not fix it, and one did:

- Uploading a new file over the restored one: the upload succeeded on the
  server, but the widget stayed in its error state and kept the dead pointer.
- Dismissing the file and uploading again, programmatically or through the
  real file chooser: after a dismiss, the dropzone stopped reacting to new
  files. No upload request was sent.
- **Reload the page, then upload into the fresh input.** The draft restored
  without the resume. One `setInputFiles` produced a new object, and submit
  returned 201.

General rule: treat any file that shows up already attached in a form you did
not fill in this session as stale. Re-upload it before the first submit. And
when a form has already failed a submit, reload it rather than retrying in
place: some client state does not recover.

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
- **Live result, 2026-09-11 (Alan):** the invisible reCAPTCHA cleared on all
  three submits with no visible challenge. Submit is the GraphQL op
  `ApiSubmitSingleApplicationFormAction`, which answers 200 whether it accepts
  or refuses (G32). Success page: "Your application was successfully
  submitted." Refusal page: "We couldn't submit your application … as you
  have submitted an application within the last 30 days". The cooldown
  covers the whole employer, so one accepted posting blocks that employer's
  other postings for 30 days. The acknowledgement email comes from
  `no-reply@ashbyhq.com`, subject "{First name} x {Company}", and does not
  name the role.


### Flatchr (`careers.flatchr.io/vacancy/{slug}/apply`)

Live, 2026-09-11 (two Bureau des Talents postings, both submitted).

- One plain form: `firstname`, `lastname`, `email`, a country `select` plus an
  unnamed `tel`, one `file`, a **required** `comment` textarea (the cover
  message), `linkedin`, `github`, `other`, and a `consent` checkbox. No
  captcha, no honeypot.
- Submit is a multipart POST back to the vacancy URL. It answers 200 **with
  the vacancy record**, not an application receipt, so the body proves nothing
  (G32).
- The success signal is a page at `.../apply/success` reading "Merci d'avoir
  postulé !" with a 5-second countdown, then a redirect to the agency's own
  homepage. A check that runs after the redirect sees only a marketing page.
  Watch main-frame navigations, or read the page within the first 5 seconds.
- No acknowledgement email arrived for either submission within an hour.
- Agency postings name the end client in `reference` ("Kadensis - DevOps").
  Record that as the company, with `via=` the agency.

### SmartRecruiters one-click (`jobs.smartrecruiters.com/oneclick-ui/...`)

Live, 2026-09-11 (Meritis, submitted).

- The whole form lives in open shadow roots (`spl-input`, `spl-dropzone`,
  `spl-textarea`, `spl-dropdown-search`). `document.querySelectorAll` sees
  none of it. Playwright CSS selectors pierce it.
- **The id sits on both the host element and the inner input.** `#first-name-input`
  resolves to the `spl-input` host and `fill()` fails with "Element is not an
  input". Use `input#first-name-input`.
- Two dropzones. The first is the "fill in automatically from a resume"
  import, the second is the actual CV. Upload into the second.
- The page's first "Postuler" button is **"Postuler via Indeed"**, which opens
  an Indeed OAuth tab. Match the button name exactly.
- Two steps: the profile page ("Suivant"), then a screening page. Meritis's
  screening page held one required privacy-consent checkbox, then "Envoyer".
- Success: the application API returns 200 with a `candidateId`, and the page
  moves to `/success` with "Votre candidature a bien été envoyée !". No visible
  challenge appeared, although the page source mentions a captcha.

### Teamtailor (`{company}.teamtailor.com/jobs/{id}`)

Live, 2026-09-11 (Metanext, submitted). See also the earlier note on the
future-jobs consent.

- Rails form: every checkbox has a **hidden `0` input with the same name**
  placed before it. `form.querySelector('[name="candidate[consent_given]"]')`
  returns the hidden one, whose `.checked` is always false. Read state
  through `input[type=checkbox][name=...]`, or a ticked box reads as unticked.
- The resume upload lands in an invisible text input
  `candidate[resume_remote_url]` (a Teamtailor S3 `tmpuploads/` URL). Also
  check that the hidden `candidate[delete_resume_remote_url]` is `0`.
- The phone uses intl-tel-input. Typing `+33 …` selects France by itself.
- Success: POST `/applications` returns a turbo-stream pointing at
  `/applications/{uuid}/thanks/...`, and the page reads "Merci pour votre
  candidature".
- A company careers site on a custom domain (`jobs.zenika.com`) is still
  Teamtailor, behind a cookie-preferences dialog that hides the apply button.
  Its job page may show no apply button at all. Go straight to
  `/jobs/{id}/applications/new`, which always serves the form.
- **Range slider questions** (salary on a 0-100 "K euros" scale) are driven
  by a Stimulus controller that ignores a programmatic value. Setting the
  value on the input and its hidden `range-custom_number` twin left the
  display at "0 K euros". Focus the slider, press Home, then ArrowRight N
  times. The display, the input, and the twin all follow.
- **Required custom dropdowns** (`data-controller="common--dropdown"`) are
  validated through a hidden `sr-only` input with no name or id, backed by an
  ordinary radio group. Ticking the radio leaves the hidden input empty, and
  the form refuses to submit. Click the "Sélectionner une option" text, then
  the option text. After picking, press Escape and click outside: the
  collapsing panel (`max-h-0`) keeps intercepting clicks on the fields below
  it, the phone input included.
- **A second application from the same email needs email verification.**
  The submit POST returns 200 but redirects to
  `/applications/email_verification_needed` ("Vérifiez votre adresse
  e-mail"). The application is not complete until the emailed link is opened.
  `freemotion-inbox.mjs check --domain {careers host}` finds it as a
  same-site `/applications/verify_email/{uuid}?candidate_uuid=...` link, and
  opening it lands on the normal thanks page. Seen on the second Zenika
  application of the day; the first one went straight through.

### SmartRecruiters screening autocomplete

Sopra Steria's screening step added a required
`role=combobox` autocomplete ("Souhaitez-vous nous faire part de votre
situation RQTH ?") inside `spl-autocomplete`. Neither clicking the field nor
opening it with ArrowDown gave options that could be clicked reliably. The
list closes as focus moves, and its text sits deeper than `textContent`
reaches. What worked: type the start of the wanted option ("Je ne souhaite")
into the input to filter the list, then click the single remaining option.
Confirm the input's value afterwards. The step's question text is only
available on the `aria-label` of the `spl-autocomplete` ancestor
("Sélectionner {question}").

### SAP SuccessFactors career site (`career5.successfactors.eu/careers?company=...`)

Seen 2026-09-11 on Atos (`jobs.atos.net`, a SuccessFactors Career Site
Builder front end).

- **The apply link only works as a click from the job page.** Opening
  `/talentcommunity/apply/{jobId}/` directly bounced to the careers homepage.
  Clicking the job page's "Postuler »" link (not the "Postulez maintenant!"
  talent-community banner) set whatever session state it needs and landed on
  `career5.successfactors.eu/careers?company=Atos`.
- New candidates get an inline **create account and apply** form: email ×2,
  password ×2, first/last name, a `fbclc_ituCode` country-code select, phone,
  `fbclc_country` residence select, and custom fields. "Utilisateur déjà
  enregistré ? Connectez-vous" switches it to sign-in.
- Several custom fields (civility, address country, "Comment avez-vous
  entendu parler de ce poste ?") are `role=combobox` text inputs. Their
  options live under the input's `aria-controls` id. Open the input, click the
  option by exact text, then read the input's value back.
- **Privacy consent** is a link, "Lire et accepter la déclaration de
  confidentialité.", that opens a dialog. Its "Accepter" button is inside the
  `fd-dialog__content` container, not next to the dialog's header element.
  Afterwards the page reads "La déclaration de confidentialité a été
  acceptée."
- **The "Charger un CV" label is inert.** The click handler
  (`juic.fire(...)`) is on the neighbouring plus icon, `span[role=button]`
  `{n}:_attachIcon`. That opens a source dialog ("Charger depuis l'appareil",
  Dropbox, Google) containing an ordinary `input[type=file]`, which accepts
  `setInputFiles` directly with no native chooser. Success shows as
  "Le fichier a été chargé avec succès" plus the filename.
- A salary typed as `42000` is reformatted to `42 000,00`.
- **The password policy caps length at 18**, and a 20-character generated
  password is rejected. What the page shows is a generic banner, "Veuillez
  compléter tous les champs obligatoires et soumettre à nouveau. Les champs
  suivants nécessitent une entrée valide: Mot de passe", with no rule and no
  per-field message. The actual policy is readable before submitting, in the
  element named by the password input's `aria-describedby`
  (`rcmPwdPolicyAnchor`): at least 8 characters, no more than 18, one
  lowercase and one uppercase, at least one digit or punctuation mark, no
  spaces or Unicode. Generate with `--length 16` for this tenant.
  General rule: when a registration form rejects a generated password, read
  the field's `aria-describedby` before changing anything else — the visible
  error names the field, not the rule.

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


### Recruitee (`careers.{company}.com/o/{slug}/c/new`) — fully French

The first form driven end to end entirely in French, which is what the
language-agnostic claim needed. 4 fields, 3 groups, 2 uploads, all in French.
The apply URL is reachable directly from `https://{co}.recruitee.com/api/offers/`
(`careers_apply_url`), so no entry click is needed.

- One **"Nom complet"** field rather than first/last. The answer rule for it
  has to sit BEFORE the first/last rules, which both contain the word "name"
  and would otherwise swallow it and answer with half the name.
- Every one of its 11 radios and checkboxes is 0×0 behind a visible label —
  see G22. Four `force: true` clicks on the inputs reported success and left
  every group unanswered; clicking the labels took the same page from three
  unanswered required groups to `requiredEmpty: 0`.
- The phone field ships holding `+33` (G21).
- Its CEFR groups are phrased "Comment évalues-tu ton niveau en anglais ?",
  which no English-keyed rule reaches. Both language rules now carry the French
  phrasing.

Result: **all 8 planned actions landed, `requiredEmpty: 0`, not submitted.**

---

### Teamtailor (`careers.{company}.co/jobs/{id}-{slug}`)

Richest single form of the night: 17 fields, 2 groups, 2 uploads, and four
distinct problems in one page — a range slider (G21/G29), a submit control
reported as a field (G23), "Required" only in the label (G24), and a newsletter
signup in a second form (G25). It also supplied G30 and G31.

- The apply control is on the posting; clicking it reveals the form in place.
- **English fluency is a 1–5 slider.** No `choose` list can answer that; the
  `set_range` op steps it with arrow keys, and a top-of-scale answer maps to
  the control's own max.
- The "Where did you first hear about this job offer?" question is ten radios,
  all 0×0 in a container marked hidden, behind one "Select an option" button
  whose `aria-controls` points at a separate `[role=menu]` of ten `<button>`s.
  Markup says radio group; behaviour says combobox (G28's sibling case).
- The opener is a toggle: clicking it without checking `aria-expanded` closes a
  menu that was already open, then reports no options visible.

Result: **name, email, phone, essay, slider, CV, source, office answer and both
consents all filled; newsletter untouched; not submitted.**

---

### BambooHR (`{company}.bamboohr.com/careers/{id}`)

Listing available with no key at `/careers/list` (JSON). The apply form is
revealed by a button on the posting; `looksLikeApplicationForm` is what tells
the two states apart (G27).

- **The honeypot lives here** (G26).
- Its picklists are 0×0 native `<select>`s at opacity 0 behind
  `button.fab-SelectToggle`, with options injected on open (G29).
- Country → France triggered the strongest cascade seen (G28): State deleted,
  ZIP renamed to Postal Code, three text fields re-created under new ids.

Result: **13 of 14 fields filled, honeypot left empty, CV attached, one
province picklist outstanding on a posting that is not a real target.** Used as
a form-shape test only; no tracker row.

---

### join.com (`join.com/companies/{co}/{id}-{slug}`)

Apply leads to `/apply/authentication` — an email-first gate offering "Weiter"
or "Weiter mit Google" before any form. Not full registration, but still a
verification step, so it belongs to the same Phase 9 path as the Workday
tenants. Recorded, not pursued: the posting was a Berlin Werkstudent role.

---

### Personio (`{company}.jobs.personio.de`)

The XML feed at `/xml` is public and lists positions with ids, but the job URL
built from an id (`/job/{id}`) redirected to the marketing site on the posting
tried, and the feed carries no `<url>` element to use instead. Feed is useful
for discovery; the apply URL needs resolving another way. Unfinished.

---

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
4. **Phase 10 has never been exercised against a real verification wall,
   but it is no longer blocked.** Gmail OAuth was wired up 2026-09-09 from
   credentials the user already had, and verified end to end: a token refresh
   plus a real message fetch for machaka.mohammad@gmail.com. What remains is
   an actual run that hits a confirm-your-email gate and comes back through
   it. The Workday tenants and join.com's /apply/authentication are both
   waiting on exactly that.
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

---

### G34. A DOM value is not a form value

The Welcome to the Jungle ATS board (`ats.welcometothejungle.com`) rejected a
submit with "Missing information" on the email field while that field visibly
held the right address, `input.value` read it back correctly, and every
sibling field filled the same way was accepted.

The form is react-hook-form. Setting `.value` through the native property
setter and dispatching `input`/`change` updates the DOM and the React
rendering, but this field's registration had already recorded an empty value,
so validation ran against the empty one. Nothing on the page says the two
disagree: the value is there, and the error points at the field holding it.

Refilling through Playwright's own `fill()` — real focus, real keystrokes,
real blur — fixed it in one call. The stale `aria-invalid` stayed on the
element until the next submit, so the error text is not a reliable signal
either; only the submit attempt is.

General rule: fill controlled React forms with `fill()`/`type()`, not with a
scripted value setter. Keep `browser_evaluate` for reading state and for
textareas, which in this form accepted the scripted route without complaint.
And when a submit silently does nothing, check the network for the absence of
the application POST (G32's converse: no request at all, rather than a request
that answered 200) before re-clicking.

---

### G35. Flatchr's success page is built from a slug it does not always have

Two OZITEM applications through Flatchr, minutes apart, identical flow. Both
fired the same multipart POST to `/vacancy/{slug}` and both got 200. The first
landed on the thanks page. The second landed on a 404.

The difference is not in the submission. After the POST, the client navigates
to `/fr/company/{companySlug}/vacancy/{slug}/apply/success/` — and
`companySlug` is `undefined` in both cases. The first time that malformed URL
still resolved; the second time it went 307 to `/fr/404-not-found`, 308, then
404. The literal string `company/undefined` is visible in the working URL, so
the bug is present even when it appears to work.

This leaves a genuinely ambiguous outcome, and G32 still applies in both
directions: the 200 does not prove the application landed, and the 404 does not
prove it did not. What is checkable is the POST itself — that it fired, to the
vacancy endpoint, with a multipart body, and returned 200 rather than a 4xx.
Record the ambiguity in the tracker note rather than resolving it by guess, and
do not re-click: a duplicate application is worse than an unconfirmed one.

Flatchr sends no acknowledgement email (G-note under Flatchr), so the inbox
cannot settle it either. The only reliable confirmation is the employer's own
candidate space, if the tenant exposes one.

---

### G36. The inbox was never missing credentials, only an env loader

`lib/freemotion-inbox.mjs` reported "missing GMAIL_CLIENT_ID /
GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN" through an entire run, and two
applications were parked at email walls on that basis. All three values were
in `.env` the whole time, added weeks earlier.

`.envrc` loads them with direnv's `dotenv`, which populates an interactive
shell on `cd`. A tool-driven shell is not that shell, so `process.env` was
empty and the script's own error message — accurate about what it could see —
read as "you have no credentials" rather than "nothing loaded your .env".

Run it as `node -r dotenv/config lib/freemotion-inbox.mjs …`. The same applies
to every script in this repo that reads a secret from the environment.

The cost of not knowing this was two parked applications and a session spent
believing the inbox was unreachable. Before concluding a credential is absent,
check whether anything actually loaded it.

---

### G37. A Teamtailor verify_email link is not a one-click confirm

The second application to one Teamtailor careers host parks at
`/applications/email_verification_needed` (G-note under Teamtailor). The mail
that follows carries a link that looks self-contained:

    /jobs/{id}-{slug}/applications/verify_email/{uuid}?candidate_uuid={uuid}

Opening it cold redirects to `/connect/login`. The link verifies an address
against an authenticated Connect session; it does not create one. So the
sequence is: open the newest "Log in to {Company}" mail first, click through to
establish the session, and only then open the verify_email link in that same
browser context.

Two traps around it. The tenant sends BOTH mails, and the inbox helper scores
the login link above the verification link, so `check --domain` can hand back
the wrong one — filter the returned candidates by subject rather than taking
`link`. And a login link expires: yesterday's returns "Invalid login link,
please request a new one", which renders as an ordinary signup page rather than
an error, so it is easy to read as success.

Independent signal that the application is still incomplete: the tenant keeps
sending "Complete the application for {role}" reminders. Their absence, not the
presence of a generic "we have received your application" mail, is what
indicates completion — that acknowledgement is sent per candidate, not per
posting, and does not name the role.

### G38. Playwright's `locator.click` is unusable in a VISIBLE Firefox window on this machine

Measured 2026-09-20 on a bare local page with one button — no site involved.
Three identical clicks:

| engine | click 1 | click 2 | click 3 |
| --- | --- | --- | --- |
| Chromium | 109 ms ✅ | 272 ms ✅ | 22 ms ✅ |
| Firefox, headless | 350 ms ✅ | 29 ms ✅ | 31 ms ✅ |
| Firefox, headed | 15.7 s ✅ | timeout ✗ | timeout ✗ |
| Camoufox, headed | 29 s ✅ | timeout ✗ | timeout, **the click fired anyway** |

The last cell is the one that matters: a click that LANDED reported as a
failure. Anything that retries an unacknowledged click double-clicks, and on a
Submit button that is two applications.

The mouse is not at fault. Every event the page receives was recorded — all
seven, `pointermove` through `click`, on the right element, at the right
coordinates, `isTrusted: true`, byte-identical headed and headless. Protocol
tracing shows Playwright sends all three `Page.dispatchMouseEvent` messages and
then waits: acknowledgements came back at 2.0 s, 6.4 s and 14.9 s, growing per
event, while its own call log stops at `performing click action` and never
reaches `click action done`. It does not retry — exactly one attempt per click
over a 45 s window. So the fault is Juggler's ACK of an input command in a
headed window, not the input itself.

Ruled out: `humanize` on/off · `camoufox-js` vs the upstream Python launcher
(identical) · the `playwright-core <1.61` peer requirement (identical on
1.60.0) · window focus and `bringToFront` · hardware acceleration, WebRender
and APZ prefs · display scaling (coordinates land exactly, DPR 1) · the page
(a bare local page reproduces it) · antivirus (Kaspersky and Malwarebytes are
registered in Windows Security Center with no running service or driver; only
Defender is live).

**Two usable paths.** Raw `page.mouse.move/down/up` in headed Firefox: 6 of 6
clicks, 20–90 ms — so a headed Firefox run must drive the mouse directly and
forgo Playwright's actionability checks. Or run headless, where `locator.click`
works normally and keeps them.

### G39. Camoufox is only usable headless — and is stealthier that way

Headed Camoufox is worse than headed Firefox: 13 s for the first raw-mouse
click, then 120 s, with `humanize` absent, `false` and `0.1` alike. Headless
Camoufox does the same six clicks in 10–40 ms and `locator.click` works.

Stealth survives headless and improves slightly. creepjs, headless: `0%
headless`, `0% stealth`, `chromium: false`, "6% like headless" (13% headed),
WebRTC candidate and IP zeroed, timezone Europe/Paris matching the worker
thread, GPU "Apple M1 or similar" at high confidence, device "Mac (MacIntel),
macOS Catalina, 8 cores" — a coherent Mac rather than a patched Windows box.
Language is `en-US` against a Paris timezone; `geoip: true` aligns it.

Practical notes: the Python package and the npm port share one cache directory
and overwrite each other's layout, so whichever `fetch` ran last is the one
that works. Launch is ~20–26 s.

### G40. A posting's furniture reads as an application form unless you count only what is VISIBLE

One live advert reported 17 fields and 3 groups — every field `visible: false`.
They were job-alert widgets, a dormant account-creation form, and the cookie
banner's own checkboxes. `looksLikeApplicationForm` cleared its threshold on
them and `readiness` returned `ready: true` on a page with no application on
it; the form was behind the Apply link the whole time.

Worse, the same raw counts suppressed the consent flag: a full-screen cookie
modal reported `consentWall: false`, because the hidden widgets underneath it
counted as controls. The wall is now detected by geometry — an ancestor that is
fixed-position or an open modal dialog covering ≥25% of the viewport — which
survives a page that keeps a visible widget of its own underneath the overlay.

Two more traps on the same page. The consent buttons are absent from the
accessibility tree, so `getByRole` finds nothing and they match only by DOM
text; and the decline button read "Continuer sans accepter", which an
accept-only vocabulary misses entirely. Consent buttons now carry a `declines`
flag so the caller can prefer refusing.

### G41. Form scoping dropped the CV, and a datalist was read as a closed picklist

Two defects in `freemotion-fillplan.mjs`, both found on one live form and both
silent:

- **The upload was scoped out.** The identity fields sat in one `<form>` and
  the CV file input in its sibling, so `sameFormAs` kept the winning form and
  discarded the upload — a plan that would submit an application with no CV,
  against a form that requires one. Scoping may now never be the reason no
  upload survives: if the page asks for a file and the filter removed every
  one, they come back.
- **A suggestion list is not a closed set.** An `<input type="email">` carried a
  datalist of mail domains ("aol.com", "free.fr"). The reader reported them as
  options, the planner demanded the answer match one, and refused to type the
  candidate's own address — `noOptionMatch`. An `<input>` whose HTML type
  declares the shape of its value (email, tel, url, number, date…) is free
  text whatever ARIA role the page paints on it. A real picklist is never
  `type="email"`.

### G42. Driving agy as a controller: what a turn costs, and the two things that break it

Measured 2026-09-20 on the first working end-to-end run of `freemotion-loop.mjs`
(Hellowork, rehearsal, gates passed): **5 turns, 5 agy calls, 68,843 tokens for
a complete application.** The same application driven click-by-click through
the model cost 15–57 turns and 5–24M context tokens. The state handed to agy
each turn is ~900 characters and the whole prompt ~2.3 KB; the rest of the
per-turn cost is the runner's own system prompt, which is fixed overhead and
does not grow with the page.

Two operational traps, both of which cost whole runs before they were found:

- **Pass ABSOLUTE paths.** The prompt is handed over as a file path rather than
  as an argument, because a multi-line prompt through a Windows shell arrives
  as loose words (`Error: unexpected argument "are"`). But given a RELATIVE
  path the runner searches the filesystem for the file instead of opening it,
  and with `--output-format json` it gets a single turn — so the turn is spent
  searching and the reply is "I am currently searching for the file...". Two
  runs died on turn 1 this way.
- **Use `--json-schema`, with `--output-format json`.** It validates the reply
  against the move shape before returning it, which removes the chatter-instead-
  of-an-answer failure entirely: retries went from roughly half the turns to
  none. The same envelope carries a `usage` block — `input_tokens`,
  `output_tokens`, `thinking_tokens`, `total_tokens` — which is the only honest
  per-application cost measurement, and answers the open question in
  `docs/freemotion-requirements-v2.md` about how to measure agy's spend.

The reply must still be parsed by scanning for BALANCED braces. A lazy regex
stops at the first `}`, which on a reply carrying an `answers` array is the
inner object's, and the truncated string will not parse.

**Agy reads screenshots reliably.** Given only a gate screenshot and no other
context it named the site, listed exactly the field labels the DOM inventory
had found, and correctly reported that no consent overlay was present.

**Two loop-level rules the run proved necessary.** Confirm an upload by the
rendered filename and never attach that file again (G15) — without it the loop
re-attached the same CV every turn, because the re-rendered input reads empty.
And report only the blockers that belong to the APPLICATION: shown a page-wide
blocker it had no power to clear, the controller abandoned a fully filled,
gate-passing form.

### G43. One required tickbox, three separate causes, three failed runs

A required "I accept creating an account" tickbox sat directly above the send
button, inside the same visible card as the name, email and CV. The form could
not be submitted without it. Three consecutive runs filled everything else
perfectly, passed both gates, and left it unticked — each time for a DIFFERENT
reason, and each time invisibly: nothing errored, and the page looked complete.

**One: form scoping dropped it.** The identity fields were in one `<form>` and
the tickbox in a sibling, so `sameFormAs` discarded it. The fix is narrow on
purpose — a required CONSENT control survives scoping, a required data field
does not. The mailing list this scoping exists to avoid was itself a *required*
text input ("Email address without domain"), so "keep anything required" puts
the candidate's address on a newsletter.

**Two: nothing recorded that a control was required.** `pendingWork` encoded
required-ness by WHICH LIST an entry landed in, never on the entry, so the
scoping fix above silently did nothing — `it.required` was always `undefined`.
Entries now carry `required` as well.

**Three: the answer could not be matched back to the field.** The orchestrator
trims long labels before showing them to a model, so a 300-character consent
label arrived as its first 50. The model answered with what it was shown, and
that text no longer matched the field. Worse, plain containment matching made
it match the WRONG field: the label recites its whole panel — "… Métier
Localité Email Type de contrat CDI CDD …" — so the word "Email" in there
handed the tickbox the candidate's email address.

Fixed twice over: labels now match by WORDS (every word of the shorter must
appear as a word in the longer, which may add about five), and — the real fix —
the open questions are NUMBERED and the model answers by index, the way it
already picks click targets by index. No text comparison is involved at all.

**And a fourth, once it was finally reachable: the page had a hidden twin.**
`[name="HasAcceptedCGU"]` matched two elements, a hidden field and the visible
checkbox, and `.first()` took the hidden one. Every click timed out at 15
seconds against an element nobody could see. Clicks now resolve to the first
VISIBLE match, falling back to the control's `<label for=…>` when the input is
deliberately 0×0 behind a styled label (G22).

**The general lesson.** Every one of these failed silently in a state that
looked finished. A form that reports "nothing left to fill" while a required
box is unticked is the same class of failure as a submit recorded from a click
rather than from the page (G32): the system is confident and wrong, and only a
picture of the finished form shows it. The full-page gate screenshot is what
caught it.

**A consent tickbox is decided by yes, not by matching.** Its only "option" is
its own sentence, so "yes" matches nothing — and "no" matches the only option
there is, which meant a REFUSAL ticked the box. A tickbox is now ticked only on
a recognised affirmative; anything else leaves it alone and says so. A real
Yes/No pair still goes through ordinary option matching.

### G44. Watching a run: which engines can, and what it costs

Verified 2026-09-21 against a page carrying both traps — a checkbox with an
invisible twin of the same name, and a 0×0 checkbox reachable only by its
`<label for>`:

| engine | launch | clicks the visible twin | clicks the 0×0 box via its label |
| --- | --- | --- | --- |
| Camoufox, headful | refused by design | — | — |
| Chromium, headful | 1.8 s | 203 ms (locator) | 44 ms |
| Firefox, headful | 4.3 s | 974 ms (raw mouse) | 92 ms |

Camoufox refuses `--headful` rather than launch: in a visible window its clicks
take 13–120 s and sometimes report failure on a click that landed (G38/G39),
and an engine that silently behaves like that is worse than one that says no.

A visible Firefox is usable at about a second per click once clicks go through
raw mouse input, against 15–90 s and frequent false failures through
`locator.click`. Chromium needs no workaround at all and is the cheapest way to
watch a run, at the cost of no disguise whatsoever.

So the disguise and the ability to watch are mutually exclusive on this
machine, and the choice is per run: `--engine chromium --headful` to watch,
the default headless Camoufox to be unremarkable.

### G45. The DOM gate was checking a fifth of the form and reporting "valid"

The most serious defect found so far, and it was invisible because the gate
reported success.

`DOM_VALIDATION_SCRIPT` identifies each control by `name` → `aria-label` →
`data-automation-id` → `id`, and `evaluateValidation` matches the caller's
expectations against THAT. The loop was building its expectations from the
RENDERED LABEL — the same string it shows a human and hands the answer
resolver. Those are two different namespaces:

| what the loop sent | what the gate reads |
| --- | --- |
| Prénom | `Firstname` |
| Nom | `LastName` |
| Email | `Email` |
| CV | `JweHashResume` |
| Message au recruteur | `MotivationLetter` |

One field in five matched, and only because that page's email box happens to
be named `Email` as well. So the gate's headline check — "we sent a value and
the DOM does not hold it" — never fired for the other four, and every run
ended with `valid: true, failures: []`.

Everything about the design leans on that check. It is the thing standing
between a filled form and a Submit, and it was inspecting 20% of the form
while saying so confidently.

**Fixed** by mapping each planned action back through the inventory, by
selector, to the identifier the gate will actually use (`name`, falling back to
`id`). An action whose field cannot be resolved is now OMITTED rather than sent
under a name that cannot match — a silent non-match is precisely the failure
being removed. Uploads are excluded: a file input's value is unreadable and
would always look empty, so an attachment is still confirmed by the rendered
filename instead (G15).

**The lesson worth keeping.** Two modules each had a perfectly reasonable idea
of what "the name of a field" means, and nothing connected them. A check that
cannot fail looks exactly like a check that passes.

### G46. Apply → sign-in: the loop filled a LOGIN form with the candidate's details

A job board's Apply button navigated straight to `/authenticate/signin`. What
landed was a well-formed form — email, password, a button — so every check
reported "ready, no blockers", and the run filled BOTH boxes, including the
password, before exhausting its turns. Nothing was submitted and no real
credential exists for that site, but the shape of the failure is the point: an
application loop cannot tell a login from an application by structure alone,
because structurally they are the same thing.

The tell is a **password field**. Applications do not ask for one. A CV upload
on the same page overrides it, because some sites genuinely create the account
as you apply and those must still go through — that is exactly the Hellowork
flow in G43. So: a visible password field, no upload, and the run abandons with
the reason recorded, rather than typing into it.

Related: the same board returns **403 to plain `curl`** and loads perfectly in
headless Camoufox. Liveness checks done with a plain HTTP client will report
these postings dead when they are not, and a browser is the only honest way to
check them (AGENTS.md already says this for verification; it holds for triage
too).

Its consent banner also went unrecognised: the buttons read "No, thanks" /
"I choose" / "OK for me", none of which the accept/reject vocabulary matched,
so the page reported no consent wall at all and the widget's container was
handed to the caller as though it were a form field. Those phrasings are now
in the vocabulary.
