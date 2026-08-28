import { getActivePage } from './browser-engine.mjs';
import fs from 'fs';
import path from 'path';

/**
 * Tier 3: Visual Validator (Eye in the Sky)
 * Uses a free-tier Multimodal API to validate the state of the form before submission.
 */
async function validateForm() {
  console.log('[Tier 3] Taking screenshot for validation...');
  
  const { page, browser } = await getActivePage();
  const screenshotDir = path.join(process.cwd(), 'scratch');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
  
  const screenshotPath = path.join(screenshotDir, 'validation.jpg');
  await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 50 });
  await browser.close();
  
  console.log(`[Tier 3] Screenshot saved to ${screenshotPath}`);

  if (!process.env.GEMINI_API_KEY) {
    console.error('❌ [Tier 3] GEMINI_API_KEY environment variable is not set. Cannot run visual validation.');
    console.error('Bypassing Tier 3. Treat result as manually VALID for now, but do not automate SUBMIT.');
    process.exit(1);
  }

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    console.log('[Tier 3] Asking Gemini to evaluate the screenshot...');
    const prompt = "You are an expert QA tester validating a job application form before submission. Review the screenshot. Are there any visually apparent red validation errors, or empty mandatory fields? If it is perfectly ready to submit, reply ONLY with 'VALID'. Otherwise, briefly describe the error so the agent can fix it.";
    
    const imagePart = {
      inlineData: {
        data: Buffer.from(fs.readFileSync(screenshotPath)).toString("base64"),
        mimeType: "image/jpeg"
      }
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = result.response.text().trim();
    
    console.log('\n--- [Tier 3 Validation Report] ---');
    console.log(response);
    console.log('----------------------------------\n');
  } catch (err) {
    console.error(`❌ [Tier 3] API Error: ${err.message}`);
    process.exit(1);
  }
}

validateForm().catch(console.error);
