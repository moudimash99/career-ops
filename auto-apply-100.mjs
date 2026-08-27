// DEPRECATED — do not run. Superseded by greenhouse-apply.mjs.
//
// The forceFill() below writes through the value setter, which Greenhouse's
// React form reverts ~500ms later. This script never read the fields back, so
// it clicked Submit on empty forms: 362 attempts, 345 failures, 3 real
// submissions (each logged 3x — the dedup is broken too).
//
// Use instead:
//   node greenhouse-apply.mjs --from-pipeline --plan-only
//   node greenhouse-apply.mjs --from-pipeline
// Its input is data/pipeline.md (the scanner's own output), not temp_urls.txt,
// which was a hand-made list and is now at data/temp_urls.archived.txt.

import { chromium } from 'playwright';
import fs from 'fs';

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
  resumePath: 'C:/Users/Moudimash99/Documents/Coding/career-ops/documents/Mohammad_CV_2_Parts.pdf'
};

const COVER_LETTER = `I bring direct Kubernetes, AWS, and cloud platform experience: I have provisioned EKS clusters with Terraform and Karpenter autoscaling, deployed via Helm and GitHub Actions CI/CD, and operated them with Prometheus/Grafana (24 dashboards, 35 alert rules, 98%+ SLA). My Systems Engineering background adds structured thinking — requirements, trade studies — to hands-on K8s delivery. I am excited to bring this rigorous approach and hands-on capability to your engineering team.`;

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

// Very robust field filler using heuristics
async function fillFormFields(page) {
  // Inputs & textareas
  const inputs = await page.$$('input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea, select');
  
  for (const input of inputs) {
    if (!(await input.isVisible().catch(() => false))) continue;
    
    const tagName = await input.evaluate(el => el.tagName.toLowerCase());
    const type = await input.getAttribute('type') || '';
    const name = (await input.getAttribute('name') || '').toLowerCase();
    const id = (await input.getAttribute('id') || '').toLowerCase();
    const ariaLabel = (await input.getAttribute('aria-label') || '').toLowerCase();
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    
    // Also try to find associated label
    let labelText = '';
    const idVal = await input.getAttribute('id');
    if (idVal) {
      const label = await page.$(`label[for="${idVal.replace(/"/g, '\\\\\\"')}"]`);
      if (label) labelText = (await label.textContent() || '').toLowerCase();
    }
    if (!labelText) {
      labelText = (await input.evaluate(el => {
         const lbl = el.closest('label');
         return lbl ? lbl.textContent : '';
      }) || '').toLowerCase();
      
      if (!labelText) {
         const container = await input.evaluateHandle(el => el.closest('.application-question, .application-field, .field, .form-group, .ashby-application-form-field, div[class*="field"]'));
         if (container) {
            try {
                const lbl = await container.$('label, span, div[class*="label"]');
                if (lbl) labelText = (await lbl.textContent() || '').toLowerCase();
            } catch(e) {}
         }
      }
    }
    
    const context = (`${name} ${id} ${ariaLabel} ${placeholder} ${labelText}`).replace(/_/g, ' ');
    
    if (tagName === 'select') {
      const options = await input.$$('option');
      let optionToSelect = null;
      let optionsData = [];
      for (let opt of options) {
         const text = (await opt.textContent() || '').toLowerCase();
         const val = await opt.getAttribute('value') || '';
         optionsData.push({text, val, opt});
      }
      
      // Heuristics for select
      if (context.includes('sponsor') || context.includes('visa')) {
         // I don't need sponsorship
         optionToSelect = optionsData.find(o => o.text.includes('no') || o.text.includes('not require') || o.text.includes('do not'));
      } else if (context.includes('gender') || context.includes('sex')) {
         optionToSelect = optionsData.find(o => o.text.includes('male') && !o.text.includes('female'));
      } else if (context.includes('veteran')) {
         optionToSelect = optionsData.find(o => o.text.includes('not a veteran') || o.text.includes('no'));
      } else if (context.includes('disability')) {
         optionToSelect = optionsData.find(o => o.text.includes('no') || o.text.includes('decline') || o.text.includes('wish not to answer'));
      } else if (context.includes('availability') || context.includes('start date') || context.includes('notice period')) {
         optionToSelect = optionsData.find(o => o.text.includes('immediately') || o.text.includes('asap') || o.text.includes('0') || o.text.includes('1'));
      } else if (context.includes('heard about') || context.includes('source')) {
         optionToSelect = optionsData.find(o => o.text.includes('linkedin') || o.text.includes('social') || o.text.includes('website'));
      } else if (context.includes('country') || context.includes('location')) {
         optionToSelect = optionsData.find(o => o.text.includes('france'));
      }
      
      // If we don't know, pick something reasonable (skip empty option)
      if (!optionToSelect) {
         optionToSelect = optionsData.find(o => o.val !== '' && !o.text.includes('select') && !o.text.includes('choose'));
      }
      
      if (optionToSelect) {
         await input.selectOption(optionToSelect.val).catch(()=>{});
      }
    }
    
    const contextStr = (tagName + ' ' + (await input.evaluate(el => el.id + ' ' + el.name + ' ' + el.placeholder)).toLowerCase()).replace(/_/g, ' ');
    
    // Skip irrelevant
    if (contextStr.includes('search') || contextStr.includes('bot')) {
      continue;
    }
    
    let valueToFill = null;
    let isDropdown = tagName === 'select' || await input.evaluate(el => el.getAttribute('role') === 'combobox' || el.className.includes('select__input'));
    
    if (contextStr.includes('first name') || contextStr.includes('firstname')) {
      valueToFill = P.firstName;
    } else if (contextStr.includes('last name') || contextStr.includes('lastname')) {
      valueToFill = P.lastName;
    } else if (contextStr.includes('name') && !contextStr.includes('company')) {
      valueToFill = P.fullName;
    } else if (contextStr.includes('email')) {
      valueToFill = P.email;
    } else if (contextStr.includes('phone') || contextStr.includes('mobile')) {
      valueToFill = P.phone;
    } else if (contextStr.includes('linkedin')) {
      valueToFill = P.linkedin;
    } else if (contextStr.includes('portfolio') || contextStr.includes('website') || contextStr.includes('github')) {
      valueToFill = P.portfolio;
    } else if (contextStr.includes('company') || contextStr.includes('employer')) {
      valueToFill = P.currentCompany;
    } else if (contextStr.includes('location') || contextStr.includes('city') || contextStr.includes('address')) {
      valueToFill = P.location;
    } else if (tagName === 'textarea' || contextStr.includes('cover letter') || contextStr.includes('additional') || contextStr.includes('why') || contextStr.includes('describe')) {
      valueToFill = COVER_LETTER;
    } else if (contextStr.includes('availability') || contextStr.includes('notice period') || contextStr.includes('start date')) {
      valueToFill = "ASAP";
    } else if (contextStr.includes('salary') || contextStr.includes('compensation') || contextStr.includes('expect')) {
      valueToFill = "44000";
    } else if (contextStr.includes('sponsor') || contextStr.includes('visa')) {
      valueToFill = "No";
    } else if (contextStr.includes('country')) {
      valueToFill = "France";
    } else if (contextStr.includes('gender') || contextStr.includes('sex')) {
      valueToFill = "Male";
    } else if (contextStr.includes('race') || contextStr.includes('ethni')) {
      valueToFill = "White";
    } else if (contextStr.includes('veteran')) {
      valueToFill = "No";
    } else if (contextStr.includes('disab')) {
      valueToFill = "No";
    } else {
      valueToFill = isDropdown ? null : "N/A";
    }
    
    if (valueToFill && isDropdown) {
      if (tagName === 'select') {
         const matchVal = await input.evaluate((sel, val) => {
            for (let opt of sel.options) {
               if (opt.text.toLowerCase().includes(val.toLowerCase()) || 
                   (val === 'No' && opt.text.toLowerCase().includes('not '))) {
                  return opt.value;
               }
            }
            return null;
         }, valueToFill);
         if (matchVal) await input.selectOption(matchVal).catch(()=>{});
      } else {
         try {
            await input.click({force: true});
            await input.fill('');
            const typeVal = (valueToFill === 'N/A' || !valueToFill) ? 'no' : valueToFill;
            await input.fill(typeVal);
            await page.waitForTimeout(400);
            await page.keyboard.press('Enter');
            
            // if still empty, try arrow down
            const currentVal = await input.evaluate(el => el.value);
            if (!currentVal) {
               await input.click({force: true});
               await page.waitForTimeout(300);
               await page.keyboard.press('ArrowDown');
               await page.waitForTimeout(300);
               await page.keyboard.press('Enter');
            }
         } catch(e) {}
      }
    } else if (valueToFill) {
      await forceFill(input, valueToFill);
    }
  }

  // Radios and Checkboxes
  const checks = await page.$$('input[type="radio"], input[type="checkbox"]');
  // Group by name
  let grouped = {};
  for (const c of checks) {
     if (!(await c.isVisible().catch(()=>false))) continue;
     const name = await c.getAttribute('name');
     if (!name) continue;
     if (!grouped[name]) grouped[name] = [];
     grouped[name].push(c);
  }
  
  for (const name in grouped) {
     const items = grouped[name];
     let clicked = false;
     for (const c of items) {
        const id = await c.getAttribute('id');
        let labelText = '';
        if (id) {
           const label = await page.$(`label[for="${id.replace(/"/g, '\\\\\\"')}"]`);
           if (label) labelText = (await label.textContent() || '').toLowerCase();
        }
        if (!labelText) {
           labelText = (await c.evaluate(el => {
              const lbl = el.closest('label');
              return lbl ? lbl.textContent : '';
           }) || '').toLowerCase();
        }
        
        // General questions
        if (labelText.includes('no') || labelText.includes('do not require') || labelText.includes('male') || labelText.includes('not a veteran')) {
           try { await c.check({force: true}); clicked = true; break; } catch(e){}
        } else if (labelText.includes('i agree') || labelText.includes('consent') || labelText.includes('accept') || labelText.includes('acknowledge') || labelText.includes('certify')) {
           try { await c.check({force: true}); clicked = true; } catch(e){}
        }
     }
     
     if (!clicked && items.length > 0) {
        // Just pick the last one usually it's "Decline to answer" or something safe, or first one
        try { await items[items.length - 1].check({force: true}); } catch(e){}
     }
  }
    // Upload resume
    const fileInputs = await page.$$('input[type="file"]');
    for (const f of fileInputs) {
       try {
          await f.setInputFiles(P.resumePath);
       } catch(e) {}
    }
  }

async function run() {
  const urls = fs.readFileSync('temp_urls.txt', 'utf8').split('\n').map(l => l.trim()).filter(l => l.length > 0);
  console.log(`Loaded ${urls.length} URLs to process.`);
  
  const browser = await chromium.launch({ 
     headless: false, 
     args: ['--disable-blink-features=AutomationControlled'] 
  });
  const context = await browser.newContext({ viewport: null });
  
  let appliedCount = 0;
  
  for (let i = 0; i < urls.length; i++) {
    if (appliedCount >= 10) break;
    const url = urls[i];
    console.log(`[${i+1}/${urls.length}] processing ${url}`);
// Remove it from file so we don't process again
    const remaining = urls.slice(i + 1);
    fs.writeFileSync('temp_urls.txt', remaining.join('\n'));
    
    const page = await context.newPage();
    try {
      await Promise.race([
        (async () => {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);
          
          // Look for an apply button if not on application page
          const applyBtnSelectors = [
             'a[href*="application"]', 'a[href*="apply"]', 'button:has-text("Apply")', 'a:has-text("Apply")'
          ];
          let onForm = false;
          if (await page.$('input[name="name"], input[name="email"], input[id*="name"], input[id*="email"]')) {
             onForm = true;
          }

      
      if (!onForm) {
         for (const sel of applyBtnSelectors) {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible()) {
               await btn.click();
               await page.waitForTimeout(4000);
               break;
            }
         }
      }
      
      // If we are redirected to workday or login, skip
      const currentUrl = page.url();
      if (currentUrl.includes('login') || currentUrl.includes('signIn')) {
         console.log("  -> Skipped: Requires login.");
         await page.close();
         return;
      }
      
      // Captcha detection - removed the skip here, let's see if we can still fill
      
      await fillFormFields(page);
      
      // Let it stabilize
      await page.waitForTimeout(2000);
      
      // Submit
      const submitBtns = await page.$$('button#submit_app, input#submit_app, button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")');
      if (submitBtns && submitBtns.length > 0) {
         const submitBtn = submitBtns[submitBtns.length - 1]; // Always click the one at the bottom!
         await submitBtn.click({force: true});
         await page.waitForTimeout(5000); // wait for submission to go through
         
         // check if success
         const currentUrl = page.url().toLowerCase();
         const successHeader = await page.$('h1:has-text("Thank you"), h1:has-text("Application submitted"), h1:has-text("Success"), h2:has-text("Thank you"), h2:has-text("Application submitted")');
         let statusStr = '';
         
         if (currentUrl.includes('/success') || currentUrl.includes('/thanks') || currentUrl.includes('/thank-you') || successHeader) {
            statusStr = "SUCCESS";
         } else {
            const errorText = await page.evaluate(() => {
               const errs = document.querySelectorAll('.error-message, .asterisk, .required-error, [aria-invalid="true"], .application-error');
               return errs.length > 0;
            });
            if (errorText) {
               console.log("  -> FAILED: Form validation error (missing required field or invalid format).");
            } else {
               console.log("  -> FAILED: Captcha or unknown block.");
               statusStr = "UNKNOWN";
            }
         }
         
         if (statusStr === 'SUCCESS') {
            console.log(`  -> ${statusStr}: Application submitted.`);
            appliedCount++;
            fs.appendFileSync('data/auto-applied.md', `- [${statusStr}] ${url}\n`);
         }
         try {
            const safeUrl = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
            const screenshotName = `data/screenshots/${Date.now()}_${statusStr || 'FAILED'}_${safeUrl}.png`;
            await page.screenshot({ path: screenshotName, fullPage: true });
         } catch(e) {}
      } else {
         console.log("  -> FAILED: Could not find submit button.");
      }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Global job timeout')), 60000))
      ]);
    } catch(e) {
      console.log(`  -> ERROR: ${e.message.split('\n')[0]}`);
    }
    
    await page.close().catch(()=>{});
  }
  
  await browser.close();
  console.log(`\nFinished auto-applying. Total successful submissions: ${appliedCount}`);
}

run();
