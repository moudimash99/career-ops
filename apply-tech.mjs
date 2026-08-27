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
};

// ── Cover letters mapped to the tech jobs from Claude's shortlist ──
const CL = {
  veepee: "My profile bridges SRE and data engineering. At Green Praxis, I owned the reliability of a data-intensive platform (15+ Airflow DAGs, EKS, Terraform, Prometheus/Grafana, 98%+ SLA). I'm eager to bring my AWS/Kubernetes production experience and systems-engineering discipline to Veepee's DataPlatform.",
  pennylane: "I specialize in building reliable, high-throughput data pipelines. At Green Praxis, I built 15+ Airflow DAGs for geospatial ingestion, boosting throughput 6x, and at Airbus I designed HR reporting ETLs across 5 regions that cut deployment time by 80%. I'd love to bring this data modeling and orchestration expertise to Pennylane.",
  scaleway_obj: "I have strong experience with distributed storage and performance optimization. At Green Praxis, I rebuilt an on-demand API serving geospatial tiles, cutting storage footprint by 80% and latency by 63%. With a background in C++ optimization (ZAKA) and systems engineering, I'm well-equipped to tackle Scaleway's Object Storage challenges.",
  owkin: "I build production-grade cloud platforms with formal engineering rigour. At Green Praxis, I designed and operated an AWS/EKS platform with full GitOps CI/CD and observability. My systems engineering training at ISAE-SUPAERO emphasizes the safety and reliability required in mission-critical domains, making Owkin's healthcare AI mission a perfect fit.",
  scaleway_net: "I build and operate resilient cloud-native platforms. At Green Praxis, I provisioned EKS clusters via Terraform, managed deployments with Helm, and monitored them using Prometheus/Grafana (24 dashboards, 35 alerts). I'm excited to bring my DevOps expertise and systems-engineering rigour to Scaleway's Network Products."
};

const JOBS = [
  { id: 'veepee', company: 'Veepee', role: 'SRE - DataPlatform', url: 'https://jobs.lever.co/veepee/ad8cec40-3e68-4ea3-bace-f6ceb53c4809/apply' },
  { id: 'pennylane', company: 'Pennylane', role: 'Senior Data Engineer', url: 'https://jobs.ashbyhq.com/pennylane/88b4a6e4-85cd-4179-ad4e-5ca2445adc18/application' },
  { id: 'scaleway_obj', company: 'Scaleway', role: 'System Engineer (Object Storage)', url: 'https://jobs.lever.co/scaleway/270db387-a296-436f-a6ed-b90260bfbfac/apply' },
  { id: 'owkin', company: 'Owkin', role: 'Senior Software Engineer (Platform)', url: 'https://jobs.ashbyhq.com/owkin/2ed52b8a-8786-4013-b018-52a732f6550b/application' },
  { id: 'scaleway_net', company: 'Scaleway', role: 'SRE - Network Products', url: 'https://jobs.lever.co/scaleway/bfcb228c-ed27-42b0-a799-d6bf0b93acd8/apply' }
];

async function forceFill(el, value) {
  await el.evaluate((input, val) => {
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, val);
    else input.value = val;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }, value);
}

async function fillStandardFields(page, coverLetter) {
  const fieldsToFill = [
    { regex: /^first name$/i, val: P.firstName },
    { regex: /^last name$/i, val: P.lastName },
    { regex: /^(full name|name)$/i, val: P.fullName },
    { regex: /^email( address)?$/i, val: P.email },
    { regex: /^phone( number)?$/i, val: P.phone },
    { regex: /^(location|city)$/i, val: P.location },
    { regex: /^(current )?company$/i, val: P.currentCompany },
    { regex: /^linkedin( profile)?( url)?$/i, val: P.linkedin },
    { regex: /^(website|portfolio)( url)?$/i, val: P.portfolio }
  ];

  // Helper to check if we already filled an input to avoid overwriting
  const filledInputs = new Set();

  for (const field of fieldsToFill) {
    let matched = false;
    
    // Strategy 1: Find by label
    const labels = await page.$$('label');
    for (const label of labels) {
      const text = (await label.textContent() || '').trim().replace(/\*/g, ''); // remove required asterisks
      if (field.regex.test(text)) {
        const forAttr = await label.getAttribute('for');
        let input;
        
        if (forAttr) {
          input = await page.$(`[id="${forAttr}"]`);
        }
        
        if (!input) {
          // fallback to container search
          const container = await label.evaluateHandle(el => el.closest('.application-question, .application-field, .field, .form-group, .ashby-application-form-field') || el.parentElement);
          if (container) {
            input = await container.$('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]), textarea');
          }
        }

        if (input && await input.isVisible().catch(()=>false)) {
          const inputId = await input.evaluate(el => el.id || el.name || el.outerHTML);
          if (!filledInputs.has(inputId)) {
            await forceFill(input, field.val);
            filledInputs.add(inputId);
            matched = true;
            break;
          }
        }
      }
    }
    
    // Strategy 2: placeholders/aria-labels if not matched
    if (!matched) {
      const inputs = await page.$$('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]), textarea');
      for (const input of inputs) {
        const ph = await input.getAttribute('placeholder') || '';
        const aria = await input.getAttribute('aria-label') || '';
        if (field.regex.test(ph.trim()) || field.regex.test(aria.trim())) {
          const inputId = await input.evaluate(el => el.id || el.name || el.outerHTML);
          if (!filledInputs.has(inputId) && await input.isVisible().catch(()=>false)) {
            await forceFill(input, field.val);
            filledInputs.add(inputId);
            matched = true;
            break;
          }
        }
      }
    }
  }

  // Cover letter text area
  const textareas = await page.$$('textarea');
  for (const ta of textareas) {
    if (await ta.isVisible().catch(()=>false)) {
      const current = await ta.evaluate(el => el.value);
      if (!current) {
        await forceFill(ta, coverLetter);
        break;
      }
    }
  }
}

(async () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(' career-ops apply — 5 Tech Company Applications');
  console.log(' (Veepee, Pennylane, Scaleway, Owkin)');
  console.log('═══════════════════════════════════════════════════\n');

  let browser;
  try {
    // Try to use the system chrome to ensure it pops up in the user's session
    browser = await chromium.launch({ headless: false, args: ['--start-maximized'], channel: 'chrome' });
  } catch (e) {
    // Fallback to bundled chromium
    browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  }
  
  const context = await browser.newContext({ viewport: null });
  
  for (let i = 0; i < JOBS.length; i++) {
    const job = JOBS[i];
    console.log(`▶ Opening [${i+1}/5] ${job.company} - ${job.role}...`);
    const page = await context.newPage();
    await page.goto(job.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500); // give the form time to render
    
    await fillStandardFields(page, CL[job.id]);
    try {
      const fileInputs = await page.$$('input[type="file"]');
      if (fileInputs.length > 0) {
        // usually the first file input is for the resume
        await fileInputs[0].setInputFiles('C:/Users/Moudimash99/Documents/Coding/career-ops/documents/Mohammad_CV_2_Parts.pdf');
        console.log('  📎 CV PDF uploaded automatically.');
      }
    } catch (e) {
      console.log('  ⚠️ Could not upload CV automatically: ' + e.message.split('\n')[0]);
    }
    console.log(`  ✅ Fields populated. Left for you: Check boxes, Captcha, Submit.`);
  }
  
  console.log('\nAll 5 tech tabs open! Browser will stay open until you close it.');
  
  // Keep alive
  process.stdin.resume();
})();
