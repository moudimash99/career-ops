// Plain words for one browser tool call, for the person approving it in the watch window
// (control.mjs). Also decides which calls only READ the page (they pass without asking).

const READ_ONLY = new Set([
  'browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests',
  'browser_network_request', 'browser_wait_for', 'browser_find',
]);
// Helper scripts that only read the page or register helpers (see lib/freemotion-browser/).
const READ_ONLY_FILES = /(^|[\\/])(setup|read-form|check)\.js$/;
// A bare read of the helpers' results: () => window.__fmInv.inventory
const READ_EXPR = /^\s*\(\)\s*=>\s*window\.__fm\w*(\.\w+)*\s*;?\s*$/;

// Page code that calls nothing that clicks, types, moves, navigates or writes into the page only reads it.
const MUTATES = /\.(click|dblclick|fill|type|press|pressSequentially|check|uncheck|selectOption|setInputFiles|setChecked|dispatchEvent|focus|blur|hover|tap|dragTo|goto|reload|goBack|goForward|remove|removeChild|appendChild|prepend|append|replaceWith|insertAdjacent\w*|setAttribute|removeAttribute|submit|requestSubmit|scrollIntoView|scrollTo|scrollBy|addScriptTag|addInitScript|exposeFunction|route|close|bringToFront|setContent|setViewportSize)\s*\(|\.(value|checked|innerHTML|innerText|textContent|outerHTML|src|href|selected|disabled|hidden|className|style)\s*=(?!=)|\bkeyboard\.|\bmouse\.|\bfetch\(|XMLHttpRequest|location\s*=|window\.open|\beval\(|\bFunction\(|localStorage|sessionStorage|document\.cookie\s*=/;
export const readsOnly = (code) => !MUTATES.test(String(code ?? ''));

export function needsApproval(tool, args = {}) {
  if (READ_ONLY.has(tool)) return false;
  if (tool === 'browser_tabs') return args.action !== 'list';
  if (tool === 'browser_run_code_unsafe' && args.filename && !args.code) return !READ_ONLY_FILES.test(args.filename);
  if (tool === 'browser_run_code_unsafe' && args.code && readsOnly(args.code)) return false;
  if (tool === 'browser_evaluate' && !args.element && !args.ref && !args.target && readsOnly(args.function)) return false;
  return true;
}

const q = (s, n = 90) => `"${String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)}"`;
const base = (p) => String(p ?? '').split(/[\\/]/).pop();

// What a tool call will do, in plain words, plus warnings worth a look before approving.
export function describe(tool, args = {}) {
  const warn = [];
  let text;
  switch (tool) {
    case 'browser_click': text = `${args.doubleClick ? 'Double-click' : args.button === 'right' ? 'Right-click' : 'Click'} ${q(args.element || args.target || args.ref)}`; break;
    case 'browser_type': text = `Type ${q(args.text, 200)} into ${q(args.element || args.target || args.ref)}${args.submit ? ', then press Enter' : ''}`; break;
    case 'browser_fill_form': text = 'Fill in: ' + (args.fields ?? []).map((f) => `${q(f.name, 50)} = ${q(f.value, 120)}`).join('; '); break;
    case 'browser_select_option': text = `Choose ${[].concat(args.values ?? []).map((v) => q(v)).join(', ')} in ${q(args.element || args.target || args.ref)}`; break;
    case 'browser_press_key': text = `Press the key ${args.key}`; break;
    case 'browser_file_upload': text = args.paths?.length ? `Upload the file ${[].concat(args.paths).map(base).join(', ')}` : 'Close the file window without uploading'; break;
    case 'browser_navigate': text = `Open the page ${args.url}`; break;
    case 'browser_navigate_back': text = 'Go back to the previous page'; break;
    case 'browser_hover': text = `Move the mouse over ${q(args.element || args.target || args.ref)}`; break;
    case 'browser_drag': case 'browser_drop': text = `Drag ${q(args.startElement)} onto ${q(args.endElement)}`; break;
    case 'browser_handle_dialog': text = `Answer the pop-up with ${args.accept ? 'OK' : 'Cancel'}${args.promptText ? ` and the text ${q(args.promptText)}` : ''}`; break;
    case 'browser_tabs': text = `${args.action === 'select' ? 'Switch to' : args.action === 'close' ? 'Close' : args.action === 'new' ? 'Open a new' : args.action} tab${args.index != null ? ` ${args.index}` : ''}`; break;
    case 'browser_close': text = 'Close the browser'; break;
    case 'browser_resize': text = `Resize the window to ${args.width}×${args.height}`; break;
    case 'browser_snapshot': text = 'Read the page'; break;
    case 'browser_take_screenshot': text = 'Take a screenshot'; break;
    case 'browser_wait_for': text = args.text ? `Wait for the text ${q(args.text)}` : `Wait ${args.time ?? ''} s`; break;
    case 'browser_console_messages': case 'browser_network_requests': case 'browser_network_request': text = 'Read the page\'s technical log'; break;
    case 'browser_find': text = `Look for ${q(args.text ?? args.query ?? '')} on the page`; break;
    case 'browser_run_code_unsafe':
      if (args.filename && !args.code && READ_ONLY_FILES.test(args.filename)) {
        text = /check\.js$/.test(args.filename) ? 'Check the form (required fields, errors)' : /read-form\.js$/.test(args.filename) ? 'Read the form\'s fields' : 'Load the helper scripts';
        break;
      }
      if (args.filename && !args.code) {
        if (/submit\.js$/.test(args.filename)) { text = 'SEND THE APPLICATION: click the form\'s final send / submit button'; warn.push('This sends the application.'); }
        else text = `Run the helper script ${base(args.filename)}`;
        break;
      }
      if (readsOnly(args.code)) { text = 'Read something on the page (page code that changes nothing)'; break; }
      ({ text } = summarizeCode(String(args.code ?? ''), warn));
      break;
    case 'browser_evaluate':
      if (READ_EXPR.test(String(args.function ?? ''))) { text = 'Read the form\'s field list'; break; }
      if (readsOnly(args.function)) { text = 'Read something on the page (page code that changes nothing)'; break; }
      ({ text } = summarizeCode(String(args.function ?? ''), warn));
      break;
    default: text = `${tool.replace(/^browser_/, '')} ${JSON.stringify(args).slice(0, 150)}`;
  }
  if (/^browser_(click|type|select_option|hover)$/.test(tool) && !(args.element || args.target || args.ref)) {
    text = `${text.replace(/\s*""$/, '')} (agy did not say on what: the browser will refuse this request)`;
    warn.push(`Malformed request (${Object.keys(args).join(', ') || 'no arguments'}): nothing will happen in the page.`);
  }
  if (/\b(envoyer|submit|postuler|apply|send|valider|soumettre)\b/i.test(text) && !warn.length && tool !== 'browser_navigate') warn.push('This button may send the application.');
  return { text, warn };
}

// Page code, one plain step per action it performs.
export function summarizeCode(code, warn = []) {
  const vars = {};
  const steps = [];
  // A quoted string, escapes included ('Non, je ne souhaite pas m\'exprimer'); group 2 is its text.
  const S = String.raw`(['"\x60])((?:\\.|(?!\1).)*)\1`;
  const str = (before, after = '') => new RegExp(before + S + after);
  const unq = (x) => String(x ?? '').replace(/\\(.)/g, '$1');
  const label = (expr) => {
    let m;
    if ((m = expr.match(/getByRole\(\s*['"`][^'"`]*['"`]\s*,\s*\{\s*name:\s*(?:(['"`])((?:\\.|(?!\1).)*)\1|\/(.*?)\/\w*)/))) return q(unq(m[2] ?? m[3]));
    if ((m = expr.match(str(String.raw`getBy(?:Text|Label|Placeholder|Role|TestId|Title|AltText)\(\s*`)))) return q(unq(m[2]));
    if ((m = expr.match(str(String.raw`locator\(\s*`)))) return `the element ${unq(m[2])}`;
    if ((m = expr.match(str(String.raw`getElementById\(\s*`)))) return `the element #${unq(m[2])}`;
    if ((m = expr.match(str(String.raw`querySelector(?:All)?\(\s*`)))) return `the element ${unq(m[2])}`;
    if ((m = expr.match(/\b(\w+)\.(?:fill|pressSequentially|type|click|check|uncheck|selectOption|focus|dispatchEvent|setInputFiles|first|nth|last)\(/)) && vars[m[1]]) return vars[m[1]];
    return 'an element';
  };
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const d = line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(.*)$/);
    if (d && /getBy|locator|querySelector|getElementById/.test(d[2]) && !/\.(fill|click|type|check|press)/.test(d[2])) { vars[d[1]] = label(d[2]); continue; }
    let m;
    if ((m = line.match(str(String.raw`keyboard\.press\(\s*`)))) { steps.push(`press ${unq(m[2])}`); continue; }
    if ((m = line.match(str(String.raw`keyboard\.type\(\s*`)))) { steps.push(`type ${q(unq(m[2]), 150)}`); continue; }
    if ((m = line.match(str(String.raw`\.(?:fill|pressSequentially|type)\(\s*`)))) { steps.push(`type ${q(unq(m[2]), 150)} into ${label(line)}`); continue; }
    if ((m = line.match(str(String.raw`\.selectOption\(\s*`)))) { steps.push(`choose ${q(unq(m[2]))} in ${label(line)}`); continue; }
    if ((m = line.match(str(String.raw`\.setInputFiles\(\s*`)))) { steps.push(`upload ${base(unq(m[2]))}`); continue; }
    if (/\.check\(/.test(line)) { steps.push(`tick ${label(line)}`); continue; }
    if (/\.uncheck\(/.test(line)) { steps.push(`untick ${label(line)}`); continue; }
    if (/dispatchEvent\(\s*['"`]click/.test(line)) { steps.push(`click ${label(line)} (by code)`); warn.push('Clicks with code instead of a real click.'); continue; }
    if (/\.click\(/.test(line)) { steps.push(`click ${label(line)}${/force:\s*true/.test(line) ? ' (forced)' : ''}`); continue; }
    if (/\.(value|checked)\s*=/.test(line)) { steps.push('set a value directly with code'); warn.push('Sets a field directly with code: the page may not register it, and it can fill hidden fields.'); continue; }
    if (/page\.evaluate\(/.test(line) && !steps.includes('run code inside the page')) steps.push('run code inside the page');
    if (/\.goto\(/.test(line)) { const u = line.match(/goto\(\s*(['"`])(.*?)\1/); steps.push(`open ${u ? u[2] : 'a page'}`); }
  }
  // "press ArrowDown, press ArrowDown, press Enter" → one step
  const merged = [];
  for (const s of steps) {
    const last = merged[merged.length - 1];
    if (s.startsWith('press ') && last?.startsWith('press ')) merged[merged.length - 1] = `${last}, ${s.slice(6)}`;
    else merged.push(s);
  }
  if (merged.some((s) => /press .*Arrow(Down|Up)/.test(s))) warn.push('Picks an option by its position (arrow keys) without reading it.');
  if (/input\[type=["']?checkbox["']?\]['"`]\)/.test(code) && /\.click\(/.test(code)) warn.push('Clicks every checkbox on the page, not one named box.');
  const text = merged.length ? `Page code: ${merged.join('; ')}` : 'Page code (no recognisable action: open "show code")';
  return { text, warn: [...new Set(warn)] };
}
