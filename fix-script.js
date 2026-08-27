const fs = require('fs');
let code = fs.readFileSync('auto-apply-100.mjs', 'utf8');

const target = `      if (optionToSelect) {
         await input.selectOption(optionToSelect.val).catch(()=>{});
      }
    }
    
    const contextStr = (tagName + ' ' + (await input.evaluate(el => el.id + ' ' + el.name + ' ' + el.placeholder)).toLowerCase()).replace(/_/g, ' ');
    
    // Skip irrelevant
    if (contextStr.includes('search') || contextStr.includes('bot')) {
      continue;
    }`;

const replacement = `      if (optionToSelect) {
         try { await input.selectOption(optionToSelect.val); } catch(e) {}
         continue;
      }
      
      const context = (tagName + ' ' + (await input.evaluate(el => el.id + ' ' + el.name + ' ' + el.placeholder)).toLowerCase()).replace(/_/g, ' ');
      
      // Skip irrelevant
      if (context.includes('search') || context.includes('bot')) {
         continue;
      }`;

code = code.replace(target, replacement);
fs.writeFileSync('auto-apply-100.mjs', code);
