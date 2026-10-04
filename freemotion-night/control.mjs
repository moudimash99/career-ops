#!/usr/bin/env node
// node freemotion-night/control.mjs --job <N> [--port 4777] [--since <ISO>]
//
// The watch window for one WATCH=1 job (run.sh starts it and opens it in your browser):
//   - what agy does, in plain words, as it happens: its "Next / Why" lines, each browser action,
//     what came back, and its screenshots;
//   - the action waiting for you (browser-gate.mjs holds every input into the page) with
//     [Continue], [Don't do it + a message to agy] and [Stop];
//   - the same log, kept as plain text in tmp/fm/night/watch-<N>.log.
// Stop ends agy's session at once (its browser closes with it) and records the job as stopped.
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { networkInterfaces } from 'os';
import { createServer } from 'http';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { findConversation, readSteps } from './agy-transcript.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tmp', 'fm', 'gate');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const JOB = arg('--job');
const PORT = Number(arg('--port', process.env.WATCH_PORT || 4777));
// --host 0.0.0.0 (run.sh: WATCH_HOST=lan): reachable from other machines on the network. Then every
// request needs the secret key from the printed link, since the page can approve and stop the run.
const HOST = arg('--host', process.env.WATCH_HOST === 'lan' ? '0.0.0.0' : '127.0.0.1');
const KEY = HOST === '127.0.0.1' ? '' : arg('--key', process.env.WATCH_KEY || randomBytes(12).toString('hex'));
// --keep: restart the window during a job without clearing what the gate is holding.
const KEEP = process.argv.includes('--keep');
const SINCE = Date.parse(arg('--since', new Date().toISOString()));
if (!JOB) { console.error('Usage: node freemotion-night/control.mjs --job <N> [--port 4777]'); process.exit(1); }

const sheet = readFileSync(join(ROOT, 'tmp', 'fm', 'night', `job-${JOB}.md`), 'utf8');
const URL_ = (sheet.match(/^ {3}(https?:\/\/\S+)/m) ?? [])[1] ?? '';
const TITLE = (sheet.match(new RegExp(String.raw`^\*\*(.+?)\*\*,[^\n]*number ${JOB}\b`, 'm')) ?? [])[1] ?? `job ${JOB}`;
const RUN = readFileSync(join(ROOT, 'tmp', 'fm', 'night', 'run-id'), 'utf8').trim();
const LOG = join(ROOT, 'tmp', 'fm', 'night', `watch-${JOB}.log`);
// The documents this job sends: its CV and its cover letter, linked in the window so the person can
// read what goes out. Both come from prepare-docs.mjs, which run.sh ran just before this job (tmp/fm/night/docs-<N>.json).
const made = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'tmp', 'fm', 'night', `docs-${JOB}.json`), 'utf8')); } catch { return null; } })();
const DOCS = {
  cv: { path: made?.cv?.path ?? (sheet.match(/^CV:\s*(.+\.pdf)\s*$/m) ?? [])[1]?.trim(), type: 'application/pdf' },
  letter: { path: made?.letter?.path ?? '', type: 'text/plain; charset=utf-8' },
};

// A fresh start for this job.
mkdirSync(DIR, { recursive: true });
// The previous job's record is kept, not deleted: tmp/fm/gate/archive/<time>-events.jsonl.
if (!KEEP && existsSync(join(DIR, 'events.jsonl'))) {
  mkdirSync(join(DIR, 'archive'), { recursive: true });
  renameSync(join(DIR, 'events.jsonl'), join(DIR, 'archive', `${new Date().toISOString().replace(/[:.]/g, '-')}-events.jsonl`));
}
if (!KEEP) for (const f of readdirSync(DIR)) if (/^(pending|decision)\.json$|^events\.jsonl$|^(shot|view)-\d+\.png$/.test(f)) unlinkSync(join(DIR, f));
let stopped = false;

const clock = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
const readJson = (f) => { try { return JSON.parse(readFileSync(join(DIR, f), 'utf8')); } catch { return null; } };

// Timeline: agy's own Next/Why lines (from its transcript) + the gate's calls, decisions, results, shots.
function timeline() {
  const items = [];
  const conv = findConversation(JOB, SINCE);
  if (conv) {
    for (const s of readSteps(conv)) {
      if (s.type !== 'PLANNER_RESPONSE' || !s.content) continue;
      for (const l of String(s.content).split('\n').map((x) => x.trim()).filter(Boolean)) {
        const m = l.match(/^NEXT:\s*(.*?)\s*(?:—|--|-)\s*WHY:\s*(.*)$/i);
        if (m) items.push({ t: s.created_at, kind: 'why', next: m[1], why: m[2] });
        else items.push({ t: s.created_at, kind: 'say', text: l.replace(/^SEEN:\s*/i, 'Saw on the page: ') });
      }
    }
  }
  let ev = [];
  try { ev = readFileSync(join(DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  items.push(...ev);
  return items.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}

function plain(items) {
  const out = [];
  for (const e of items) {
    const t = clock(e.t);
    if (e.kind === 'why') out.push(`${t}  agy: next, ${e.next}. Why: ${e.why}`);
    else if (e.kind === 'say') out.push(`${t}  agy: ${e.text}`);
    else if (e.kind === 'call') out.push(`${t}  ${e.gated ? 'ASKS YOU' : 'reads   '}  ${e.text}${(e.warn ?? []).map((w) => `\n          ⚠ ${w}`).join('')}`);
    else if (e.kind === 'decision') out.push(`${t}  you: ${e.action === 'continue' ? 'allowed it' : e.action === 'stop' ? 'STOPPED the run' : `refused it${e.text ? `, "${e.text}"` : ''}`}`);
    else if (e.kind === 'result') out.push(`          ${e.ok ? '✓' : '✗'} ${e.ok ? (e.text ? e.text.split('\n')[0].slice(0, 160) : 'done') : `failed: ${e.text.split('\n')[0].slice(0, 200)}`}`);
    else if (e.kind === 'shot') out.push(`          📷 ${e.file} (agy's screenshot)`);
    else if (e.kind === 'fresh') out.push(`          ↻ the gate showed agy the page as it is now: ${e.why}`);
  }
  return out;
}

let lastLog = '';
function state() {
  const items = timeline();
  const lines = plain(items);
  const text = `${TITLE}\n${URL_}\n\n${lines.join('\n')}\n`;
  if (text !== lastLog) { try { writeFileSync(LOG, text); } catch {} lastLog = text; }
  const shots = items.filter((e) => e.kind === 'shot').map((e) => e.file);
  const views = items.filter((e) => e.kind === 'view').map((e) => e.file);
  const lastWhy = [...items].reverse().find((e) => e.kind === 'why');
  const docs = Object.fromEntries(Object.entries(DOCS).map(([k, d]) => [k, !!d.path && existsSync(d.path)]));
  return { title: TITLE, url: URL_, job: JOB, stopped, pending: readJson('pending.json'), why: lastWhy ?? null, items, shots, views, docs };
}

function stopAll() {
  stopped = true;
  const p = readJson('pending.json');
  writeFileSync(join(DIR, 'decision.json'), JSON.stringify({ sig: p?.sig ?? '', action: 'stop' }));
  spawnSync('node', ['lib/freemotion-submissions.mjs', 'finalize', '--url', URL_, '--outcome', 'errored', '--run-id', RUN, '--notes', 'stopped by the person in the watch window; nothing sent after that point'], { cwd: ROOT });
  // agy's session, with its browser (the gate and Camoufox are its children).
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='agy.exe'" | Where-Object { $_.CommandLine -match 'job-${JOB}\\.md' } | ForEach-Object { taskkill /T /F /PID $_.ProcessId }`]);
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Watch: job ${JOB}</title><style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--mute:#6b6b66;--card:#fff;--line:#e3e2dc;--warn:#9a5b00;--warnbg:#fff4e0;--ok:#1d7a3a;--bad:#b42318;--accent:#2457c5}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mute:#a19f97;--card:#21211f;--line:#34332f;--warn:#f0b35a;--warnbg:#3a2a10;--ok:#5fc37f;--bad:#f07a6e;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,Segoe UI,sans-serif}
header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0;flex:1}#status{font-weight:600}
main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:16px;padding:16px 18px}
@media (max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
#ask{border:2px solid var(--accent);position:sticky;top:8px;z-index:2;box-shadow:0 4px 14px rgba(0,0,0,.12)}.sub{color:var(--mute);font-size:12px}#shot{position:sticky;top:8px;align-self:start}#ask.idle{border-color:var(--line)}#ask h2{margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}
#asktext{font-size:18px;font-weight:600;margin:4px 0 8px;overflow-wrap:anywhere}#askwhy{color:var(--mute);margin-bottom:8px}
.warn{background:var(--warnbg);color:var(--warn);border-radius:6px;padding:6px 10px;margin:6px 0;font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.go{background:var(--ok);color:#fff;border-color:var(--ok)}button.stop{background:var(--bad);color:#fff;border-color:var(--bad)}button:disabled{opacity:.4;cursor:default}
input[type=text]{flex:1;min-width:200px;font:inherit;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
details{margin-top:8px;color:var(--mute)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
#log{list-style:none;margin:0;padding:0}#log li{padding:6px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:64px 1fr;gap:8px}
#log .t{color:var(--mute);font-variant-numeric:tabular-nums}#log .why{color:var(--mute);font-style:italic}#log .asks{font-weight:600}
#log .ok{color:var(--ok)}#log .bad{color:var(--bad)}#log .you{color:var(--accent);font-weight:600}
#shot img{width:100%;border:1px solid var(--line);border-radius:6px;cursor:zoom-in}#shot p{color:var(--mute);margin:4px 0 0}
</style></head><body>
<header><h1 id="title"></h1><span id="docs"></span><span id="status"></span><button class="stop" id="stopall">Stop everything</button></header>
<main><section>
<div class="card idle" id="ask"><h2>Waiting for you</h2><div id="asktext">Nothing yet: agy is reading or thinking.</div><div id="askwhy"></div><div id="askwarn"></div>
<div class="row"><button class="go" id="go" disabled>Continue</button></div>
<div class="row"><input type="text" id="msg" placeholder="Or tell agy what to do instead…"><button id="skip" disabled>Don't do it, send this</button></div>
<details><summary>show the exact action</summary><pre id="raw"></pre></details></div>
<div class="card" style="margin-top:16px"><ul id="log"></ul></div></section>
<aside id="shot"><div class="card"><b>Page now</b> <span class="sub">(after your last OK, only for you)</span><div id="viewbox"><p>none yet</p></div></div>
<div class="card" style="margin-top:16px"><b>Last screenshot agy saw</b><div id="shotbox"><p>none yet</p></div></div></aside></main>
<script>
const K=location.search;let cur=null,lastSig=null,n=0;const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const time=t=>new Date(t).toLocaleTimeString('fr-FR',{timeZone:'Europe/Paris'});
function beep(){try{const a=new AudioContext(),o=a.createOscillator();o.frequency.value=660;o.connect(a.destination);o.start();o.stop(a.currentTime+.15)}catch(e){}}
async function decide(action){if(!cur&&action!=='stop')return;const text=$('msg').value.trim();
 await fetch('/decide'+K,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sig:cur?.sig??'',action,text})});$('msg').value='';tick()}
$('go').onclick=()=>decide('continue');$('skip').onclick=()=>decide('skip');
$('stopall').onclick=()=>{if(confirm('Stop agy now? Nothing more will be done in the browser.'))decide('stop')};
function row(e){const t='<span class="t">'+time(e.t)+'</span>';
 if(e.kind==='why')return t+'<span class="why">Next: '+esc(e.next)+'. Why: '+esc(e.why)+'</span>';
 if(e.kind==='say')return t+'<span class="why">agy: '+esc(e.text)+'</span>';
 if(e.kind==='call')return t+'<span class="'+(e.gated?'asks':'')+'">'+(e.gated?'Asked you: ':'Read: ')+esc(e.text)+(e.warn||[]).map(w=>'<div class="warn">⚠ '+esc(w)+'</div>').join('')+'</span>';
 if(e.kind==='decision')return t+'<span class="you">You '+(e.action==='continue'?'allowed it':e.action==='stop'?'stopped the run':'refused it'+(e.text?': “'+esc(e.text)+'”':''))+'</span>';
 if(e.kind==='result')return t+'<span class="'+(e.ok?'ok':'bad')+'">'+(e.ok?'✓ '+esc((e.text||'done').split('\\n')[0].slice(0,200)):'✗ failed: '+esc(e.text.split('\\n')[0].slice(0,240)))+'</span>';
 if(e.kind==='shot')return t+'<span>📷 agy took a screenshot <a href="/shot/'+e.file+K+'" target="_blank">open</a></span>';
 if(e.kind==='fresh')return t+'<span class="why">↻ agy hit a block ('+esc(e.why)+'): the gate showed it the page as it is now</span>';return t+'<span></span>'}
async function tick(){let s;try{s=await (await fetch('/state'+K)).json()}catch(e){$('status').textContent='window closed: the run has ended';return}
 $('title').textContent=s.title;cur=s.pending;
 $('status').textContent=s.stopped?'■ stopped':cur?'⏸ waiting for you':'▶ agy is working';document.title=(cur?'⏸ ':'')+'Watch: job '+s.job;
 $('ask').className='card'+(cur?'':' idle');$('go').disabled=$('skip').disabled=!cur||s.stopped;
 $('asktext').textContent=cur?cur.text:'Nothing to approve right now: agy is reading or thinking.';
 $('askwhy').textContent=cur&&s.why?'Why (agy): '+s.why.why:'';$('askwarn').innerHTML=(cur?.warn||[]).map(w=>'<div class="warn">⚠ '+esc(w)+'</div>').join('');
 $('raw').textContent=cur?JSON.stringify(cur.args,null,2):'';
 if(cur&&cur.sig!==lastSig)beep();lastSig=cur?.sig??null;
 $('docs').innerHTML=[['cv','CV'],['letter','Cover letter']].filter(([k])=>s.docs[k]).map(([k,l])=>'<a href="/doc/'+k+K+'" target="_blank">'+l+'</a>').join(' · ');
 if(s.items.length!==n){n=s.items.length;$('log').innerHTML=s.items.filter(e=>e.kind!=='view').reverse().map(e=>'<li>'+row(e)+'</li>').join('')}
 pic('viewbox',s.views[s.views.length-1]);pic('shotbox',s.shots[s.shots.length-1])}
function pic(box,f){if(!f||$(box).dataset.f===f)return;$(box).dataset.f=f;$(box).innerHTML='<a href="/shot/'+f+K+'" target="_blank"><img src="/shot/'+f+K+'"></a><p>'+f+'</p>'}
setInterval(tick,700);tick();
</script></body></html>`;

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (KEY && u.searchParams.get('k') !== KEY) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('Use the full link with its key (printed when the watch window started).'); return; }
  req.url = u.pathname;
  const doc = req.url.match(/^\/doc\/(cv|letter)$/);
  if (req.method === 'GET' && doc && DOCS[doc[1]].path && existsSync(DOCS[doc[1]].path)) {
    res.writeHead(200, { 'content-type': DOCS[doc[1]].type }); res.end(readFileSync(DOCS[doc[1]].path)); return;
  }
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
  if (req.method === 'GET' && req.url === '/state') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state())); return; }
  const shot = req.url.match(/^\/shot\/((?:shot|view)-\d+\.png)$/);
  if (req.method === 'GET' && shot && existsSync(join(DIR, shot[1]))) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(readFileSync(join(DIR, shot[1]))); return; }
  if (req.method === 'POST' && req.url === '/decide') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let d = {};
      try { d = JSON.parse(body); } catch {}
      if (d.action === 'stop') stopAll();
      else if (['continue', 'skip'].includes(d.action) && d.sig) writeFileSync(join(DIR, 'decision.json'), JSON.stringify({ sig: d.sig, action: d.action, text: String(d.text ?? '').slice(0, 1000) }));
      res.writeHead(204); res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, HOST, () => {
  console.log(`watch window: http://127.0.0.1:${PORT}/${KEY ? `?k=${KEY}` : ''}  (log: tmp/fm/night/watch-${JOB}.log)`);
  if (KEY) for (const a of Object.values(networkInterfaces()).flat()) if (a && a.family === 'IPv4' && !a.internal) console.log(`  from another machine: http://${a.address}:${PORT}/?k=${KEY}`);
});
setInterval(state, 2000); // keep the log file current even when the window is closed
