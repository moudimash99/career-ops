import { chromium } from 'playwright';

// ── Candidate profile ──
const P = {
  fullName: 'Mohammad Machaka',
  firstName: 'Mohammad',
  lastName: 'Machaka',
  email: 'machaka.mohammad@gmail.com',
  phone: '+33 7 53 37 78 23',
  location: 'Toulouse, France',
  linkedin: 'https://linkedin.com/in/mohammad-machaka-a63685172',
  portfolio: 'https://machaka.net',
  currentCompany: 'Airbus Electric Center',
  currentTitle: 'Systems & Quality Engineering Intern',
};

// ── Cover letters ──
const CL = {
  '055': `I bring direct Kubernetes and cloud platform experience: at Green Praxis I provisioned EKS clusters with Terraform and Karpenter autoscaling, deployed via Helm and GitHub Actions CI/CD, and operated them with Prometheus/Grafana (24 dashboards, 35 alert rules, 98%+ SLA). My ISAE-SUPAERO Systems Engineering training adds structured thinking — requirements, ICDs, trade studies — to hands-on K8s delivery. I'm eager to contribute to Scaleway's Kubernetes product.`,
  '056': `I bring direct Earth Observation experience from Green Praxis, where I built 15+ Airflow DAGs for satellite imagery ingestion (Sentinel-2, Landsat-8 via STAC) — boosting throughput 6x to 48 scenes/hour. My ISAE-SUPAERO MS SEN gives me MBSE rigour and my current Airbus thesis internship means I already understand Airbus processes, tools, and culture.`,
  '057': `I hold the AWS Solutions Architect – Associate (SAA-C03) and have production experience provisioning EKS clusters, Terraform modules (VPC, IAM, S3), and GitOps CI/CD on AWS. At Green Praxis I designed and operated AWS infrastructure serving real-time geospatial APIs with 95% critical-path observability coverage and 98%+ pipeline SLA.`,
  '058': `With AWS certification and production experience across EKS, Terraform, Docker, Helm, and multi-cloud fundamentals, I've architected infrastructure for data-intensive platforms end to end. My ISAE-SUPAERO Systems Engineering training adds structured architecture thinking. The junior scope matches my experience level perfectly.`,
  '060': `I've built production cloud-native platforms with full DevOps ownership — Terraform IaC, Kubernetes, Docker, Helm, CI/CD, Prometheus/Grafana. At Green Praxis I cut API P95 latency by 63% and deployed 24 observability dashboards. My AWS SAA-C03 and ISAE-SUPAERO MS SEN combine hands-on delivery with formal engineering rigour.`,
};

// ── Force-fill: set value via JS, bypassing hCaptcha overlay ──
async function forceFill(el, value) {
  await el.evaluate((input, val) => {
    // Use native setter to trigger React/framework bindings
    const proto = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, val);
    else input.value = val;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }, value);
}

// ── Find + fill a field by label text ──
async function fillField(page, labelText, value) {
  if (!value) return false;
  try {
    // Strategy 1: label[for] → input
    const labels = await page.$$('label');
    for (const label of labels) {
      const text = (await label.textContent() || '').trim();
      if (!text.toLowerCase().includes(labelText.toLowerCase())) continue;

      const forAttr = await label.getAttribute('for');
      if (forAttr) {
        const input = await page.$(`#${CSS.escape(forAttr)}`);
        if (input && await input.isVisible().catch(() => false)) {
          await forceFill(input, value);
          console.log(`  ✓ ${labelText}`);
          return true;
        }
      }
      // Strategy 2: sibling input in same container
      const container = await label.evaluateHandle(el =>
        el.closest('.application-question, .application-field, .field, .form-group') || el.parentElement
      );
      if (container) {
        const input = await container.$('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]), textarea');
        if (input && await input.isVisible().catch(() => false)) {
          await forceFill(input, value);
          console.log(`  ✓ ${labelText}`);
          return true;
        }
      }
    }

    // Strategy 3: aria-label / placeholder
    for (const sel of [
      `input[aria-label*="${labelText}" i]`,
      `input[placeholder*="${labelText}" i]`,
      `textarea[aria-label*="${labelText}" i]`,
      `textarea[placeholder*="${labelText}" i]`,
    ]) {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        await forceFill(el, value);
        console.log(`  ✓ ${labelText} (via attr)`);
        return true;
      }
    }
  } catch (e) {
    console.log(`  ✗ ${labelText}: ${e.message.split('\n')[0]}`);
    return false;
  }
  console.log(`  – ${labelText}: not found`);
  return false;
}

// ── Fill Lever form ──
async function fillLever(page, coverLetter) {
  await page.waitForTimeout(3000);

  // Fill all text fields
  await fillField(page, 'Full name', P.fullName);
  await fillField(page, 'name', P.fullName);
  await fillField(page, 'Email', P.email);
  await fillField(page, 'email', P.email);
  await fillField(page, 'Phone', P.phone);
  await fillField(page, 'phone', P.phone);
  await fillField(page, 'Location', P.location);
  await fillField(page, 'Current company', P.currentCompany);
  await fillField(page, 'Current title', P.currentTitle);
  await fillField(page, 'LinkedIn', P.linkedin);
  await fillField(page, 'Website', P.portfolio);
  await fillField(page, 'Portfolio', P.portfolio);
  await fillField(page, 'GitHub', '');

  // Fill any visible empty textarea (cover letter / additional info)
  try {
    const textareas = await page.$$('textarea');
    for (const ta of textareas) {
      if (await ta.isVisible().catch(() => false)) {
        const current = await ta.evaluate(el => el.value);
        if (!current) {
          await forceFill(ta, coverLetter);
          console.log('  ✓ Cover letter / additional info');
          break;
        }
      }
    }
  } catch (e) { console.log(`  – Cover letter: ${e.message.split('\n')[0]}`); }

  // Report unfilled items
  console.log('\n  ── You need to complete: ──');
  const fileInputs = await page.$$('input[type="file"]');
  if (fileInputs.length) console.log(`  📎 Upload your CV PDF (${fileInputs.length} upload field)`);
  console.log('  ☐ Tick any checkboxes (privacy consent, etc.)');
  console.log('  🔒 Solve hCaptcha');
  console.log('  🚀 Click Submit');
}

// ── Handle Workday: click Apply, detect login ──
async function handleWorkday(page, company) {
  try {
    const applyBtn = await page.$('a[data-automation-id="jobPostingApplyButton"]');
    if (applyBtn) {
      console.log(`  Clicking Apply...`);
      await applyBtn.click();
      await page.waitForTimeout(5000);
    }

    const url = page.url();
    const hasLogin = await page.$('input[data-automation-id="signInPasswordInput"], [data-automation-id="createAccountLink"], a:has-text("Create Account")');
    if (hasLogin || url.includes('login') || url.includes('signIn') || url.includes('createAccount')) {
      return 'needs-login';
    }

    // If we're on the form already, try to fill basic fields
    return await fillWorkdayForm(page, company);
  } catch (e) {
    console.log(`  ⚠️ ${e.message.split('\n')[0]}`);
    return 'error';
  }
}

// ── Fill Workday form fields (My Information step) ──
async function fillWorkdayForm(page, company) {
  try {
    // Workday uses data-automation-id attributes
    const fields = {
      'legalNameSection_firstName': P.firstName,
      'legalNameSection_lastName': P.lastName,
      'email': P.email,
      'phone-number': P.phone,
      'addressSection_addressLine1': P.location,
    };

    let filled = 0;
    for (const [autoId, value] of Object.entries(fields)) {
      const el = await page.$(`input[data-automation-id="${autoId}"], input[data-automation-id*="${autoId}"]`);
      if (el && await el.isVisible().catch(() => false)) {
        // Workday needs real keystrokes, not just value setting
        await el.click({ force: true }).catch(() => {});
        await el.selectText().catch(() => {});
        await el.type(value, { delay: 30 });
        filled++;
        console.log(`  ✓ ${autoId}`);
      }
    }
    return filled > 0 ? 'filled' : 'form-detected';
  } catch (e) {
    return 'form-detected';
  }
}

// ── Jobs ──
const JOBS = [
  { report: '055', company: 'Scaleway', role: 'K8s Specialist', ats: 'lever',
    url: 'https://jobs.lever.co/scaleway/cbfc06ed-28cc-4248-9ef6-d5b2e0bb7a0d/apply' },
  { report: '056', company: 'Airbus', role: 'EO Ground Segment Maintenance Engineer', ats: 'workday',
    url: 'https://ag.wd3.myworkdayjobs.com/Airbus/job/Toulouse-Area/Earth-Observation-Ground-Segment-Maintenance-Engineer--m-f-_JR10435417' },
  { report: '057', company: 'Accenture', role: 'Ingénieur Cloud AWS certifié', ats: 'workday',
    url: 'https://accenture.wd103.myworkdayjobs.com/AccentureCareers/job/Paris/Ingnieur-Cloud-AWS--certifi--F-H_R00308305' },
  { report: '058', company: 'Accenture', role: 'Cloud Architect Junior', ats: 'workday',
    url: 'https://accenture.wd103.myworkdayjobs.com/AccentureCareers/job/Paris/Infrastructure---Cloud-Architect-Junior-F-H_R00341732' },
  { report: '060', company: 'Accenture', role: 'Ingénieur DevOps Cloud', ats: 'workday',
    url: 'https://accenture.wd103.myworkdayjobs.com/AccentureCareers/job/Paris/Ingnieur-DevOps-Cloud-H-F_R00350452' },
];

// ── Main ──
console.log('═══════════════════════════════════════════════════');
console.log(' career-ops apply — 5 applications');
console.log(' SUBMIT IS ALWAYS YOURS.');
console.log('═══════════════════════════════════════════════════\n');

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'], slowMo: 50 });
const context = await browser.newContext({ viewport: null });

const results = [];

for (let i = 0; i < JOBS.length; i++) {
  const job = JOBS[i];
  console.log(`▶ [${i+1}/5] ${job.company} — ${job.role} (${job.ats.toUpperCase()})`);

  const page = await context.newPage();
  try {
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log(`  Loaded: ${await page.title()}`);

    if (job.ats === 'lever') {
      await fillLever(page, CL[job.report]);
      results.push({ ...job, status: 'filled' });
    } else {
      const status = await handleWorkday(page, job.company);
      results.push({ ...job, status });
    }
  } catch (e) {
    console.log(`  ⚠️ Error: ${e.message.split('\n')[0]}`);
    results.push({ ...job, status: 'error' });
  }
  console.log('');
}

// ── Summary ──
console.log('═══════════════════════════════════════════════════');
console.log(' RESULTS:');
for (const r of results) {
  const icon = r.status === 'filled' ? '✅'
    : r.status === 'needs-login' ? '🔑'
    : r.status === 'form-detected' ? '📋'
    : '⚠️';
  const action = r.status === 'filled' ? 'Upload CV, checkboxes, captcha → Submit'
    : r.status === 'needs-login' ? 'Log in / create account first'
    : r.status === 'form-detected' ? 'Form open — fill manually or tell me to continue'
    : 'Check the tab';
  console.log(` ${icon} ${r.company} — ${r.role}: ${action}`);
}
console.log('');
console.log(' Remember: I NEVER submit. You press Submit.');
console.log('═══════════════════════════════════════════════════');

// Keep browser open
process.stdin.resume();
