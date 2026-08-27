// capture-capgemini-jds.mjs — save each shortlisted posting's text to jds/
// ---------------------------------------------------------------------------
// The batch evaluator wrote boilerplate reports with no JD content, so most
// shortlisted roles have nothing to tailor a cover letter against. This pulls
// the real posting text and stores it as jds/{tracker}-capgemini-{slug}.md,
// referenced elsewhere as local:jds/{file} per the project convention.
//
// Read-only against the site: it loads the public posting and never touches
// the apply flow.
//
// Usage: node scripts/capture-capgemini-jds.mjs [--only 17,28] [--force]
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const shortlist = JSON.parse(
  fs.readFileSync(path.join(root, "data", "capgemini-shortlist.json"), "utf8"),
);
const jdsDir = path.join(root, "jds");
const profileDir = path.join(root, ".capgemini-session");
const CDP_URL = "http://127.0.0.1:9222";

const argv = process.argv.slice(2);
const onlyArg = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const force = argv.includes("--force");

let roles = shortlist.roles;
if (onlyArg) {
  const want = onlyArg.split(",").map((n) => Number(n.trim()));
  roles = roles.filter((r) => want.includes(r.tracker));
}

const slug = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

async function cdpAlive() {
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function getContext() {
  if (!(await cdpAlive())) {
    spawn(
      chromium.executablePath(),
      [
        "--remote-debugging-port=9222",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !(await cdpAlive())) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const browser = await chromium.connectOverCDP(CDP_URL);
  return browser.contexts()[0];
}

fs.mkdirSync(jdsDir, { recursive: true });
const ctx = await getContext();
const results = [];

for (const role of roles) {
  const file = `${String(role.tracker).padStart(3, "0")}-capgemini-${slug(role.role)}.md`;
  const dest = path.join(jdsDir, file);
  if (fs.existsSync(dest) && !force) {
    console.log(`  #${String(role.tracker).padStart(2)} skip (already captured)`);
    results.push({ tracker: role.tracker, file, cached: true });
    continue;
  }

  process.stdout.write(`  #${String(role.tracker).padStart(2)} ${role.role.slice(0, 42)} … `);
  const page = await ctx.newPage();
  try {
    await page.goto(role.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const text = await page.evaluate(() => {
      const main = document.querySelector('[class*="jobdescription"], main') || document.body;
      return main.innerText.replace(/\n{3,}/g, "\n\n").trim();
    });
    // Trim the site chrome: start at the first real JD heading when present.
    const i = text.search(/vos missions|description du poste|votre profil|missions/i);
    const body = i > -1 ? text.slice(i) : text;

    fs.writeFileSync(
      dest,
      `# ${role.role} — Capgemini ${role.location}\n\n` +
        `**URL:** ${role.url}\n` +
        `**Captured:** ${new Date().toISOString().slice(0, 10)}\n\n---\n\n${body}\n`,
      "utf8",
    );
    console.log(`${body.length} chars → jds/${file}`);
    results.push({ tracker: role.tracker, file, chars: body.length });
  } catch (err) {
    console.log(`failed: ${err.message}`);
    results.push({ tracker: role.tracker, error: err.message });
  } finally {
    await page.close().catch(() => {});
  }
}

const ok = results.filter((r) => !r.error).length;
console.log(`\n${ok}/${results.length} JD(s) available in jds/.`);
process.exit(0);
