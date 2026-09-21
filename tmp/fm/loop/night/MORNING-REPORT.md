# Overnight run — 21 September 2026

## What I did not do

**I did not send a real application.** You asked to see a full apply before
hitting submit, I showed you, and you never answered the submit question. That
decision is still yours. Nothing was sent to any employer.

Nothing is committed either. Say the word and it goes in.

## The headline

I found three bugs that each made the system confidently wrong. The worst one
meant **the safety check has never worked** — not tonight, not in any earlier
run.

### 1. The safety gate was checking nothing at all

The gate takes two readings of the page and compares them, then checks the
result against what we meant to fill. The two functions involved disagreed
about their own shapes: one returns `{stable, settling}`, the other expects
`{before, after}`. Handing the first straight to the second gave it **an empty
list of fields** — and an empty list has no problems in it.

So every run ever made reported "gate valid, no failures" having inspected
nothing whatsoever. The check the whole design leans on before pressing Submit
was decorative.

Caught by pointing the loop at a local form with a required tickbox left
unticked. The gate passed. The *browser* then refused the submission on its own
validation. The page told the truth and our check did not.

Fixed, and the test I wrote asserts a page that must fail *does* fail — because
a broken gate passes everything, so "does a good page pass" proves nothing.

### 2. The gate was told the wrong names

Separately: the gate identifies fields by their `name` attribute — `Firstname`,
`MotivationLetter`. The loop was describing them by their visible label —
"Prénom", "Message au recruteur". On one real form exactly one field in five
matched, and only because that page's email box happens to be named `Email`.

### 3. A line in the instructions told the robot it could never submit

My own wording. On a real run the rules read "submit is refused entirely while
rehearsal is false" — which literally says submitting is refused. Agy read it
correctly and abandoned the job. That would have blocked every real
application. The line now only appears when a rehearsal is actually on.

## The submit path now works, proven end to end

I built a fake employer on this machine — a form shaped like the real ones,
including the traps that cost us three runs each — and ran the loop against it
with submit enabled. All three outcomes behave correctly:

| the page says | recorded as | tracker |
| --- | --- | --- |
| "Nous accusons réception de votre candidature" | `submitted` | row written, status log written |
| "Vous avez déjà postulé…" | `already-applied` | correctly not written |
| nothing at all | `unknown` | not written — "check the inbox, do NOT re-submit" |

That last row is the one that matters. A page that says nothing is not a
success and not a failure, and the system now says so instead of guessing.

The successful run took **4 turns and 48,994 tokens** — the cheapest of the
night, because a working gate tells agy exactly what is missing instead of
letting it flail.

## Sites

**Hellowork — works.** Three postings, all the way to a ready-to-send
application: cookie wall declined, form opened, CV attached, fields filled,
letter written, terms ticked, gate passed, submit correctly refused in
rehearsal. About 95k tokens each.

**Welcome to the Jungle — out of scope, and now recognised as such.** Its Apply
button goes straight to a sign-in page. The first run filled in the email *and
the password box* on that login form, because structurally a login looks
exactly like an application. It now spots a password field with no CV upload,
stops, and says why. Same posting: 12 turns and 185k tokens before, 3 turns and
34k after.

Also worth knowing: that site returns **403 to plain `curl`** and loads
perfectly in our browser. Any liveness check done with a plain HTTP client will
call those postings dead when they are not.

## Other things fixed tonight

- The tracker write now happens, and the status log with it. A confirmed
  submission lands in all three records or none. Verified against a throwaway
  tracker, not yours.
- Answers are now given **by number** instead of by repeating a label back.
  Three separate failures to tick one box all came from text matching; that
  whole class is gone.
- A consent box whose answer was "no" used to get **ticked**, because "no"
  matched the only option available. It now ticks only on a recognised yes.
- Watching a run works: `--engine chromium --headful` or `--engine firefox
  --headful`. Camoufox refuses to be watched rather than run at two minutes a
  click, and says why.
- Consent banners that say "No, thanks" / "OK for me" are now recognised.

## Numbers

Twelve runs, 932,567 tokens, averaging 77,714 per run. The good runs sit
between 49k and 101k. The expensive ones were the broken ones — the record was
185k for a run that achieved nothing on a login page it should have refused in
three turns.

Tests: **8,843 passing.** The single failure is the README marker your
auto-submit rewrite removed, unrelated to any of this.
Pipeline health: **0 errors.**

## Waiting on you

1. **Send the Devoteam application for real?** Still unanswered.
2. **Commit tonight's work?** Nothing is committed.
3. A suggestion, not a decision: a posting that needs an account we have ruled
   out is currently recorded as `errored`, which reads as our fault. A plainer
   state for it — "needs an account" — would stop these looking like failures
   in the numbers. Your call whether it is worth a new state.
