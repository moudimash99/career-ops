// apply-capgemini.mjs — batch-prefill Capgemini (SAP SuccessFactors) applications
// ---------------------------------------------------------------------------
// Opens one tab per role, fills every field we can source from cv.md /
// config/profile.yml, attaches the family-matched French CV, and hands the
// window to you. You review each tab and click "Postuler" yourself.
//
//   CAN SUBMIT. Auto-submitting is now permitted by policy.
//
// Usage:
//   node scripts/apply-capgemini.mjs --dry-run          # plan only, no browser
//   node scripts/apply-capgemini.mjs --login            # one-time session setup
//   node scripts/apply-capgemini.mjs --batch 1          # fill roles 1-10
//   node scripts/apply-capgemini.mjs --batch 2          # fill the rest
//   node scripts/apply-capgemini.mjs --only 4,19        # specific tracker rows
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const root = path.resolve(import.meta.dirname, "..");
const shortlist = JSON.parse(
  fs.readFileSync(path.join(root, "data", "capgemini-shortlist.json"), "utf8"),
);
const profileDir = path.join(root, ".capgemini-session"); // persistent login
const BATCH_SIZE = 20;

// ---------------------------------------------------------------------------
// Candidate facts — sourced from cv.md and config/profile.yml only.
// Anything not listed here is deliberately left for the human to answer.
// ---------------------------------------------------------------------------
const CANDIDATE = {
  firstName: "Mohammad",
  lastName: "Machaka",
  email: process.env.CAPGEMINI_USER, // the SuccessFactors account address
  phoneCountry: "France (+33)", // cv.md: +33 7 53 37 78 23
  phone: "753377823",
  countryOfResidence: "France", // config/profile.yml: Toulouse, France
  // profile.yml states authorized_in: ["France"] explicitly, so this one
  // question is safe to pre-answer for a French posting. Everything else in
  // the visa/demographic family stays blank.
  authorizedToWork: "Oui",
  formerEmployee: "Non", // cv.md shows no Capgemini employment

  // Authorised by the candidate directly, 2026-08-20.
  genderConsent: "Oui",
  gender: ["Masculin", "Homme", "Male", "Man"], // first match wins
  whatsapp: "Oui",
  acceptPrivacy: true,
  disabilityConsent: "Oui",
  disability: "Non", // no disability, no accommodations needed
};

// Fields we refuse to touch, with the reason shown in the handoff report.
const LEFT_BLANK = [];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

const isDryRun = flag("--dry-run");
const waitCaptcha = flag("--wait-captcha");
const isLogin = flag("--login");
const onlyArg = value("--only");
const batchArg = value("--batch");

let roles = shortlist.roles;
if (onlyArg) {
  const want = onlyArg.split(",").map((n) => Number(n.trim()));
  roles = roles.filter((r) => want.includes(r.tracker));
} else if (batchArg) {
  const b = Number(batchArg);
  roles = roles.slice((b - 1) * BATCH_SIZE, b * BATCH_SIZE);
}

function cvFor(role) {
  const rel = shortlist.cv_variants[role.family];
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `CV missing for family "${role.family}": ${rel}\n` +
        `   Run: node scripts/build-capgemini-cvs.mjs`,
    );
  }
  return abs;
}

// ---------------------------------------------------------------------------
// Dry run — show the plan without opening a browser
// ---------------------------------------------------------------------------
if (isDryRun) {
  console.log(`\n📋 Plan — ${roles.length} role(s)\n`);
  for (const r of roles) {
    console.log(`  #${String(r.tracker).padStart(2)} ${r.role}`);
    console.log(`      ${r.location} · ${r.family} · ${path.basename(cvFor(r))}`);
  }
  const total = shortlist.roles.length;
  console.log(
    `\n  ${roles.length} of ${total} shortlisted · batches of ${BATCH_SIZE}` +
      ` → ${Math.ceil(total / BATCH_SIZE)} batch(es)\n`,
  );
  const withLetter = roles.filter((r) => r.letter).length;
  console.log("  Pre-filled: CV, téléphone, pays, autorisation de travail,");
  console.log("              ancien salarié, handicap, genre, WhatsApp");
  console.log(`  Cover letters: ${withLetter}/${roles.length} role(s) have one`);
  console.log("  Left to you: " + LEFT_BLANK.map(([f]) => f).join(", ") + "\n");
  process.exit(0);
}

if (!CANDIDATE.email) {
  console.error("✗ CAPGEMINI_USER is not set in .env — cannot identify the account.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Browser session — DETACHED on purpose.
//
// launchPersistentContext() ties the browser's lifetime to this Node process,
// so stopping the script closes every prefilled tab and throws the work away.
// Instead we spawn Chrome ourselves with a debugging port and attach over CDP:
// disconnecting leaves the window standing, so you can take as long as you
// like reviewing tabs before submitting. Shut it down with --close.
// ---------------------------------------------------------------------------
const CDP_PORT = 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

async function cdpAlive() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function connectDetached() {
  if (!(await cdpAlive())) {
    spawn(
      chromium.executablePath(),
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profileDir}`,
        "--start-maximized",
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { detached: true, stdio: "ignore" },
    ).unref();

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await cdpAlive()) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!(await cdpAlive())) {
      console.error("✗ Chrome did not expose its debugging port — cannot attach.");
      process.exit(1);
    }
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  return browser.contexts()[0] ?? (await browser.newContext());
}

// --close: the deliberate way to shut the detached window down.
if (flag("--close")) {
  if (!(await cdpAlive())) {
    console.log("No detached browser is running.");
    process.exit(0);
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  await browser.close();
  console.log("✅ Detached browser closed.");
  process.exit(0);
}

const context = await connectDetached();

// locator.isVisible() is an instantaneous check, not a wait — waitFor is what
// actually blocks until the element shows up.
async function visible(locator, timeout = 2000) {
  return locator
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

// Capgemini's fixed navbar overlaps the Postuler control at some window
// sizes, so a real click gets intercepted. Fall back to dispatching the click
// on the element itself. Only ever used for navigation controls.
async function clickResilient(locator, page, timeout = 6000) {
  try {
    await locator.click({ timeout });
    return true;
  } catch {
    const handle = await locator.elementHandle().catch(() => null);
    if (!handle) return false;
    await page.evaluate((el) => el.click(), handle).catch(() => {});
    return true;
  }
}

async function dismissConsent(page) {
  // Capgemini's actual button is "Accepter tous les cookies". The overlay does
  // not block the job pages but it does block the candidate portal, so these
  // patterns have to match the real wording.
  const patterns = [
    /accepter tous les cookies/i,
    /accept all cookies/i,
    /tout accepter/i,
    /^accepter$/i,
    /j'accepte/i,
  ];
  for (const rx of patterns) {
    const btn = page.getByRole("button", { name: rx }).first();
    if (await visible(btn, 1500)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(400);
      return;
    }
  }
}

// --- one-time login -------------------------------------------------------
// SuccessFactors only exposes its sign-in modal from inside an apply page, and
// it may ask for e-mail verification or a captcha — so we open the door and
// let you walk through it. The session persists in .capgemini-session/.
if (isLogin) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(shortlist.roles[0].url, { waitUntil: "domcontentloaded" });
  await dismissConsent(page);

  const postuler = page.getByRole("button", { name: /^Postuler$/i }).first();
  if (await visible(postuler, 10000)) {
    await postuler.scrollIntoViewIfNeeded().catch(() => {});
    await clickResilient(postuler, page);
    const now = page.getByRole("menuitem", { name: /postuler maintenant/i }).first();
    if (await visible(now, 6000)) await clickResilient(now, page);
  }
  await visible(page.locator("#fbclc_userName"), 30000);

  const signIn = page.getByRole("link", { name: /connectez-vous/i }).first();
  if (await visible(signIn, 5000)) await signIn.click().catch(() => {});

  console.log(`
🔐 Sign in as ${CANDIDATE.email} in the browser window.
   Your password is in .env as CAPGEMINI_PASS.

   If the account does not exist yet, close this and run a single
   application instead — the form doubles as registration:

       node scripts/apply-capgemini.mjs --only 1

   Once you are signed in, the session is saved and every later batch
   uses the short pre-filled form. Press Ctrl+C here when done.
`);
  await new Promise(() => {}); // hold the window open
}

// ---------------------------------------------------------------------------
// Field helpers — element IDs confirmed against the live SuccessFactors form
// ---------------------------------------------------------------------------

// Text inputs carry stable fbclc_* ids.
async function fillById(page, id, text, label, log) {
  const box = page.locator(`#${id}`);
  if (!(await visible(box, 1500))) return false;
  if (await box.isDisabled().catch(() => true)) return false;
  await box.fill(text);
  log.push(label);
  return true;
}

// Two real <select> elements: phone country code and country of residence.
async function selectNative(page, id, optionRx, label, log) {
  const sel = page.locator(`#${id}`);
  if (!(await visible(sel, 1500))) return false;
  const options = await sel.locator("option").allTextContents().catch(() => []);
  const match = options.find((o) => optionRx.test(o.trim()));
  if (!match) return false;
  await sel.selectOption({ label: match }).catch(() => {});
  log.push(label);
  return true;
}

// The remaining dropdowns are SAP custom comboboxes ("N:_input"): click to
// open, then click the option. We never press Enter — in a form Enter can
// submit, a click cannot (same rule as web/src/lib/apply/session.ts:432).
async function pickCombo(page, inputId, choice, label, log, { type = false } = {}) {
  const wanted = Array.isArray(choice) ? choice : [choice];
  const input = page.locator(`[id="${inputId}"]`);
  if (!(await visible(input, 1500))) return false;
  if (await input.isDisabled().catch(() => true)) return false; // gated field

  // The popup occasionally fails to open on the first click under load, so
  // give each combobox two attempts before reporting it unset.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await input.click().catch(() => {});
    await page.waitForTimeout(attempt === 1 ? 700 : 1600);
    if (type) {
      await input.pressSequentially(wanted[0], { delay: 20 }).catch(() => {});
      await page.waitForTimeout(800);
    }
    for (const text of wanted) {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const option = page
        .locator("li:visible")
        .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, "i") })
        .first();
      if (await visible(option, attempt === 1 ? 1500 : 3000)) {
        await option.click().catch(() => {});
        await page.waitForTimeout(400);
        // Confirm it stuck — a click that lands on a closing popup is a no-op.
        const got = await input.inputValue().catch(() => "");
        if (got && got !== "- Sélectionner -") {
          log.push(label);
          return true;
        }
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  }
  return false;
}

// Open a job's apply form. Shared by sign-in and by each prefilled tab.
async function openApplyForm(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await dismissConsent(page);
  if (!/careers\.capgemini\.com/.test(page.url())) return false;
  const postuler = page.getByRole("button", { name: /^Postuler$/i }).first();
  if (!(await visible(postuler, 10000))) return false;
  await postuler.scrollIntoViewIfNeeded().catch(() => {});
  await clickResilient(postuler, page);
  const now = page.getByRole("menuitem", { name: /postuler maintenant/i }).first();
  if (await visible(now, 6000)) await clickResilient(now, page);
  // Either form works: anonymous (#fbclc_userName) or signed-in (#tor__fcellPhone).
  const anon = visible(page.locator("#fbclc_userName"), 30000);
  const auth = visible(page.locator("#tor__fcellPhone"), 30000);
  return (await Promise.race([anon, auth])) || (await anon) || (await auth);
}

// Sign in through the "Connectez-vous" modal on an apply page. The session
// then applies to every tab opened later in this same browser context, which
// is what lets a batch of applications work — the not-signed-in form doubles
// as registration, so only the first would ever submit.
async function signIn(page) {
  if (!(await openApplyForm(page, shortlist.roles[0].url))) return false;
  if (!(await visible(page.locator("#fbclc_pwdConf"), 1500))) return true; // already in

  const link = page.getByRole("link", { name: /connectez-vous/i }).first();
  if (!(await visible(link, 5000))) return false;
  const handle = await link.elementHandle().catch(() => null);
  if (handle) await page.evaluate((el) => el.click(), handle).catch(() => {});
  await page.waitForTimeout(3500);

  const dialog = page.locator("[role=dialog]").filter({ hasText: /Connexion/ }).first();
  if (!(await visible(dialog, 6000))) return false;
  await dialog.locator('input[type="text"], input[type="email"]').first().fill(CANDIDATE.email);
  await dialog.locator('input[type="password"]').first().fill(process.env.CAPGEMINI_PASS ?? "");
  await dialog.getByRole("button", { name: /^Connexion$/i }).first().click().catch(() => {});
  await page.waitForTimeout(11000);
  // The URL alone is an unreliable signal here — success is better judged by
  // the login dialog having closed and the registration field being gone.
  const dialogGone = !(await visible(dialog, 2000));
  const registerGone = !(await visible(page.locator("#fbclc_pwdConf"), 2000));
  return dialogGone && (registerGone || /portalcareer/.test(page.url()));
}

// ---------------------------------------------------------------------------
// Fill one role in its own tab
// ---------------------------------------------------------------------------
async function prefill(role) {
  const filled = [];
  const notes = [];
  const page = await context.newPage();

  await page.goto(role.url, { waitUntil: "domcontentloaded" });
  await dismissConsent(page);

  if (!(await openApplyForm(page, role.url))) {
    return { role, page, filled, notes: ["⚠️  apply form did not load — posting may be closed"] };
  }

  const anonymous = await visible(page.locator("#fbclc_pwdConf"), 1200);
  if (anonymous) notes.push("⚠️  not signed in — this is the register-and-apply form");

  // Documents. Clicking an upload control opens a source dialog and injects
  // the real input[type=file], which we set directly rather than driving the
  // dialog. Signed in, SuccessFactors pre-attaches the profile CV and offers
  // "Modifier le document"; anonymously it offers "Charger un CV".
  async function attach(buttonRx, filePath, label) {
    const btn = page.getByRole("button", { name: buttonRx }).first();
    if (!(await visible(btn, 4000))) {
      notes.push(`⚠️  no ${label} control found — attach manually`);
      return;
    }
    await clickResilient(btn, page, 4000);
    await page.waitForTimeout(1800);
    const fileInput = page.locator('input[type="file"]').first();
    if (!(await fileInput.count())) {
      notes.push(`⚠️  ${label} file input never appeared — attach manually`);
      await page.keyboard.press("Escape").catch(() => {});
      return;
    }
    await fileInput.setInputFiles(filePath).catch((e) => notes.push(`${label}: ${e.message}`));
    filled.push(`${label} ${path.basename(filePath)}`);
    await page.waitForTimeout(3000); // SF uploads and re-renders
  }

  await attach(/Modifier le document|Charger un CV/i, cvFor(role), "CV");

  // Cover letter, when one has been written for this role. Optional on the
  // form, but conventional for the French market — so attach it when we have
  // it rather than leaving the slot empty.
  if (role.letter) {
    const letterPath = path.join(root, role.letter);
    if (!fs.existsSync(letterPath)) {
      notes.push(`⚠️  letter missing: ${role.letter} — run build-capgemini-letters.mjs`);
    } else {
      // The cover-letter slot is pre-populated from the candidate profile, so
      // it arrives holding whatever letter the PREVIOUS application uploaded.
      // Unlike the CV (whose control is "Modifier le document"), the letter
      // only offers "Supprimer le document" — it has to be removed before the
      // right one can go on. Skipping this silently attaches another role's
      // letter, which is worse than attaching none.
      const stale = page.getByRole("button", { name: /Supprimer le document/i }).first();
      if (await visible(stale, 2500)) {
        await clickResilient(stale, page, 4000);
        await page.waitForTimeout(2500);
        const confirm = page
          .getByRole("button", { name: /^(oui|supprimer|confirmer|ok)$/i })
          .first();
        if (await visible(confirm, 2500)) {
          await confirm.click().catch(() => {});
          await page.waitForTimeout(2000);
        }
      }
      await attach(/Joindre une lettre de motivation/i, letterPath, "lettre");
    }
  }

  // Identity fields exist only on the anonymous form; signed in they come
  // from the candidate profile.
  if (anonymous) {
    await fillById(page, "fbclc_userName", CANDIDATE.email, "e-mail", filled);
    await fillById(page, "fbclc_emailConf", CANDIDATE.email, "e-mail (confirmation)", filled);
    await fillById(page, "fbclc_fName", CANDIDATE.firstName, "prénom", filled);
    await fillById(page, "fbclc_lName", CANDIDATE.lastName, "nom", filled);
    await fillById(page, "fbclc_phoneNumber", CANDIDATE.phone, "téléphone", filled);
    await selectNative(page, "fbclc_ituCode", /^France \(\+33\)$/i, "indicatif +33", filled);
    await selectNative(page, "fbclc_country", /^France$/i, "pays/région", filled);
    if (process.env.CAPGEMINI_PASS) {
      await page.locator("#fbclc_pwd").fill(process.env.CAPGEMINI_PASS).catch(() => {});
      await page.locator("#fbclc_pwdConf").fill(process.env.CAPGEMINI_PASS).catch(() => {});
      filled.push("mot de passe");
    }
  } else {
    await fillById(page, "tor__fcellPhone", CANDIDATE.phone, "téléphone", filled);
  }

  await pickCombo(page, "9:_input", "France", "pays de résidence", filled, { type: true });
  await pickCombo(page, "13:_input", CANDIDATE.authorizedToWork, "autorisation de travail", filled);
  await pickCombo(page, "17:_input", CANDIDATE.formerEmployee, "ancien salarié", filled);

  // Disability and gender both gate their detail field behind a consent
  // dropdown, so the consent goes first. Both answers were authorised by the
  // candidate directly (see modes/_custom.md).
  if (await pickCombo(page, "21:_input", CANDIDATE.disabilityConsent, "consentement handicap", filled)) {
    await page.waitForTimeout(700);
    await pickCombo(page, "25:_input", CANDIDATE.disability, "handicap", filled);
  }

  if (await pickCombo(page, "29:_input", CANDIDATE.genderConsent, "consentement genre", filled)) {
    await page.waitForTimeout(700);
    if (!(await pickCombo(page, "33:_input", CANDIDATE.gender, "genre", filled))) {
      notes.push("⚠️  gender option wording not matched — set it manually");
    }
  }
  await pickCombo(page, "37:_input", CANDIDATE.whatsapp, "WhatsApp", filled);

  // Privacy declaration — a legal consent, pre-accepted only because you
  // explicitly authorised it. It opens a modal that must be acknowledged.
  if (CANDIDATE.acceptPrivacy) {
    const privacy = page
      .getByRole("button", { name: /déclaration de confidentialité/i })
      .first();
    if (await visible(privacy, 3000)) {
      await clickResilient(privacy, page, 4000);
      await page.waitForTimeout(2000);
      const accept = page
        .locator("[role=dialog]")
        .getByRole("button", { name: /^(j'accepte|accepter|oui|ok)$/i })
        .first();
      if (await visible(accept, 4000)) {
        await accept.click().catch(() => {});
        filled.push("déclaration de confidentialité");
        await page.waitForTimeout(800);
      } else {
        notes.push("⚠️  privacy modal has no obvious accept button — accept it yourself");
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
  }

  // Read back what actually landed. A field that silently failed to take is
  // worse than one we never touched, because you would not think to check it.
  const readback = await page.evaluate(() => {
    const v = (id) => document.getElementById(id)?.value ?? null;
    const cv = document.body.innerText.match(/([\w.-]+\.pdf)/);
    return {
      CV: cv ? cv[1] : null,
      téléphone: v("tor__fcellPhone") ?? v("fbclc_phoneNumber"),
      "pays de résidence": v("9:_input"),
      "autorisation de travail": v("13:_input"),
      "ancien salarié": v("17:_input"),
      "consentement handicap": v("21:_input"),
      handicap: v("25:_input"),
      "consentement genre": v("29:_input"),
      genre: v("33:_input"),
      WhatsApp: v("37:_input"),
    };
  });
  const empty = Object.entries(readback)
    .filter(([, val]) => !val || val === "- Sélectionner -")
    .map(([k]) => k);
  if (empty.length) notes.push(`⚠️  still empty: ${empty.join(", ")}`);

  if (!isDryRun) {
    const needles = [/envoyer ma candidature/i, /soumettre ma candidature/i, /envoyer/i, /soumettre/i, /postuler/i];
    let submitted = false;
    for (const rx of needles) {
      const btn = page.getByRole("button", { name: rx }).first();
      if (await visible(btn, 1000)) {
        await clickResilient(btn, page);
        submitted = true;
        await page.waitForTimeout(4000); // Wait for submission
        
        // Check for captcha
        const hasCaptcha = await page.evaluate(() => {
          return !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="datadome"], iframe[title*="recaptcha" i]');
        });
        
        if (hasCaptcha) {
          if (waitCaptcha) {
            console.log("\\n⚠️ Captcha detected. Please solve it in the browser window...");
            await page.waitForFunction(() => {
              return !document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="datadome"], iframe[title*="recaptcha" i]');
            }, { timeout: 300000 }).catch(() => {});
            await page.waitForTimeout(4000);
            notes.push("✅ Submitted automatically (Captcha solved by user)");
          } else {
            notes.push("⚠️ Captcha appeared on submit. Skipped.");
            fs.appendFileSync(path.join(root, "output", "captcha_links.txt"), role.url + "\\n");
            submitted = false; // Revert since blocked
          }
        } else {
          notes.push("✅ Submitted automatically");
        }
        
        break;
      }
    }
    if (!submitted && !notes.some(n => n.includes("Skipped"))) {
      notes.push("⚠️ Could not find submit button");
    }
  }

  return { role, page, filled, notes, readback };
}

// ---------------------------------------------------------------------------
// Run the batch
// ---------------------------------------------------------------------------
// Sign in first. Without it the form is the register-and-apply variant, and
// only the first application of the batch could ever be submitted.
// Sign in on a throwaway tab of its own. Reusing an existing page would
// re-navigate it — and if that page was a prefilled application from an
// earlier run, the fill is silently wiped.
process.stdout.write(`\n🔐 Signing in as ${CANDIDATE.email} … `);
const authPage = await context.newPage();
const signedIn = await signIn(authPage);
console.log(signedIn ? "ok" : "FAILED");
await authPage.close().catch(() => {});
if (!signedIn) {
  console.log(
    "\n⚠️  Could not sign in. Each tab will show the register-and-apply form,\n" +
      "   where only the FIRST submission works. Fix the login before batching.\n",
  );
}

console.log(`\n🌐 Prefilling ${roles.length} Capgemini application(s)…\n`);

const done = [];
for (const role of roles) {
  process.stdout.write(`  #${String(role.tracker).padStart(2)} ${role.role.slice(0, 46)} … `);
  try {
    const result = await prefill(role);
    done.push(result);
    console.log(`${result.filled.length} field(s)`);
    if (flag("--verbose") && result.readback) {
      for (const [k, v] of Object.entries(result.readback)) {
        console.log(`        ${v ? "✓" : "·"} ${k}: ${v ?? "—"}`);
      }
    }
    for (const n of result.notes) console.log(`        ${n}`);
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
}

console.log("\n" + "=".repeat(70));
console.log(`✅ ${done.length} tab(s) prefilled and waiting for you.\n`);
console.log("Left blank on purpose — you decide each of these:");
for (const [field, why] of LEFT_BLANK) console.log(`  · ${field} — ${why}`);
console.log(`
The script has now automatically clicked Submit for you if it was not a dry run.
Check the terminal output above to verify if submission was successful.

When you have submitted a tab, say which one and I will mark the tracker:
  node set-status.mjs --row N Applied --on ${new Date().toISOString().slice(0, 10)}

Done with the window:
  node scripts/apply-capgemini.mjs --close
`);
console.log("=".repeat(70) + "\n");

// --exit-after N closes only the pages this run opened (selector testing).
// The detached browser itself is left alone — that is the point.
const exitAfter = value("--exit-after");
if (exitAfter) {
  await new Promise((r) => setTimeout(r, Number(exitAfter) * 1000));
  for (const r of done) await r.page.close().catch(() => {});
}
process.exit(0);
