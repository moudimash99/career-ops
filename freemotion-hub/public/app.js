/* Free Motion Control — the page. One state object, one render, one click handler.
   The data comes from the hub (/api/v1/changes), which keeps what each machine's agent sends; every number
   on every page is computed from those records, so the same number reads the same everywhere. Buttons send
   commands to the machine and show as done only once the machine says so. */
(function () {
  'use strict';
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  // ---- Vocabulary: each term is defined once ---------------------------------------------------
  const RESULTS = {
    sent: { label: 'Sent', tone: 'ok', desc: 'The site confirmed the application.' },
    duplicate: { label: 'Already applied', tone: 'neutral', desc: 'An earlier application to this posting was found.' },
    closed: { label: 'Posting closed', tone: 'neutral', desc: 'The posting was gone or no longer took applications.' },
    unfit: { label: 'Not a fit', tone: 'neutral', desc: 'The posting turned out not to fit: an internship, another country, a hard requirement.' },
    blocked: { label: 'Blocked', tone: 'warn', desc: 'A CAPTCHA or a bot wall stopped the driver.' },
    failed: { label: 'Failed', tone: 'bad', desc: 'The form could not be completed, or nothing confirmed it.' },
    stopped: { label: 'Stopped by you', tone: 'neutral', desc: 'You stopped the job.' },
  };
  const RESULT_ORDER = ['sent', 'duplicate', 'closed', 'unfit', 'blocked', 'failed', 'stopped'];
  const RETRYABLE = { blocked: 1, failed: 1, stopped: 1 };
  const ENDED = {
    finished: { label: 'Finished', tone: 'ok', note: 'It went through its list.' },
    stopped: { label: 'Stopped by you', tone: 'neutral', note: 'You asked it to stop.' },
    nodriver: { label: 'No driver left', tone: 'warn', note: 'Every driver was out, so it stopped.' },
    empty: { label: 'Pool was empty', tone: 'neutral', note: 'There was nothing to apply to.' },
    interrupted: { label: 'Cut off', tone: 'bad', note: 'It ended without finishing: the PC restarted, slept, or the run was killed.' },
    running: { label: 'Running', tone: 'info', note: 'Running now.' },
  };
  const SEV = {
    critical: { label: 'Critical', tone: 'bad', icon: 'xcircle', rank: 0 },
    warning: { label: 'Warning', tone: 'warn', icon: 'triangle', rank: 1 },
    info: { label: 'Info', tone: 'info', icon: 'info', rank: 2 },
  };
  const WINDOWS = [
    { k: 'five', label: '5-hour window', col: '5-hour' },
    { k: 'week', label: 'Weekly allowance', col: 'Week' },
    { k: 'month', label: 'Monthly credits', col: 'Month' },
  ];
  const ARMS = {
    cv: { generic: 'Standard CV', loose: 'Tailored, light', strict: 'Tailored, close' },
    letter: { none: 'No letter', short: 'Short letter', full: 'Full letter' },
  };
  const WRITERS = { 'gemini-web': 'the Gemini website', 'chatgpt-web': 'the ChatGPT website', codex: 'codex', agy: 'agy', sonnet1: 'Claude (account 1)', copilot: 'copilot' };
  const DRIVER_NAMES = { hellowork: 'HelloWork script', unknown: '—' };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const POSITIVE = { Responded: 1, Assessment: 1, Interview: 1, Offer: 1, Hired: 1 };
  // How far an application got (data/reactions.tsv, written by inbox-replies.py), lowest first.
  // "Rejected" is kept apart: a call, then a no, still reached the call.
  const LEVELS = [['viewed', 'Viewed', 'neutral', 'A platform or the employer says the application was opened'], ['contacted', 'Contacted', 'info', 'A person wrote: still open? available? let’s talk'],
    ['call', 'Call', 'info', 'A call with a recruiter took place or is set'], ['assessment', 'Assessment', 'info', 'A test or a screening, after someone looked at the application'],
    ['interview', 'Interview', 'ok', 'An interview with the team, a manager or the client'], ['offer', 'Offer', 'ok', 'An offer']];
  const LEVEL = Object.fromEntries(LEVELS.map(([k, label, tone, tip], i) => [k, { label, tone, tip, rank: i + 1 }]));
  LEVEL.rejected = { label: 'Rejected', tone: 'neutral', tip: 'A definite no', rank: 0 };
  // Not a reaction: an automatic test or questionnaire sent right after applying. Shown because it is still to do.
  LEVEL.screening = { label: 'Screening to do', tone: 'warn', tip: 'An automatic test or questionnaire sent within a week of applying, the same for everyone. Part of applying, not a reaction.', rank: 0 };
  const NOT_ANSWER = { viewed: 1, screening: 1 };
  const lrank = (l) => (LEVEL[l] ? LEVEL[l].rank : 0);
  const lpill = (l) => pill((LEVEL[l] || LEVEL.rejected).tone, (LEVEL[l] || { label: l }).label, (LEVEL[l] || {}).tip);
  // One key per company, so "JEMS", "Jems SAS" and "JEMS Group" meet in one place.
  const ckey = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').replace(/\b(sas|sasu|sa|sarl|group|groupe|france|recrutement)\b/g, ' ').replace(/\s+/g, ' ').trim();
  /** What came back for a sent job: when the first answer and the first positive one came, and the furthest step. */
  function answerOf(j) {
    const r = j.reply;
    if (!r) return { level: '', rejected: false, first: null, firstPos: null };
    const evs = r.history.filter((h) => h.to !== 'Applied').map((h) => ({ at: h.at, pos: !!POSITIVE[h.to], rej: h.to === 'Rejected' }))
      .concat(r.reactions.filter((x) => !NOT_ANSWER[x.level]).map((x) => ({ at: new Date(x.date + 'T12:00').getTime(), pos: lrank(x.level) >= lrank('contacted'), rej: x.level === 'rejected' })));
    const first = evs.length ? Math.min(...evs.map((e) => e.at)) : null, pos = evs.filter((e) => e.pos);
    return { level: r.level, rejected: evs.some((e) => e.rej), first, firstPos: pos.length ? Math.min(...pos.map((e) => e.at)) : null };
  }
  /** One cell: the furthest step, else Rejected, else nothing yet. */
  const replyCell = (j) => { if (!isSent(j)) return '<span class="muted">—</span>'; const a = answerOf(j); return a.level ? lpill(a.level) : a.rejected ? lpill('rejected') : '<span class="muted nowrap">No answer yet</span>'; };
  const coLink = (name) => `<button type="button" class="link" data-act="openCompany" data-arg="${esc(name)}">${esc(name)}</button>`;

  // ---- Icons -----------------------------------------------------------------------------------
  const IC = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    pulse: 'M3 12h4l3-8 4 16 3-8h4',
    queue: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    table: 'M4 5h16v14H4zM4 10h16M10 10v9',
    runs: 'M4 4v6h6M20 20v-6h-6M5.6 15a7 7 0 0 0 12.2 2.4L20 14M4 10l2.3-3.3A7 7 0 0 1 18.4 9',
    chart: 'M4 20V11M10 20V5M16 20v-6M2 20h20',
    cpu: 'M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
    bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
    clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
    x: 'M18 6 6 18M6 6l12 12',
    menu: 'M4 6h16M4 12h16M4 18h16',
    check: 'M20 6 9 17l-5-5',
    triangle: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16v-4M12 8h.01',
    xcircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15 9l-6 6M9 9l6 6',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M19 12l-7 7-7-7',
    left: 'M15 18l-6-6 6-6',
    right: 'M9 18l6-6-6-6',
    play: 'M7 4.5v15l12-7.5z',
    stop: 'M6 6h12v12H6z',
    skip: 'M5 5l9 7-9 7zM18 5v14',
    ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.7 5.7l12.6 12.6',
    undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    mail: 'M4 5h16v14H4zM4 7l8 6 8-6',
    retry: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
    scan: 'M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 12h10',
    plus: 'M12 5v14M5 12h14',
    flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
    file: 'M14 3H6v18h12V7zM14 3v4h4',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
    wifi: 'M2 8.8a15 15 0 0 1 20 0M5 12.6a10 10 0 0 1 14 0M8.5 16.4a5 5 0 0 1 7 0M12 20h.01',
    ext: 'M14 4h6v6M10 14 20 4M19 14v6H4V5h6',
  };
  const icon = (n, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[n]}"/></svg>`;

  // ---- Formatting ------------------------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('en-GB');
  const num = (x) => nf.format(Math.round(x));
  const pct = (a, b, d) => (b ? (100 * a / b).toFixed(d || 0) + '%' : '—');
  const pad = (x) => String(x).padStart(2, '0');
  const hhmm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const sod = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayLabel = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const shortDay = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  function when(t) {
    if (!t) return '—';
    const today = sod(Date.now()), d = sod(t);
    if (d === today) return 'Today ' + hhmm(t);
    if (d === today - DAY) return 'Yesterday ' + hhmm(t);
    if (d === today + DAY) return 'Tomorrow ' + hhmm(t);
    if (Math.abs(d - today) < 6 * DAY) return DAYS[new Date(t).getDay()] + ' ' + hhmm(t);
    return dayLabel(t) + ', ' + hhmm(t);
  }
  function dur(mins) {
    mins = Math.max(0, mins);
    if (mins < 1) return Math.round(mins * 60) + ' s';
    if (mins < 60) return Math.round(mins) + ' min';
    if (mins < 48 * 60) { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return h + ' h ' + pad(m === 60 ? 59 : m); }
    return Math.round(mins / 1440) + ' days';
  }
  function ago(t) {
    const m = (Date.now() - t) / MIN;
    if (m < 0) return 'in ' + dur(-m);
    if (m < 1) return 'just now';
    return dur(m) + ' ago';
  }
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600);
    return (h ? h + ':' + pad(Math.floor(s / 60) % 60) : Math.floor(s / 60)) + ':' + pad(s % 60);
  }
  const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const plural = (n, one, many) => num(n) + ' ' + (n === 1 ? one : (many || one + 's'));
  const fitText = (f) => (f == null ? '—' : f.toFixed(1));
  const drvName = (d) => DRIVER_NAMES[d] || d;
  const writer = (w) => WRITERS[w] || w || 'an unknown writer';
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const sum = (a) => a.reduce((x, y) => x + y, 0);

  // ---- Data from the hub -----------------------------------------------------------------------
  let theme = 'system';
  try { theme = localStorage.getItem('fm-theme') || 'system'; } catch (e) { /* storage off */ }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const DB = { rev: 0, t: {}, machines: [], commands: new Map(), me: '', loaded: false, error: null, lastOk: 0 };
  const table = (t) => (DB.t[t] || (DB.t[t] = new Map()));

  // Snoozes are per viewer: they hide an alert here for a day and change nothing on the machine.
  let snoozes = {};
  try { snoozes = JSON.parse(localStorage.getItem('fm-snooze') || '{}'); } catch (e) { snoozes = {}; }
  const saveSnoozes = () => { try { localStorage.setItem('fm-snooze', JSON.stringify(snoozes)); } catch (e) { /* storage off */ } };

  const S = {
    route: 'overview', machine: null,
    jobs: [], runs: [], queue: [], tasks: [], pool: [], poolTotal: 0, drivers: [], alerts: [], scans: [], replies: [], reactions: [], activity: [],
    prefs: { roundSize: 50, work: { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }, blacklist: [] }, pd: null, burn: false, burnRaw: {}, flags: {},
    run: { state: 'idle' },
    f: {
      apps: { q: '', range: '30d', results: [], reply: '', site: '', driver: '', run: '', sort: 'start', dir: -1, page: 1, size: 25 },
      runs: { range: '30d' }, results: { range: '30d', lv: 'positive' },
      alerts: { tab: 'open', sev: '', sel: [] }, activity: { actor: '', q: '' }, queue: { tab: 'next' },
    },
    ui: { nav: false, blInput: '', chart: {}, errors: {}, compact: window.innerWidth < 640, files: {} },
    drawer: null, dd: null, modal: null, toasts: [],
  };

  async function pull() {
    try {
      const r = await fetch('/api/v1/changes?since=' + DB.rev, { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 403) { DB.error = 'signin'; render(); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.full) DB.t = {};
      for (const x of j.records) { const m = table(x.t); const id = x.m + '|' + x.k; if (x.x) m.delete(id); else m.set(id, Object.assign({ _m: x.m }, x.d)); }
      for (const c of j.commands) { const prev = DB.commands.get(c.id); DB.commands.set(c.id, c); onCommand(c, prev); }
      DB.machines = j.machines; DB.me = j.me; DB.rev = j.rev; DB.error = null; DB.lastOk = Date.now();
      const changed = j.records.length || j.commands.length || !DB.loaded;
      DB.loaded = true;
      if (changed) { derive(); refresh(); } else { $('#side').innerHTML = vSide(); updateClocks(); }
    } catch (e) {
      DB.error = 'network';
      $('#side').innerHTML = vSide();
    }
  }

  function derive() {
    const ms = DB.machines.slice().sort((a, b) => b.lastSeen - a.lastSeen);
    const liveOf = (m) => [...table('live').values()].find((x) => x._m === m);
    // The machine the controls talk to: the one running a round, else the one seen last.
    const running = ms.find((m) => (liveOf(m.machine) || {}).state && liveOf(m.machine).state !== 'idle');
    S.machine = (running || ms[0] || {}).machine || null;
    const M = S.machine;
    const mine = (t) => [...table(t).values()].filter((x) => x._m === M);
    const setting = (k) => table('setting').get(M + '|' + k) || null;

    const burn = setting('burn') || {}, bl = setting('blacklist') || { list: [] };
    S.flags = setting('flags') || {};
    S.tasks = (setting('tasks') || { list: [] }).list.filter((x) => x.next && x.next > Date.now() - MIN);
    S.burnRaw = burn;
    S.burn = !!burn.enabled;
    const prefs = { roundSize: burn.round_jobs || 50, work: Object.assign({ days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' }, burn.work || {}), blacklist: bl.list.map((b) => b.company), blRows: bl.list };
    const dirty = S.pd && JSON.stringify(draftOf(S.pd)) !== JSON.stringify(draftOf(S.prefs));
    S.prefs = prefs;
    if (!S.pd || !dirty) S.pd = clone(prefs);

    // Replies: the tracker's status changes, tied to a posting by its URL.
    const replies = mine('reply');
    const byUrl = new Map();
    const orank = (o) => ({ interview: 3, positive: 2, rejected: 1 }[o] || 0);
    const entry = (url) => byUrl.get(url) || byUrl.set(url, { outcome: null, outcomeAt: null, history: [], level: '', reactions: [] }).get(url);
    const reach = (cur, o, at) => { if (o && orank(o) >= orank(cur.outcome)) { cur.outcome = o; cur.outcomeAt = at; } };
    for (const r of replies) {
      if (!r.url) continue;
      const at = new Date(r.date + 'T12:00').getTime(), cur = entry(r.url);
      cur.history.push({ to: r.to, at, source: r.source });
      reach(cur, r.to === 'Rejected' ? 'rejected' : r.to === 'Interview' || r.to === 'Offer' || r.to === 'Hired' ? 'interview' : POSITIVE[r.to] ? 'positive' : null, at);
    }
    S.replies = replies.filter((r) => r.to !== 'Applied' && r.url).sort((a, b) => (a.date < b.date ? 1 : -1));
    // Reactions: the furthest each application got, read from the employers' emails or told by you.
    S.reactions = mine('reaction').sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    for (const x of S.reactions.slice().reverse()) {
      if (!x.url) continue;
      const at = new Date(x.date + 'T12:00').getTime(), cur = entry(x.url);
      cur.reactions.push(x);
      if (lrank(x.level) > lrank(cur.level)) cur.level = x.level;
      reach(cur, x.level === 'rejected' ? 'rejected' : lrank(x.level) >= lrank('interview') ? 'interview' : lrank(x.level) >= lrank('contacted') ? 'positive' : null, at);
    }

    // Rounds: a job belongs to the round that printed its line.
    const rounds = mine('round').sort((a, b) => a.start - b.start);
    const roundOf = new Map();
    for (const r of rounds) for (const n of r.jobs || []) roundOf.set(n, r.id);
    S.jobs = mine('job').map((j) => Object.assign({}, j, { uid: j._m + ':' + j.id, round: roundOf.get(j.id) || null, reply: j.result === 'sent' ? byUrl.get(j.url) || null : null }));
    const jobsByRound = new Map();
    for (const j of S.jobs) if (j.round) { if (!jobsByRound.has(j.round)) jobsByRound.set(j.round, []); jobsByRound.get(j.round).push(j); }
    S.runs = rounds.map((r) => {
      const rj = jobsByRound.get(r.id) || [];
      const end = r.end || (rj.length ? Math.max(...rj.map((j) => j.end)) : r.start);
      return Object.assign({}, r, { end: r.ended === 'running' ? null : end, ended: r.ended || 'finished' });
    });

    // The run in hand.
    const L = liveOf(M) || { state: 'idle' };
    const cur = S.runs.find((r) => r.ended === 'running');
    S.run = { state: L.state === 'running' ? (L.job ? 'running' : 'choosing') : L.state === 'between' ? 'between' : cur ? 'choosing' : 'idle',
      id: cur ? cur.id : L.round || null, start: cur ? cur.start : null, by: cur ? cur.by : null, planned: L.planned || (cur && cur.planned) || 0,
      done: cur ? (jobsByRound.get(cur.id) || []).length : 0, current: L.job ? L : null, stopAfter: !!(S.flags.stop || S.flags.stopNight), live: L };
    S.run.lastRun = S.runs.filter((r) => r.ended !== 'running').slice(-1)[0] || null;
    const skip = new Set(S.flags.skip || []);
    S.queue = (L.queue || []).map((q) => Object.assign({}, q, { key: q.url, skipped: skip.has(q.url) }));
    const pool = table('pool').get(M + '|pool') || { items: [], total: 0 };
    const list = table('pool').get(M + '|list') || { items: [] };
    const inList = new Set(list.items.map((x) => x.url));
    S.pool = (pool.items || []).filter((x) => !inList.has(x.url));
    S.poolTotal = pool.total || 0;
    S.poolAt = pool.at || null;

    // Drivers.
    S.drivers = mine('driver').sort((a, b) => (a.priority || 99) - (b.priority || 99) || a.listed - b.listed);

    // Alerts: resolved ones from the inbox stay a week; snoozes are this viewer's.
    const now = Date.now();
    S.alerts = mine('alert').map((a) => {
      const sn = snoozes[a.id];
      const state = a.state === 'open' && sn && sn > now ? 'snoozed' : a.state;
      return Object.assign({}, a, { state, snoozeUntil: state === 'snoozed' ? sn : null, last: a.last || a.first || 0, first: a.first || a.last || 0 });
    }).filter((a) => a.state !== 'resolved' || !a.last || now - a.last < 30 * DAY);

    S.scans = mine('scan').sort((a, b) => b.at - a.at);

    // Activity: what the logs said, and every command anyone sent.
    const acts = mine('event').map((e) => ({ t: e.t, actor: e.actor || 'System', text: e.text, run: e.run || null }));
    for (const c of DB.commands.values()) {
      if (c.machine !== M || c.action === 'read') continue;
      acts.push({ t: c.created, actor: 'You', text: cmdLabel(c) + (c.status === 'done' ? '' : ' · ' + statusWord(c)), by: c.by, cmd: c });
    }
    S.activity = acts.filter((a) => a.t).sort((a, b) => b.t - a.t);
  }

  // ---- Commands --------------------------------------------------------------------------------
  const local = new Map();   // command id → { label, undo, quiet }
  function online() { const m = DB.machines.find((x) => x.machine === S.machine); return !!(m && m.online); }
  function machineState() {
    const m = DB.machines.find((x) => x.machine === S.machine);
    if (!m) return { ok: false, text: 'No machine has connected yet' };
    return m.online ? { ok: true, text: m.machine.toUpperCase() + ' online' } : { ok: false, text: m.machine.toUpperCase() + ' offline since ' + when(m.lastSeen) };
  }
  async function command(action, args, o) {
    o = o || {};
    if (!online()) { toast('The PC is offline. Nothing was sent.', { tone: 'bad' }); return null; }
    try {
      const r = await fetch('/api/v1/commands', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machine: S.machine, action, args }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      local.set(j.id, o);
      DB.commands.set(j.id, { id: j.id, machine: S.machine, action, args, status: 'queued', message: '', by: DB.me, created: Date.now(), updated: Date.now() });
      if (!o.quiet) toast((o.label || cmdLabel({ action, args })) + ': sent to the PC', { tone: 'info' });
      derive(); render();
      setTimeout(pull, 400);
      return j.id;
    } catch (e) { toast('Could not send it: ' + e.message, { tone: 'bad' }); return null; }
  }
  function onCommand(c, prev) {
    const o = local.get(c.id);
    if (!o || (prev && prev.status === c.status)) return;
    if (c.status === 'done') {
      if (o.onDone) o.onDone(c);
      if (!o.quiet) toast(c.message || 'Done', { undo: o.undo || null });
      local.delete(c.id);
    } else if (c.status === 'failed' || c.status === 'cancelled') {
      if (o.onFail) o.onFail(c);
      toast((o.label || cmdLabel(c)) + ' did not work: ' + (c.message || c.status), { tone: 'bad' });
      local.delete(c.id);
    }
  }
  const OPEN = { queued: 1, sent: 1, running: 1 };
  /** The newest unfinished command for this action (and argument match), if any. */
  function pending(action, match) {
    let best = null;
    for (const c of DB.commands.values()) if (c.machine === S.machine && c.action === action && OPEN[c.status] && (!match || match(c.args || {})) && (!best || c.created > best.created)) best = c;
    return best;
  }
  const statusWord = (c) => ({ queued: 'waiting for the PC', sent: 'reached the PC', running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled' }[c.status] || c.status);
  function cmdLabel(c) {
    const a = c.args || {};
    switch (c.action) {
      case 'burn': return a.on ? 'Turn the burn timer on' : 'Turn the burn timer off';
      case 'stop-after-job': return a.on ? 'Stop after the job in hand' : 'Keep the round going';
      case 'stop-now': return 'Stop the job now';
      case 'start-round': return 'Start a round of ' + a.jobs;
      case 'driver': return (a.on ? 'Let ' : 'Turn off ') + a.id + (a.on ? ' take jobs' : '');
      case 'settings': return 'Save settings';
      case 'blacklist': return (a.add ? 'Blacklist ' : 'Take off the blacklist: ') + a.company;
      case 'skip': return a.on ? 'Take ' + (a.label || 'a job') + ' out of the round' : 'Put ' + (a.label || 'a job') + ' back in the round';
      case 'alert': return a.resolve ? 'Resolve an inbox item' : 'Reopen an inbox item';
      case 'scan': return 'Scan all sources';
      case 'read': return 'Open a file';
      default: return c.action;
    }
  }

  // ---- Derived numbers -------------------------------------------------------------------------
  const runJobs = (id) => S.jobs.filter((j) => j.round === id);
  const isSent = (j) => j.result === 'sent';
  const sentIn = (a, b) => S.jobs.reduce((n, j) => n + (isSent(j) && j.end >= a && j.end < b ? 1 : 0), 0);
  const jobByUid = (uid) => S.jobs.find((j) => j.uid === uid);
  const driverById = (id) => S.drivers.find((d) => d.id === id);
  const runById = (id) => S.runs.find((r) => r.id === id);
  const isBlack = (co) => S.prefs.blacklist.some((b) => fold(b) === fold(co));
  const sites = () => { const m = new Map(); for (const j of S.jobs) if (!m.has(j.site)) m.set(j.site, j.siteName); return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])); };
  const siteName = (id) => (S.jobs.find((j) => j.site === id) || { siteName: id }).siteName;

  function daily(days) {
    const out = [], n = new Date();
    for (let i = 0; i < days; i++) out.push({ t: new Date(n.getFullYear(), n.getMonth(), n.getDate() - (days - 1) + i).getTime(), sent: 0, other: 0 });
    const t0 = out[0].t;
    for (const j of S.jobs) {
      const i = Math.round((sod(j.end) - t0) / DAY);
      if (i >= 0 && i < days) out[i][isSent(j) ? 'sent' : 'other']++;
    }
    return out;
  }
  function rangeStart(r) {
    const t = sod(Date.now());
    return { '24h': Date.now() - DAY, today: t, '7d': t - 6 * DAY, '30d': t - 29 * DAY, all: 0 }[r] || 0;
  }
  function runStats(id) {
    const rj = runJobs(id), sent = rj.filter(isSent).length;
    const mins = rj.length ? sum(rj.map((j) => (j.end - j.start) / MIN)) / rj.length : 0;
    const drivers = {};
    for (const j of rj) drivers[j.driver] = (drivers[j.driver] || 0) + 1;
    return { jobs: rj.length, sent, mins, drivers: Object.entries(drivers).sort((a, b) => b[1] - a[1]) };
  }
  function replyStats(a, b) {
    const old = S.jobs.filter((j) => isSent(j) && j.end >= a && j.end < b && Date.now() - j.end > 2 * DAY);
    const answered = old.filter((j) => j.reply && j.reply.outcome).length;
    const interviews = old.filter((j) => j.reply && j.reply.outcome === 'interview').length;
    const positive = old.filter((j) => j.reply && (j.reply.outcome === 'interview' || j.reply.outcome === 'positive')).length;
    const reached = LEVELS.map(([k]) => old.filter((j) => j.reply && lrank(j.reply.level) >= lrank(k)).length);
    return { old, n: old.length, answered, interviews, positive, reached };
  }

  // ---- Drivers: one status rule for all --------------------------------------------------------
  // What the burn timer and run.sh decided, read from the same fields for every driver.
  function rule(d) {
    if (d.scheduled) return { k: 'scheduled', label: 'On schedule', text: 'Applies only so that its 5-hour window reaches the buffer at the reset; outside working hours, at once.' + (d.until ? ' Until ' + when(d.until) + '.' : '') };
    if (d.monthly) return { k: 'monthly', label: 'Spread over the month', text: 'Takes a job only when its share of the month’s credits allows.' };
    if (d.lastResort && d.lastHours) return { k: 'lastHours', label: 'Last resort, week’s end', text: 'Comes last, and only in the last ' + d.lastHours + ' hours before its week resets.' };
    if (d.lastResort) return { k: 'reserve', label: 'Last resort', text: 'Comes after the others, and only while it keeps its reserve.' };
    if (d.from) return { k: 'from', label: 'Waits for a date', text: 'Left alone until ' + when(d.from) + '.' };
    return { k: 'plain', label: 'Full allowance', text: 'Takes jobs until its own limit; run.sh hands the job on when it hits one.' };
  }
  function status(d) {
    const now = Date.now(), why = d.why || '';
    const c = S.run.current;
    if (d.off) return { k: 'off', tone: 'neutral', label: 'Off', why: 'You turned it off. It takes no job until you turn it on.' };
    if (d.expired) return { k: 'ended', tone: 'neutral', label: 'Ended', why: 'Its time with the timer ended ' + when(d.until) + '. It is yours again.' };
    if (c && c.driver === d.id && S.run.state === 'running') return { k: 'applying', tone: 'info', label: 'Applying', why: 'Job ' + c.job + ', ' + c.company + '.' };
    if (d.outUntil && d.outUntil > now && !(d.paused && d.paused >= d.outUntil)) return { k: 'limit', tone: 'bad', label: 'At limit', why: 'Hit its limit. Back ' + when(d.outUntil) + '.' };
    if (d.paused && d.paused > now) {
      if (/left alone until/.test(why)) return { k: 'waiting', tone: 'neutral', label: 'Not yet', why: cap(why) + '.' };
      if (/credits used this month/.test(why)) return { k: 'limit', tone: 'bad', label: 'At limit', why: cap(why) + '. Resets ' + when(d.paused) + '.' };
      if (/spread over the month/.test(why)) return { k: 'pace', tone: 'warn', label: 'Ahead of pace', why: cap(why) + '.' };
      if (/stays for|stays yours|kept until/.test(why)) return { k: 'reserve', tone: 'warn', label: 'Holding reserve', why: cap(why) + '.' };
      if (/working hours|on schedule|the most for now/.test(why)) return { k: 'work', tone: 'neutral', label: 'Your hours', why: cap(why) + '.' };
      if (/no reading|could not be read/.test(why)) {
        const a = S.alerts.find((x) => x.auto && x.state !== 'resolved' && d.account && x.detail.includes(d.account));
        return { k: 'unknown', tone: 'bad', label: 'Cannot read', why: a ? 'The burn timer cannot read it: ' + a.detail.replace(/^could not read [^:]+: /, '') : 'The burn timer has no reading of its windows, so it keeps it out.' };
      }
      return { k: 'paused', tone: 'neutral', label: 'Paused', why: cap(why || 'paused by the burn timer') + '. Until ' + when(d.paused) + '.' };
    }
    for (const w of WINDOWS) { const x = d.windows[w.k]; if (x && x.reset > now && x.used >= 100) return { k: 'limit', tone: 'bad', label: 'At limit', why: w.label + ' used up. Resets ' + when(x.reset) + '.' }; }
    return { k: 'ready', tone: 'ok', label: 'Ready', why: why ? cap(why) + '.' : 'Can take the next job.' };
  }
  // A window past its reset counts as unused: the reading is from before it.
  const winNow = (x) => (x && x.reset && x.reset <= Date.now() ? Object.assign({}, x, { used: 0, stale: true }) : x);
  function driverToday(d) {
    const t = sod(Date.now()), dj = S.jobs.filter((j) => j.driver === d.id && j.end >= t);
    const w = S.jobs.filter((j) => j.driver === d.id && j.end >= t - 6 * DAY);
    return { jobs: dj.length, sent: dj.filter(isSent).length, week: w.length, weekSent: w.filter(isSent).length,
      mins: w.length ? sum(w.map((j) => (j.end - j.start) / MIN)) / w.length : 0 };
  }

  // ---- Toasts, modal, drawer -------------------------------------------------------------------
  let toastSeq = 0;
  const undos = {};
  function toast(text, o) {
    o = o || {};
    const id = ++toastSeq;
    if (o.undo) undos[id] = o.undo;
    S.toasts.push({ id, text, tone: o.tone || '', action: o.action || null, undo: !!o.undo });
    if (S.toasts.length > 4) S.toasts.shift();
    setTimeout(() => { S.toasts = S.toasts.filter((x) => x.id !== id); delete undos[id]; renderToasts(); }, o.undo ? 9000 : 6000);
    renderToasts();
  }
  const confirmModal = (o) => { S.modal = Object.assign({ kind: 'confirm' }, o); };

  // ---- Actions ---------------------------------------------------------------------------------
  function setPath(path, value) {
    const keys = path.split('.'); let o = S;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    const last = keys[keys.length - 1];
    if (typeof o[last] === 'number' && value !== '' && !isNaN(+value)) value = +value;
    else if (typeof o[last] === 'boolean') value = value === true || value === 'true';
    else if (Array.isArray(o[last]) && value === '') value = [];
    o[last] = value;
    if (path.startsWith('f.apps.') && last !== 'page') S.f.apps.page = 1;
    if (path === 'f.alerts.tab' || path === 'f.alerts.sev') S.f.alerts.sel = [];
  }
  function goApps(filter) {
    S.f.apps = Object.assign({ q: '', range: '30d', results: [], reply: '', site: '', driver: '', run: '', sort: 'start', dir: -1, page: 1, size: S.f.apps.size }, filter);
    S.drawer = null;
    location.hash = 'applications';
  }

  const A = {
    go: (r) => { S.drawer = null; S.modal = null; location.hash = r; },
    set: (arg) => { const i = arg.indexOf('='); setPath(arg.slice(0, i), arg.slice(i + 1)); },
    nav: () => { S.ui.nav = !S.ui.nav; },
    theme: (t) => {
      theme = t;
      try { localStorage.setItem('fm-theme', t); } catch (e) { /* storage off */ }
      applyTheme();
    },
    closeDrawer: () => { S.drawer = null; S.dd = null; },
    closeModal: () => { S.modal = null; },
    dismissToast: (id) => { S.toasts = S.toasts.filter((x) => x.id !== +id); },
    undo: (id) => { const f = undos[id]; if (f) { f(); delete undos[id]; } S.toasts = S.toasts.filter((x) => x.id !== +id); },
    toggleChart: (k) => { S.ui.chart[k] = !S.ui.chart[k]; },
    retryLoad: () => { pull(); },

    // run controls
    toggleBurn: () => {
      if (pending('burn')) return;
      const on = !S.burn;
      command('burn', { on }, { undo: () => command('burn', { on: !on }) });
    },
    toggleStopAfter: () => {
      if (pending('stop-after-job')) return;
      const on = !S.run.stopAfter;
      command('stop-after-job', { on }, { undo: () => command('stop-after-job', { on: !on }) });
    },
    askStopNow: () => { const c = S.run.current; confirmModal({ title: 'Stop job ' + c.job + ' now?', danger: true, confirm: 'Stop now', act: 'stopNow',
      text: 'The driver is ended at once and the job is recorded as Stopped by you. Round ' + S.run.id + ' ends with it. If the form was already submitted, the employer still has it.' }); },
    stopNow: () => { S.modal = null; command('stop-now', {}); },
    askStart: () => { S.modal = { kind: 'start', value: String(S.prefs.roundSize) }; },
    doStart: () => {
      const n = +S.modal.value;
      if (!(Number.isInteger(n) && n >= 1 && n <= 200)) { S.modal.error = 'Enter a whole number from 1 to 200.'; return; }
      S.modal = null;
      command('start-round', { jobs: n }, { label: 'Start a round of ' + n });
    },

    // queue
    queueSkip: (url) => {
      const q = S.queue.find((x) => x.url === url); if (!q) return;
      const on = !q.skipped, label = q.company;
      command('skip', { urls: [url], on, label }, { label: on ? 'Take ' + label + ' out of the round' : 'Put ' + label + ' back', undo: () => command('skip', { urls: [url], on: !on, label }) });
    },
    askBlack: (co) => confirmModal({ title: 'Blacklist ' + co + '?', danger: true, confirm: 'Blacklist', act: 'doBlack', arg: co,
      text: 'No more applications go to ' + co + '. ' + blackEffect(co) + ' You can take it off under Preferences.' }),
    doBlack: (co) => {
      S.modal = null;
      const urls = S.queue.filter((q) => fold(q.company) === fold(co)).map((q) => q.url);
      command('blacklist', { company: co, add: true, urls }, { undo: () => command('blacklist', { company: co, add: false, urls }) });
    },
    copy: (text) => {
      const done = () => toast('Link copied');
      try { navigator.clipboard.writeText(text).then(done, () => toast('Copy did not work here. Select the link and copy it by hand.', { tone: 'bad' })); } catch (e) { toast('Copy did not work here. Select the link and copy it by hand.', { tone: 'bad' }); }
    },
    askScan: () => {
      if (pending('scan')) return;
      confirmModal({ title: 'Scan all sources now?', confirm: 'Scan now', act: 'doScan',
        text: 'It runs scan.mjs, then make-pool.mjs: every source, then the rules, the posting texts and the fit scores. That takes a while (the morning scan takes about half an hour). It does not apply to anything.' });
    },
    doScan: () => { S.modal = null; command('scan', {}, { label: 'Scan' }); S.f.queue.tab = 'scan'; },

    // applications
    sort: (k) => { const f = S.f.apps; if (f.sort === k) f.dir = -f.dir; else { f.sort = k; f.dir = k === 'start' || k === 'fit' || k === 'mins' ? -1 : 1; } f.page = 1; },
    toggleResult: (k) => { const f = S.f.apps; f.results = f.results.includes(k) ? f.results.filter((x) => x !== k) : f.results.concat(k); f.page = 1; },
    clearApps: () => { goApps({}); },
    page: (d) => { S.f.apps.page = Math.max(1, S.f.apps.page + +d); window.scrollTo(0, 0); },
    goApps: (k) => {
      if (k === 'today') goApps({ range: 'today', results: ['sent'] });
      else if (k === '7d') goApps({ range: '7d', results: ['sent'] });
      else if (k === 'run') { const id = S.run.state !== 'idle' && S.run.id ? S.run.id : S.run.lastRun ? S.run.lastRun.id : ''; goApps({ range: 'all', run: id }); }
      else if (k.startsWith('run:')) goApps({ range: 'all', run: k.slice(4) });
      else if (k.startsWith('driver:')) goApps({ range: '7d', driver: k.slice(7) });
      else if (k.startsWith('site:')) goApps({ range: S.f.results.range === 'all' ? 'all' : '30d', site: k.slice(5) });
      else if (k.startsWith('q:')) goApps({ range: 'all', q: k.slice(2) });
      else if (k.startsWith('reply:')) goApps({ range: S.f.results.range, results: ['sent'], reply: k.slice(6) });
    },

    // drawers
    openJob: (uid) => { S.drawer = { type: 'job', id: uid }; },
    openRun: (id) => { S.drawer = { type: 'run', id }; },
    openCompany: (name) => { S.drawer = { type: 'company', id: name }; },
    openDriver: (id) => { const d = driverById(id); if (!d) return; S.drawer = { type: 'driver', id }; S.dd = { id, week: d.reserve.week, five: d.reserve.five }; S.ui.errors = {}; },
    getFile: (arg) => {
      const [kind, n] = arg.split(':');
      if (S.ui.files[arg] && S.ui.files[arg].state === 'wait') return;
      S.ui.files[arg] = { state: 'wait' };
      command('read', { kind, num: +n }, { quiet: true,
        onDone: (c) => { S.ui.files[arg] = { state: 'ready', url: '/api/v1/commands/' + c.id + '/file', at: Date.now() }; render(); },
        onFail: (c) => { S.ui.files[arg] = { state: 'error', text: c.message }; render(); } })
        .then((id) => { if (!id) S.ui.files[arg] = null; render(); });
    },

    // drivers
    toggleDriver: (id) => {
      const d = driverById(id); if (!d || pending('driver', (a) => a.id === id)) return;
      const on = d.off;
      command('driver', { id, on }, { undo: () => command('driver', { id, on: !on }) });
    },
    saveDriver: () => {
      const dd = S.dd, e = {}, d = driverById(dd.id);
      for (const k of ['week', 'five']) { const v = +dd[k]; if (!(Number.isInteger(v) && v >= 0 && v <= 90)) e['rsv-' + k] = 'A whole number from 0 to 90.'; }
      S.ui.errors = e;
      if (Object.keys(e).length) { toast('Fix the highlighted fields', { tone: 'bad' }); return; }
      if (+dd.week === d.reserve.week && +dd.five === d.reserve.five) { S.drawer = null; S.dd = null; toast('Nothing changed'); return; }
      const before = { id: d.id, week: d.reserve.week, five_hour: d.reserve.five };
      command('settings', { reserve: { id: d.id, week: +dd.week, five_hour: +dd.five } }, { label: 'Save ' + d.id, undo: () => command('settings', { reserve: before }) });
      S.drawer = null; S.dd = null;
    },

    // alerts
    selAlert: (id) => { const f = S.f.alerts; f.sel = f.sel.includes(id) ? f.sel.filter((x) => x !== id) : f.sel.concat(id); },
    selAllAlerts: () => { const f = S.f.alerts, ids = visibleAlerts().map((a) => a.id); f.sel = f.sel.length === ids.length ? [] : ids; },
    alertState: (arg) => {
      const [what, ids0] = arg.split(':');
      const ids = ids0 === 'sel' ? S.f.alerts.sel.slice() : [ids0];
      const list = ids.map((id) => S.alerts.find((x) => x.id === id)).filter(Boolean);
      S.f.alerts.sel = [];
      if (what === 'snooze') {
        for (const a of list) snoozes[a.id] = Date.now() + DAY;
        saveSnoozes(); derive();
        toast('Snoozed for a day on this device: ' + (list.length === 1 ? '“' + list[0].title + '”' : list.length + ' alerts'), { undo: () => { for (const a of list) delete snoozes[a.id]; saveSnoozes(); derive(); render(); } });
        return;
      }
      if (what === 'open') for (const a of list) if (snoozes[a.id]) delete snoozes[a.id];
      saveSnoozes();
      const inbox = list.filter((a) => a.line && (what === 'resolve' ? a.state !== 'resolved' : a.state === 'resolved'));
      for (const a of inbox) command('alert', { line: a.line, resolve: what === 'resolve' }, { quiet: inbox.length > 1, label: (what === 'resolve' ? 'Resolve “' : 'Reopen “') + a.title + '”', undo: () => command('alert', { line: a.line, resolve: what !== 'resolve' }) });
      if (inbox.length > 1) toast((what === 'resolve' ? 'Resolving ' : 'Reopening ') + inbox.length + ' inbox items', { tone: 'info' });
      derive();
    },

    // preferences
    pdDay: (d) => { d = +d; const w = S.pd.work; w.days = w.days.includes(d) ? w.days.filter((x) => x !== d) : w.days.concat(d).sort(); },
    blAdd: () => {
      const v = S.ui.blInput.trim();
      if (!v) return;
      if (S.prefs.blacklist.some((b) => fold(b) === fold(v))) { S.ui.errors = Object.assign({}, S.ui.errors, { bl: v + ' is already on the list.' }); return; }
      delete S.ui.errors.bl; S.ui.blInput = '';
      const urls = S.queue.filter((q) => fold(q.company) === fold(v)).map((q) => q.url);
      command('blacklist', { company: v, add: true, urls }, { undo: () => command('blacklist', { company: v, add: false, urls }) });
    },
    askBlRemove: (co) => confirmModal({ title: 'Take ' + co + ' off the blacklist?', confirm: 'Take it off', act: 'blRemove', arg: co,
      text: 'Its postings can be applied to again from the next scan and round on.' }),
    blRemove: (co) => { S.modal = null; command('blacklist', { company: co, add: false }, { undo: () => command('blacklist', { company: co, add: true }) }); },
    discardPrefs: () => { S.pd = clone(S.prefs); S.ui.errors = {}; toast('Changes discarded'); },
    savePrefs: () => {
      const p = S.pd, e = {};
      const v = +p.roundSize;
      if (!(Number.isInteger(v) && v >= 1 && v <= 200)) e.roundSize = 'A whole number from 1 to 200.';
      if (!p.work.days.length) e.workDays = 'Pick at least one day.';
      if (!(p.work.from < p.work.to)) e.workTo = 'Must be later than the start.';
      S.ui.errors = e;
      const bad = Object.keys(e).length;
      if (bad) { toast('Fix the ' + (bad === 1 ? 'highlighted field' : bad + ' highlighted fields') + ' first', { tone: 'bad' }); return; }
      const args = {}, before = {};
      if (v !== S.prefs.roundSize) { args.round_jobs = v; before.round_jobs = S.prefs.roundSize; }
      if (JSON.stringify(p.work) !== JSON.stringify(S.prefs.work)) { args.work = { days: p.work.days.slice().sort(), from: p.work.from, to: p.work.to }; before.work = clone(S.prefs.work); }
      if (!Object.keys(args).length) { toast('Nothing changed'); return; }
      command('settings', args, { label: 'Save preferences', undo: () => command('settings', before) });
    },
  };

  function blackEffect(co) {
    const q = S.queue.filter((x) => fold(x.company) === fold(co)).length, p = S.pool.filter((x) => fold(x.company) === fold(co)).length;
    if (!q && !p) return 'Nothing from it is waiting now.';
    return [q ? plural(q, 'job') + ' in this round are passed over' : '', p ? plural(p, 'posting') + ' leave the pool at the next round' : ''].filter(Boolean).join(', and ') + '.';
  }
  const draftOf = (p) => ({ roundSize: +p.roundSize, work: p.work });
  function prefChanges() {
    if (!S.pd) return [];
    const out = [];
    if (+S.pd.roundSize !== S.prefs.roundSize) out.push('jobs per round');
    if (JSON.stringify(S.pd.work.days.slice().sort()) !== JSON.stringify(S.prefs.work.days.slice().sort())) out.push('working days');
    if (S.pd.work.from !== S.prefs.work.from || S.pd.work.to !== S.prefs.work.to) out.push('working hours');
    return out;
  }

  // ---- Small components ------------------------------------------------------------------------
  const pill = (tone, label, tip) => `<span class="pill t-${tone}"${tip ? ` data-tip="${esc(tip)}"` : ''}><i></i>${esc(label)}</span>`;
  const rpill = (res) => pill(RESULTS[res].tone, RESULTS[res].label, RESULTS[res].desc);
  const spill = (s) => pill(s.tone, s.label, s.why);
  function btn(label, act, o) {
    o = o || {};
    return `<button type="button" class="btn${o.kind ? ' ' + o.kind : ''}${o.sm ? ' sm' : ''}${o.icon && !label ? ' icon-only' : ''}${o.busy ? ' busy' : ''}" data-act="${act}"${o.arg != null ? ` data-arg="${esc(o.arg)}"` : ''}${o.disabled || o.busy ? ' disabled' : ''}${o.tip ? ` data-tip="${esc(o.tip)}"` : ''}${o.aria ? ` aria-label="${esc(o.aria)}"` : ''}>${o.busy ? '<span class="spin" aria-hidden="true"></span>' : o.icon ? icon(o.icon) : ''}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
  }
  const sw = (on, act, label, o) => `<button type="button" class="switch${o && o.busy ? ' busy' : ''}" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-act="${act}"${o && o.arg != null ? ` data-arg="${esc(o.arg)}"` : ''}${o && (o.disabled || o.busy) ? ' disabled' : ''}${o && o.tip ? ` data-tip="${esc(o.tip)}"` : ''}><i></i></button>`;
  const seg = (path, value, opts, label) => `<div class="seg" role="radiogroup" aria-label="${esc(label || '')}">${opts.map(([v, l]) => `<button type="button" role="radio" aria-checked="${String(v) === String(value)}" data-act="set" data-arg="${path}=${v}">${esc(l)}</button>`).join('')}</div>`;
  const card = (title, body, o) => {
    o = o || {};
    return `<section class="card${o.cls ? ' ' + o.cls : ''}"${o.id ? ` id="${o.id}"` : ''}>${title ? `<header class="card-h"><div class="card-t"><h2>${title}</h2>${o.sub ? `<p>${o.sub}</p>` : ''}</div>${o.right ? `<div class="card-r">${o.right}</div>` : ''}</header>` : ''}<div class="card-b${o.flush ? ' flush' : ''}">${body}</div></section>`;
  };
  const pageHead = (title, sub, right) => `<div class="ph"><div class="ph-t"><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right ? `<div class="ph-r">${right}</div>` : ''}</div>`;
  const empty = (ic, title, text, actions) => `<div class="empty"><span class="empty-ic">${icon(ic)}</span><h3>${esc(title)}</h3><p>${text}</p>${actions ? `<div class="empty-a">${actions}</div>` : ''}</div>`;
  const since = (t) => `<span class="mono" data-since="${t}">${clock(Date.now() - t)}</span>`;
  const agoS = (t) => `<span data-ago="${t}" data-tip="${esc(when(t))}">${ago(t)}</span>`;
  const sevIcon = (sev) => `<span class="sev t-${SEV[sev].tone}" data-tip="${SEV[sev].label}">${icon(SEV[sev].icon)}<span class="sr">${SEV[sev].label}</span></span>`;
  const row = (act, arg, cells, cls) => `<tr class="row-link${cls ? ' ' + cls : ''}" tabindex="0" data-act="${act}" data-arg="${esc(arg)}">${cells}</tr>`;
  const ended = (k, note) => pill(ENDED[k].tone, ENDED[k].label, note || ENDED[k].note);
  const chip = (text, act, arg, label) => `<span class="chip">${esc(text)}<button type="button" class="chip-x" data-act="${act}" data-arg="${esc(arg)}" aria-label="${esc(label)}">${icon('x')}</button></span>`;
  const offlineTip = () => (online() ? '' : machineState().text + '. Buttons work again when it is back.');
  function meter(x0, reserve, compact) {
    const x = winNow(x0);
    if (!x) return `<span class="na" data-tip="No reading of this kind for this driver">—</span>`;
    const used = Math.round(x.used), left = 100 - used;
    const tone = left <= 0 ? 'bad' : reserve && left <= reserve ? 'warn' : used >= 80 ? 'warn' : 'ok';
    const old = x.at && Date.now() - x.at > 6 * HOUR;
    const tip = used + '% used' + (reserve ? ' · keeps ' + reserve + '% in reserve' : '') + (x.detail ? ' · ' + x.detail : '') + '\nResets ' + when(x.reset) + (x.at ? '\nRead ' + when(x.at) : '') + (x.stale ? '\nThe reading is from before its reset' : '');
    return `<div class="meter-w${compact ? ' compact' : ''}${old || x.stale ? ' old' : ''}" data-tip="${esc(tip)}"><div class="meter m-${tone}">${reserve ? `<span class="rsv" style="width:${reserve}%"></span>` : ''}<b style="width:${Math.min(100, used)}%"></b></div><div class="meter-l"><span class="mono">${used}%</span><span class="muted">${old ? 'read ' + ago(x.at) : x.stale ? 'reset ' + ago(x.reset) : 'resets ' + ago(x.reset)}</span></div></div>`;
  }
  function stepper(c, big) {
    const ph = c.phases || [];
    return `<ol class="steps${big ? ' big' : ''}" aria-label="Steps">${ph.map((s, i) => {
      const st = i < c.phase ? 'done' : i === c.phase ? 'now' : 'todo';
      const lab = { done: 'done', now: 'in progress', todo: 'to do' }[st];
      return `<li class="st-${st}"><span class="dot">${st === 'done' ? icon('check') : ''}</span><span class="lbl">${esc(s.label)}<span class="sr"> (${lab})</span></span>${big ? `<span class="tm mono">${s.at ? hhmm(s.at) : ''}</span>` : ''}</li>`;
    }).join('')}</ol>`;
  }
  function delta(cur, prev, what) {
    if (!prev) return `<span class="muted">${what}</span>`;
    const d = (cur - prev) / prev, up = d >= 0;
    return `<span class="delta ${up ? 'up' : 'down'}">${icon(up ? 'up' : 'down')}${Math.abs(Math.round(d * 100))}%</span><span class="muted">${what}</span>`;
  }
  function fileBtn(kind, n, label, ic) {
    const k = kind + ':' + n, f = S.ui.files[k];
    if (f && f.state === 'ready' && Date.now() - f.at < 9 * MIN) return `<a class="btn sm primary" href="${f.url}" target="_blank" rel="noopener">${icon('ext')}<span>Open ${esc(label)}</span></a>`;
    if (f && f.state === 'error') return `<span class="muted file-err">${esc(label)}: ${esc(f.text)}</span>`;
    return btn(f && f.state === 'wait' ? 'Getting ' + label + '…' : label, 'getFile', { arg: k, icon: ic, sm: true, busy: f && f.state === 'wait', disabled: !online(), tip: online() ? 'Fetch it from the PC' : offlineTip() });
  }

  // ---- Charts ----------------------------------------------------------------------------------
  function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
  function ticks(max, n) { const s = niceStep(Math.max(1, max) / (n || 4)), top = Math.ceil(Math.max(1, max) / s) * s, out = []; for (let v = 0; v <= top + 1e-9; v += s) out.push(v); return out; }
  function topRound(x, y, w, h, r) { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; }
  function spark(vals, w, h) {
    w = w || 112; h = h || 30;
    const max = Math.max(1, ...vals), stepX = (w - 8) / (vals.length - 1);
    const pts = vals.map((v, i) => [4 + i * stepX, h - 4 - (h - 8) * v / max]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path class="sp-a" d="${line}L${last[0].toFixed(1)},${h - 4}L4,${h - 4}Z"/><path class="sp-l" d="${line}"/><circle class="sp-d" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5"/></svg>`;
  }
  function dailyChart(days) {
    const compact = S.ui.compact, W = compact ? 360 : 760, H = compact ? 200 : 230, pl = 34, pr = 6, pt = 10, pb = 24;
    const pw = W - pl - pr, ph = H - pt - pb;
    const tk = ticks(Math.max(...days.map((d) => d.sent + d.other)), 4), top = tk[tk.length - 1];
    const band = pw / days.length, bw = Math.min(24, band * 0.64), y = (v) => pt + ph - ph * v / top;
    let g = '';
    tk.forEach((v) => { g += `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ax" x="${pl - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`; });
    let bars = '', hits = '', labels = '';
    days.forEach((d, i) => {
      const x = pl + i * band + (band - bw) / 2;
      const hs = ph * d.sent / top, ho = ph * d.other / top;
      if (d.sent) bars += `<path class="s1" d="${d.other ? `M${x},${y(0)}V${y(0) - hs}H${x + bw}V${y(0)}Z` : topRound(x, y(0) - hs, bw, hs, 4)}"/>`;
      if (d.other) { const yo = y(0) - hs - (d.sent ? 2 : 0) - ho; bars += `<path class="s2" d="${topRound(x, yo, bw, Math.max(ho, 1), 4)}"/>`; }
      const isToday = i === days.length - 1;
      const tip = (isToday ? 'Today, so far' : dayLabel(d.t)) + '\nSent: ' + d.sent + '\nNot sent: ' + d.other + '\nSent rate: ' + pct(d.sent, d.sent + d.other);
      hits += `<rect class="hit" x="${(pl + i * band).toFixed(1)}" y="${pt}" width="${band.toFixed(1)}" height="${ph}" tabindex="0" data-tip="${esc(tip)}"/>`;
      const every = compact ? 4 : 5;
      if ((days.length - 1 - i) % every === 0) labels += `<text class="ax" x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${isToday ? 'Today' : shortDay(d.t)}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Applications per day, sent and not sent">${g}<line class="axis" x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}"/>${bars}${labels}${hits}</svg>`;
  }
  // Lines over days, one per series, with a marker on every day that has a value; a day without one
  // breaks the line. Hover a day for every series' value. series: [{ key, label, cls, vals: [{v, n}|null] }].
  function trendChart(days, series, o) {
    const compact = S.ui.compact || o.narrow, W = compact ? 360 : 760, H = compact ? 220 : 240, pl = 34, pr = series.length > 1 ? (compact ? 70 : 96) : 10, pt = 12, pb = 24;
    const pw = W - pl - pr, ph = H - pt - pb;
    const all = series.flatMap((x) => x.vals.filter(Boolean).map((q) => q.v));
    const tk = ticks(Math.max(1, ...all), 4), top = tk[tk.length - 1];
    const stepX = pw / Math.max(1, days.length - 1), X = (i) => pl + i * stepX, Y = (v) => pt + ph - ph * v / top;
    let g = '';
    tk.forEach((v) => { g += `<line class="grid" x1="${pl}" x2="${pl + pw}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${pl - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`; });
    let lines = '', dots = '';
    const ends = [];
    for (const sr of series) {
      let d = '', open = false;
      sr.vals.forEach((q, i) => { if (!q) { open = false; return; } d += (open ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(q.v).toFixed(1); open = true; dots += `<circle class="dot ${sr.cls}" cx="${X(i).toFixed(1)}" cy="${Y(q.v).toFixed(1)}" r="4"/>`; });
      lines += `<path class="ln ${sr.cls}" d="${d}"/>`;
      const li = sr.vals.map((q, i) => (q ? i : -1)).filter((i) => i >= 0).pop();
      // Only a line that is still going gets an end label; an old last point is not today's value.
      if (li != null && li >= days.length - 3) ends.push({ y: Y(sr.vals[li].v), label: sr.label + ' ' + o.fmt(sr.vals[li].v) });
    }
    // End labels, pushed apart so they never overlap.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    const labels = series.length > 1 ? ends.map((e) => `<text class="end-l" x="${(pl + pw + 8).toFixed(1)}" y="${(e.y + 4).toFixed(1)}">${esc(e.label)}</text>`).join('') : '';
    let hits = '', xl = '';
    days.forEach((t, i) => {
      const rows = series.map((sr) => (sr.vals[i] ? sr.label + ': ' + o.fmt(sr.vals[i].v) + ' (' + plural(sr.vals[i].n, 'job') + ')' : null)).filter(Boolean);
      const tip = (i === days.length - 1 ? 'Today, so far' : dayLabel(t)) + '\n' + (rows.length ? rows.join('\n') : 'No sent job');
      hits += `<rect class="hit" x="${(X(i) - stepX / 2).toFixed(1)}" y="${pt}" width="${stepX.toFixed(1)}" height="${ph}" tabindex="0" data-tip="${esc(tip)}"/>`;
      const every = compact ? 7 : 5;
      if ((days.length - 1 - i) % every === 0) xl += `<text class="ax" x="${X(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${i === days.length - 1 ? 'Today' : shortDay(t)}</text>`;
    });
    return `<svg class="chart trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.label)}">${g}<line class="axis" x1="${pl}" x2="${pl + pw}" y1="${Y(0)}" y2="${Y(0)}"/>${lines}${dots}${labels}${xl}${hits}</svg>`;
  }
  const FAMILY = { agy: 'agy', 'agy-sonnet': 'Claude', sonnet: 'Claude', sonnet1: 'Claude', codex: 'codex', copilot: 'copilot' };
  const FAMILY_CLS = { agy: 'c1', Claude: 'c2', codex: 'c3', copilot: 'c4' };
  const median = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  /** Sent jobs per calendar day for the last n days, grouped by driver family: the median of f(job). */
  function dailyMedian(n, f, keep) {
    const now = new Date(), days = [];
    for (let i = 0; i < n; i++) days.push(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1) + i).getTime());
    const buckets = {};
    for (const j of S.jobs) {
      if (!isSent(j) || !FAMILY[j.driver] || (keep && !keep(j))) continue;
      const i = Math.round((sod(j.end) - days[0]) / DAY), v = f(j);
      if (i < 0 || i >= n || v == null) continue;
      const fam = FAMILY[j.driver];
      (buckets[fam] = buckets[fam] || days.map(() => []))[i].push(v);
    }
    // A day counts with 3 sent jobs or more: one slow job on a quiet day is not a trend.
    const series = Object.keys(FAMILY_CLS).filter((k) => buckets[k]).map((k) => ({ key: k, label: k, cls: FAMILY_CLS[k], vals: buckets[k].map((a) => (a.length >= 3 ? { v: median(a), n: a.length } : null)) })).filter((x) => x.vals.some(Boolean));
    return { days, series };
  }
  function trendTable(days, series, fmt) {
    const rows = days.map((t, i) => [t, i]).reverse().filter(([, i]) => series.some((x) => x.vals[i]));
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th>${series.map((x) => `<th class="num">${esc(x.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(([t, i]) => `<tr><td>${i === days.length - 1 ? 'Today' : dayLabel(t)}</td>${series.map((x) => `<td class="num">${x.vals[i] ? fmt(x.vals[i].v) + ` <span class="muted">(${x.vals[i].n})</span>` : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  const legend = (items) => `<div class="legend">${items.map(([cls, l]) => `<span><i class="${cls}"></i>${esc(l)}</span>`).join('')}</div>`;
  function hbars(rows, o) {
    o = o || {};
    const max = o.max || Math.max(1, ...rows.map((r) => r.v));
    return `<div class="hbars${o.cls ? ' ' + o.cls : ''}">${rows.map((r) => `<div class="hb" data-tip="${esc(r.tip || '')}"><span class="hb-l">${esc(r.label)}</span><span class="hb-t"><b class="${r.cls || 's1'}" style="width:${Math.max(0.6, 100 * r.v / max).toFixed(2)}%"></b></span><span class="hb-v mono">${r.text != null ? r.text : num(r.v)}</span></div>`).join('')}</div>`;
  }
  function wilson(k, n) {
    if (!n) return [0, 0];
    const z = 1.645, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
  }
  function armChart(key, rows) {
    const data = rows.map(([arm, list]) => {
      const k = list.filter((j) => j.reply && j.reply.outcome && j.reply.outcome !== 'rejected').length;
      const [lo, hi] = wilson(k, list.length);
      return { arm, n: list.length, k, p: list.length ? k / list.length : 0, lo, hi };
    });
    const hiMax = Math.max(0.02, ...data.map((d) => d.hi)), st = niceStep(hiMax / 2), max = Math.ceil(hiMax / st) * st;
    const sc = (v) => (100 * v / max).toFixed(2) + '%';
    return `<div class="arms">${data.map((d) => `<div class="arm" data-tip="${esc(ARMS[key][d.arm] + '\n' + d.k + ' positive answers of ' + d.n + ' sent\n90% range: ' + (100 * d.lo).toFixed(1) + '–' + (100 * d.hi).toFixed(1) + '%')}">
      <span class="arm-l">${esc(ARMS[key][d.arm])}<small>${num(d.n)} sent</small></span>
      <span class="arm-t"><b class="s1" style="width:${sc(d.p)}"></b><i class="wh" style="left:${sc(d.lo)};width:calc(${sc(d.hi)} - ${sc(d.lo)})"></i></span>
      <span class="arm-v mono">${(100 * d.p).toFixed(1)}%</span></div>`).join('')}
      <div class="arm-ax"><span></span><span class="arm-sc mono"><em>0%</em><em>${(50 * max).toFixed(1)}%</em><em>${(100 * max).toFixed(1)}%</em></span><span></span></div></div>`;
  }

  // ---- Shell -----------------------------------------------------------------------------------
  const NAV = [
    ['Run', [['overview', 'Overview', 'home'], ['live', 'Live job', 'pulse'], ['queue', 'Queue & scan', 'queue']]],
    ['Records', [['applications', 'Applications', 'table'], ['runs', 'Runs', 'runs'], ['results', 'Results', 'chart']]],
    ['System', [['drivers', 'Drivers', 'cpu'], ['alerts', 'Alerts', 'bell'], ['activity', 'Activity', 'clock'], ['preferences', 'Preferences', 'sliders']]],
  ];
  function vSide() {
    const open = S.alerts.filter((a) => a.state === 'open');
    const worst = open.length ? Math.min(...open.map((a) => SEV[a.sev].rank)) : 2;
    const badge = {
      live: S.run.state === 'running' ? `<span class="live-dot" aria-label="running"></span>` : '',
      queue: S.queue.length ? `<span class="nb">${S.queue.filter((q) => !q.skipped).length}</span>` : '',
      alerts: open.length ? `<span class="nb ${worst === 0 ? 't-bad' : worst === 1 ? 't-warn' : ''}">${open.length}</span>` : '',
      preferences: prefChanges().length ? `<span class="nb t-warn" aria-label="unsaved changes">•</span>` : '',
    };
    const ms = machineState();
    const net = DB.error === 'network' ? 'Cannot reach the dashboard server; retrying' : ms.text + (ms.ok ? ' · updated ' + ago(DB.lastOk).replace('just now', 'now') : '');
    return `<div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="8" class="bm-bg"/><path d="M9 21.5 14 10l4.2 8 2.3-3.6L23 18" class="bm-ln"/></svg><div><b>Free Motion</b><span>Control</span></div></div>
      <nav class="nav" aria-label="Pages">${NAV.map(([g, items]) => `<div class="nav-g"><span class="nav-h">${g}</span>${items.map(([k, l, ic]) => `<a href="#${k}" class="${S.route === k ? 'on' : ''}"${S.route === k ? ' aria-current="page"' : ''}>${icon(ic)}<span>${l}</span>${badge[k] || ''}</a>`).join('')}</div>`).join('')}</nav>
      <div class="side-f"><div class="seg theme" role="radiogroup" aria-label="Theme">${[['system', 'monitor', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([k, ic, l]) => `<button type="button" role="radio" aria-checked="${theme === k}" data-act="theme" data-arg="${k}" data-tip="${l} theme" aria-label="${l} theme">${icon(ic)}</button>`).join('')}</div>
      <p class="side-note conn ${ms.ok && !DB.error ? 'ok' : 'bad'}"><i></i><span>${esc(net)}</span></p>${DB.me ? `<p class="side-note">${esc(DB.me)}</p>` : ''}</div>`;
  }
  function runPill() {
    const r = S.run;
    if (r.state === 'running') return pill(r.stopAfter ? 'warn' : 'info', r.stopAfter ? 'Stops after this job' : 'Running · job ' + (r.done + 1) + ' of ' + r.planned);
    if (r.state === 'choosing') return pill('info', 'Starting a round');
    if (r.state === 'between') return pill('info', 'Between rounds');
    return pill('neutral', S.burn ? 'Idle · burn timer on' : 'Idle');
  }
  function vTop() {
    const today = sentIn(sod(Date.now()), Date.now() + DAY);
    return `<button type="button" class="btn ghost icon-only menu-btn" data-act="nav" aria-label="Open the menu">${icon('menu')}</button>
      <div class="search">${icon('search')}<input id="gsearch" type="search" placeholder="Search applications" aria-label="Search applications by company, role, place or job number" value="${esc(S.f.apps.q)}" data-model="f.apps.q" data-goto="applications" autocomplete="off"><kbd>/</kbd></div>
      <div class="top-r"><span class="top-sent"><b>${num(today)}</b> sent today</span><a href="#live" class="top-run">${runPill()}</a></div>`;
  }
  function offlineBanner() {
    if (DB.error === 'network') return `<div class="callout t-bad banner">${icon('wifi')}<div><b>The dashboard server does not answer.</b> What you see is from ${when(DB.lastOk)}. It retries every few seconds.</div></div>`;
    if (!online() && DB.loaded) { const ms = machineState(); return `<div class="callout t-warn banner">${icon('wifi')}<div><b>${esc(ms.text)}.</b> The numbers are the last ones it sent. Buttons are off until it is back.</div></div>`; }
    return '';
  }

  // ---- Overview --------------------------------------------------------------------------------
  function vOverview() {
    const now = Date.now(), t0 = sod(now), r = S.run;
    const d14 = daily(14), last7 = d14.slice(7), prev7 = d14.slice(0, 7);
    const s7 = sum(last7.map((d) => d.sent)), p7 = sum(prev7.map((d) => d.sent));
    const today = sentIn(t0, now + DAY), yest = sentIn(t0 - DAY, t0);
    const rid = r.state !== 'idle' && r.id ? r.id : r.lastRun ? r.lastRun.id : null, rs = rid ? runStats(rid) : null;
    const rep = replyStats(t0 - 29 * DAY, now);
    const tiles = `<div class="tiles">
      ${tile('Sent today', num(today), `<span class="muted">${num(yest)} yesterday</span>`, spark(d14.map((d) => d.sent)), 'today', 'Show what was sent today')}
      ${tile('Sent in the last 7 days', num(s7), delta(s7, p7, 'vs the 7 days before'), spark(last7.map((d) => d.sent)), '7d', 'Show the last 7 days')}
      ${tile(r.state !== 'idle' ? 'Sent rate this round' : 'Sent rate last round', rs && rs.jobs ? pct(rs.sent, rs.jobs) : '—', `<span class="muted">${rs ? rs.sent + ' sent of ' + plural(rs.jobs, 'job') : 'No round yet'}</span>`, '', 'run', 'Show this round’s jobs')}
      ${tile('Positive answers, 30 days', pct(rep.positive, rep.n, 1), `<span class="muted">${rep.positive} of ${num(rep.n)} · ${plural(rep.interviews, 'interview')}</span>`, '', 'results', 'Open Results')}
    </div>`;
    const showTable = S.ui.chart.daily;
    const days = daily(S.ui.compact ? 14 : 30);
    const chart = card('Applications per day', showTable ? dailyTable(days) : legend([['s1', 'Sent'], ['s2', 'Not sent']]) + dailyChart(days),
      { sub: 'Last ' + days.length + ' days, by the day each job ended', right: seg('ui.chart.daily', showTable ? 'true' : '', [['', 'Chart'], ['true', 'Table']], 'View'), cls: 'span-2' });
    return pageHead('Overview', 'Where the run is, what it sent, and what needs you.') +
      `<div class="grid g-3">${runPanel()}${controlsCard()}</div>${tiles}
      <div class="grid g-3">${chart}${attentionCard()}</div>
      <div class="grid g-3">${recentCard()}<div class="stack">${comingCard()}${driversMini()}</div></div>`;
  }
  function tile(label, value, sub, sp, link, linkLabel) {
    return `<button type="button" class="tile" data-act="${link === 'results' ? 'go' : 'goApps'}" data-arg="${link}" aria-label="${esc(label + ': ' + value + '. ' + linkLabel)}"><span class="tile-l">${esc(label)}</span><span class="tile-v">${value}</span><span class="tile-s">${sub}</span>${sp ? `<span class="tile-sp">${sp}</span>` : ''}</button>`;
  }
  function dailyTable(days) {
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Day</th><th class="num">Sent</th><th class="num">Not sent</th><th class="num">Sent rate</th></tr></thead><tbody>${days.slice().reverse().map((d, i) => `<tr><td>${i === 0 ? 'Today' : dayLabel(d.t)}</td><td class="num">${d.sent}</td><td class="num">${d.other}</td><td class="num">${pct(d.sent, d.sent + d.other)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const byWho = (by) => (by === 'Burn timer' ? 'the burn timer' : by === 'You' ? 'you' : (by || 'someone').toLowerCase());
  function runPanel() {
    const r = S.run, now = Date.now();
    const startBtn = btn('Start a round', 'askStart', { kind: 'primary', icon: 'play', disabled: !online() || !!pending('start-round'), busy: !!pending('start-round'), tip: offlineTip() });
    if (r.state === 'idle' || r.state === 'between') {
      const last = r.lastRun, ls = last ? runStats(last.id) : null;
      const next = S.burn ? 'The burn timer is on: it looks every 10 minutes and starts a round of ' + S.prefs.roundSize + ' when no run is going and a driver may apply.' : 'The burn timer is off, so nothing starts by itself.';
      return card('', `<div class="rp"><div class="rp-top">${pill('neutral', r.state === 'between' ? 'Between rounds' : 'Idle')}<span class="muted">${num(S.poolTotal)} postings in the pool${S.poolAt ? ', ranked ' + when(S.poolAt) : ''}</span></div>
        <h2 class="rp-title">${r.state === 'between' ? 'The night run waits for its next round' : 'No round is running'}</h2>${last ? `<p class="rp-sub">Last round ${esc(last.id)} ended ${when(last.end)}: ${ls.sent} sent of ${plural(ls.jobs, 'job')}. ${esc(ENDED[last.ended].note)}</p>` : ''}
        <p class="rp-sub">${next}</p><div class="rp-a">${startBtn}${last ? btn('Open round ' + last.id, 'openRun', { arg: last.id }) : ''}</div></div>`, { cls: 'span-2 run-card' });
    }
    if (r.state === 'choosing') {
      return card('', `<div class="rp"><div class="rp-top">${pill('info', 'Starting')}<span class="muted">Round ${esc(r.id || '')} · started ${r.start ? when(r.start) + ' by ' + byWho(r.by) + ' · ' + since(r.start) : ''}</span></div>
        <h2 class="rp-title">Choosing the jobs</h2><p class="rp-sub">The pool is built again (rules, live checks, fit scores) and the job sheets are written. Applying starts in a few minutes.</p></div>`, { cls: 'span-2 run-card' });
    }
    const st = runStats(r.id), done = r.done, other = done - st.sent, left = Math.max(0, r.planned - done - 1);
    const per = done ? (now - r.start) / (done + 0.5) : 10 * MIN, eta = now + per * (left + 0.5);
    const c = r.current;
    const w = (n) => (100 * n / Math.max(1, r.planned)).toFixed(2) + '%';
    const banner = r.stopAfter ? `<div class="callout t-warn">${icon('stop')}<div><b>The round stops when job ${c.job} ends.</b> The ${plural(left, 'job')} left are not applied to.</div>${btn('Keep going', 'toggleStopAfter', { kind: 'sm', disabled: !online() || !!pending('stop-after-job') })}</div>` : '';
    const lastLine = (c.log || []).slice().reverse().find((l) => l.kind === 'next');
    return card('', `<div class="rp"><div class="rp-top">${pill('info', 'Running')}<span class="muted">Round ${esc(r.id)} · started ${when(r.start)} by ${byWho(r.by)} · ${since(r.start)}</span></div>
      <h2 class="rp-title">Job ${done + 1} of ${r.planned}</h2>
      <p class="rp-sub">${st.sent} sent, ${other} not sent, ${left} to go. At ${dur(per / MIN)} a job it ends around <b>${hhmm(eta)}</b>${r.stopAfter ? ', but it stops early as you asked' : ''}.</p>
      <div class="prog" role="img" aria-label="${st.sent} sent, ${other} not sent, 1 in progress, ${left} to go"><b class="s1" style="width:${w(st.sent)}"></b><b class="s2" style="width:${w(other)}"></b><b class="cur" style="width:${w(1)}"></b></div>
      ${legend([['s1', st.sent + ' sent'], ['s2', other + ' not sent'], ['cur', '1 in progress'], ['todo', left + ' to go']])}
      ${banner}
      <div class="now-job"><div class="nj-h"><div><span class="eyebrow">Now applying</span><b>${esc(c.role)}</b><span class="muted">${esc(c.company)}${c.place ? ' · ' + esc(c.place) : ''} · ${esc(c.siteName)}${c.driver ? ' · ' + esc(drvName(c.driver)) : ''}</span></div><span class="nj-t">${since(c.start)}</span></div>
      ${stepper(c)}<div class="nj-a">${btn('Open live view', 'go', { arg: 'live', kind: 'primary sm', icon: 'pulse' })}<span class="muted">${esc(c.phases[c.phase].label)}${lastLine ? ' · ' + esc(lastLine.text) : ''}</span></div></div></div>`, { cls: 'span-2 run-card' });
  }
  function controlsCard() {
    const r = S.run, running = r.state === 'running' || r.state === 'choosing';
    const pb = pending('burn'), ps = pending('stop-after-job'), pn = pending('stop-now');
    const line = (title, desc, ctl) => `<div class="ctl"><div><b>${title}</b><span>${desc}</span></div>${ctl}</div>`;
    const wait = (c) => (c ? ' <em class="pend">' + esc(statusWord(c)) + '…</em>' : '');
    return card('Controls', `<div class="ctls">
      ${line('Burn timer' + wait(pb), S.burn ? 'On. When no run is going, it starts a round within 10 minutes.' : 'Off. Rounds start only when you start them.', sw(S.burn, 'toggleBurn', 'Burn timer', { busy: !!pb, disabled: !online(), tip: offlineTip() }))}
      ${line('Stop after this job' + wait(ps), running ? (r.stopAfter ? 'The round ends when the job in hand ends.' : 'Let the job in hand finish, then end the round.') : 'Only while a round is running.', sw(r.stopAfter, 'toggleStopAfter', 'Stop after this job', { disabled: !running || !online(), busy: !!ps, tip: offlineTip() }))}
      </div><div class="ctl-a">${btn('Start a round', 'askStart', { kind: 'primary', icon: 'play', disabled: running || !online(), busy: !!pending('start-round'), tip: running ? 'A round is running. Start one when it ends.' : offlineTip() })}${btn(pn ? 'Stopping…' : 'Stop now', 'askStopNow', { kind: 'danger', icon: 'stop', disabled: r.state !== 'running' || !online(), busy: !!pn, tip: r.state === 'running' ? offlineTip() : 'No job is running' })}</div>`,
    { sub: 'Each change goes to the PC and shows here once the PC has done it.' });
  }
  function attentionCard() {
    const open = S.alerts.filter((a) => a.state === 'open').sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank || b.last - a.last);
    const body = open.length ? `<ul class="att">${open.slice(0, 4).map((a) => `<li><a href="#alerts" class="att-i">${sevIcon(a.sev)}<span><b>${esc(a.title)}</b><span class="muted">${esc(a.source)}${a.last ? ' · ' + agoS(a.last) : ''}${a.count > 1 ? ' · ' + a.count + ' times' : ''}</span></span></a></li>`).join('')}</ul>`
      : empty('check', 'Nothing needs you', 'No open alerts.');
    const fresh = (x, days) => Date.now() - new Date(x.date + 'T12:00').getTime() < days * DAY;
    const rec = S.reactions.filter((x) => fresh(x, 7) && lrank(x.level) >= lrank('contacted')).length;
    const ans = S.reactions.filter((x) => fresh(x, 14) && x.replyNeeded).length;
    return card('Needs attention', body + `<div class="card-foot">${ans ? `<a href="#results"><b>${plural(ans, 'reply needs', 'replies need')} your answer</b></a>` : ''}${rec ? `<a href="#results">${plural(rec, 'positive reply', 'positive replies')} this week</a>` : '<span class="muted">No positive reply this week</span>'}<a href="#alerts">All alerts (${open.length})</a></div>`,
      { sub: open.length ? plural(open.length, 'open alert') : '' });
  }
  function recentCard() {
    const list = S.jobs.slice().sort((a, b) => b.end - a.end).slice(0, 8);
    return card('Latest jobs', list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ended</th><th>Posting</th><th class="opt">Site</th><th class="opt">Driver</th><th class="num opt">Took</th><th>Result</th></tr></thead><tbody>${list.map((j) => row('openJob', j.uid,
      `<td class="mono nowrap">${hhmm(j.end)}</td><td class="cell-main"><b>${esc(j.company)}</b><span>${esc(j.role)}</span></td><td class="opt">${esc(j.siteName)}</td><td class="opt mono">${esc(drvName(j.driver))}</td><td class="num opt">${dur((j.end - j.start) / MIN)}</td><td>${rpill(j.result)}</td>`)).join('')}</tbody></table></div>
      <div class="card-foot"><span class="muted">Select a row for its documents and what happened</span><a href="#applications">All applications</a></div>` : empty('table', 'No job yet', 'Jobs show here as soon as they end.'), { cls: 'span-2', flush: true });
  }
  function comingCard() {
    const now = Date.now(), r = S.run, ev = [];
    if (r.state === 'running') {
      const per = r.done ? (now - r.start) / (r.done + 0.5) : 10 * MIN;
      ev.push({ t: r.stopAfter ? now + per * 0.5 : now + per * (r.planned - r.done - 0.5), text: r.stopAfter ? 'Round ' + r.id + ' stops after this job' : 'Round ' + r.id + ' should end' });
    }
    if (S.burn && r.state === 'idle') { const t = Math.ceil(now / (10 * MIN)) * 10 * MIN; ev.push({ t, text: 'The burn timer looks again (it starts a round if a driver may apply)' }); }
    // Calendar days (setDate), so a clock change never shifts the time.
    const at = (hm, dow) => { const [h, m] = hm.split(':').map(Number); const d = new Date(now); d.setHours(h, m, 0, 0); while (d.getTime() <= now || (dow != null && d.getDay() !== dow)) { d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); } return d.getTime(); };
    // The tasks' real next runs, as Windows reports them; the usual times only when none was read.
    const T = (n) => (S.tasks.find((x) => x.name === n) || {}).next;
    ev.push({ t: T('FreeMotion scan') || at('06:00'), text: 'Daily scan of every source, then the reply check' });
    ev.push({ t: T('FreeMotion weekly') || at('09:00', 1), text: 'Weekly lessons report' });
    const resets = [];
    for (const d of S.drivers) for (const w of WINDOWS) { const x = d.windows[w.k]; if (x && x.reset > now && x.used >= 40 && !d.off && !d.expired) resets.push({ t: x.reset, text: d.id + ': ' + w.label.toLowerCase() + ' resets' }); }
    resets.sort((a, b) => a.t - b.t);
    const list = ev.concat(resets.slice(0, 3)).sort((a, b) => a.t - b.t).slice(0, 6);
    return card('Coming up', `<ul class="timeline">${list.map((e) => `<li><span class="mono">${when(e.t)}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>`);
  }
  function driversMini() {
    return card('Drivers', `<ul class="dmini">${S.drivers.map((d) => { const s = status(d); return `<li><button type="button" data-act="openDriver" data-arg="${d.id}"><span class="mono">${d.id}</span>${spill(s)}<span class="muted dm-why" data-tip="${esc(s.why)}">${esc(s.why)}</span></button></li>`; }).join('')}</ul>`,
      { right: `<a href="#drivers" class="link-sm">Open</a>`, sub: 'In the order the next round tries them' });
  }

  // ---- Live job --------------------------------------------------------------------------------
  const LOG_IC = { next: 'right', act: 'flag', res: 'info', bad: 'xcircle' };
  function vLive() {
    const r = S.run, c = r.current;
    if (!c) {
      const last = r.lastRun;
      const txt = r.state === 'choosing' ? 'Round ' + esc(r.id || '') + ' is choosing its jobs. The first one starts in a few minutes.'
        : (last ? 'Round ' + esc(last.id) + ' ended ' + when(last.end) + '. ' : '') + (S.burn ? 'The burn timer starts the next one when a driver may apply.' : 'The burn timer is off.');
      return pageHead('Live job', 'Follow the job in hand as the driver works.') + card('', empty('pulse', r.state === 'choosing' ? 'Starting a round' : 'No job is running', txt,
        btn('Start a round', 'askStart', { kind: 'primary', icon: 'play', disabled: r.state !== 'idle' || !online(), tip: offlineTip() }) + (last ? btn('Open round ' + last.id, 'openRun', { arg: last.id }) : '')));
    }
    const rj = runJobs(r.id).sort((a, b) => b.end - a.end);
    const log = (c.log || []).slice().reverse();
    const logBody = c.hasLog ? `<ol class="log">${log.map((l) => `<li class="lg-${l.kind}"><span class="mono">${hhmm(l.t)}:${pad(new Date(l.t).getSeconds())}</span><span class="lg-ic">${icon(LOG_IC[l.kind] || 'info')}</span><span>${l.kind === 'next' ? `<b>${esc(l.text)}</b>${l.why ? `<span class="lg-why">${esc(l.why)}</span>` : ''}` : l.kind === 'act' ? `<span class="mono lg-tool">${esc(l.tool)}</span> ${esc(l.text)}` : esc(l.text)}</span></li>`).join('')}</ol>`
      : empty('pulse', c.phase === 0 ? 'Writing the documents' : c.driver && !/^agy/.test(c.driver) ? drvName(c.driver) + ' keeps no live log' : 'Waiting for the first step', c.phase === 0 ? 'The CV and the letter for this posting are being written and checked. That takes about two minutes.' : c.driver && !/^agy/.test(c.driver) ? 'Only agy writes its steps as it goes. This job shows its result when it ends.' : 'The driver’s steps appear here as it works.');
    const facts = `<dl class="kv">${[['Job', '<span class="mono">' + c.job + '</span>'], ['Round', r.id ? `<button type="button" class="link" data-act="openRun" data-arg="${r.id}">${r.id}</button>` : '—'],
      ['Site', esc(c.siteName)], ['Place', esc(c.place || '—')], ['Driver', c.driver ? `<button type="button" class="link mono" data-act="openDriver" data-arg="${c.driver}">${esc(drvName(c.driver))}</button>` : '<span class="muted">not started yet</span>'], ['Fit score', fitText(c.fit) + ' / 5'],
      ['Started', hhmm(c.start)], ['Time on it', since(c.start)]].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <div class="url-row"><a class="mono url" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.url)}</a>${btn('', 'copy', { arg: c.url, icon: 'copy', sm: true, aria: 'Copy the posting link', tip: 'Copy the posting link' })}</div>`;
    const docs = c.cv ? `<dl class="kv">${[['CV', ARMS.cv[c.cv.arm] + (c.cv.writer ? ' · written by ' + writer(c.cv.writer) : ' · not tailored')], ['Letter', c.letter.arm === 'none' ? 'No letter for this posting' : ARMS.letter[c.letter.arm] + ' · ' + c.letter.words + ' words · by ' + writer(c.letter.writer)]].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <div class="dr-acts">${fileBtn('cv', c.job, 'CV', 'file')}${c.letter.arm !== 'none' ? fileBtn('letter', c.job, 'letter', 'file') : ''}${fileBtn('shot', c.job, 'last screenshot', 'image')}</div>` : '<p class="muted">Being written now.</p>';
    const ps = pending('stop-after-job'), pn = pending('stop-now');
    const ctl = `<div class="ctls">
      <div class="ctl"><div><b>Stop after this job</b><span>${r.stopAfter ? 'The round ends with this job.' : 'The round goes on.'}</span></div>${sw(r.stopAfter, 'toggleStopAfter', 'Stop after this job', { busy: !!ps, disabled: !online(), tip: offlineTip() })}</div></div>
      <div class="ctl-a">${btn(pn ? 'Stopping…' : 'Stop this job now', 'askStopNow', { kind: 'danger', icon: 'stop', busy: !!pn, disabled: !online(), tip: offlineTip() })}</div>`;
    const doneTbl = rj.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ended</th><th>Posting</th><th class="opt">Driver</th><th>Result</th></tr></thead><tbody>${rj.slice(0, 8).map((j) => row('openJob', j.uid,
      `<td class="mono">${hhmm(j.end)}</td><td class="cell-main"><b>${esc(j.company)}</b><span>${esc(j.role)}</span></td><td class="opt mono">${esc(drvName(j.driver))}</td><td>${rpill(j.result)}</td>`)).join('')}</tbody></table></div>` : empty('table', 'Nothing finished yet', 'This is the round’s first job.');
    const q = S.queue.filter((x) => !x.skipped);
    const next = q.length ? `<ol class="upnext">${q.slice(0, 5).map((x, i) => `<li><span class="mono muted">${i + 1}</span><span class="cell-main"><b>${esc(x.company)}</b><span>${esc(x.role)} · ${esc(x.siteName)}</span></span><span class="mono">${fitText(x.fit)}</span></li>`).join('')}</ol><div class="card-foot"><span class="muted">${plural(q.length, 'job')} left</span><a href="#queue">Open the queue</a></div>` : empty('queue', 'Last job of the round', 'Nothing is queued after this one.');
    return pageHead('Live job', 'Job ' + c.job + (r.id ? ' · round ' + r.id + ', job ' + (r.done + 1) + ' of ' + r.planned : '')) +
      card('', `<div class="lh"><div class="lh-t"><span class="eyebrow">Applying now</span><h2>${esc(c.role)}</h2><p>${esc(c.company)}${c.place ? ' · ' + esc(c.place) : ''} · ${esc(c.siteName)}${c.driver ? ' · <span class="mono">' + esc(drvName(c.driver)) + '</span>' : ''}</p></div><div class="lh-c"><span class="muted">Time on this job</span><span class="big-clock">${since(c.start)}</span></div></div>${stepper(c, true)}`, { cls: 'live-head' }) +
      `<div class="grid g-3">${card('What the driver is doing', logBody, { sub: c.hasLog ? 'Newest first: its next step and why, each browser action, and what came back.' : '', cls: 'span-2', id: 'logcard' })}<div class="stack">${card('This job', facts)}${card('Documents', docs)}${card('Controls', ctl)}</div></div>
      <div class="grid g-2">${card('Finished in this round', doneTbl, { flush: true, sub: rj.length ? runStats(r.id).sent + ' sent of ' + rj.length : '' })}${card('Up next', next, { flush: true, sub: 'In the order the round takes them' })}</div>`;
  }

  // ---- Queue & scan ----------------------------------------------------------------------------
  function vQueue() {
    const f = S.f.queue, r = S.run, running = r.state === 'running';
    const tabs = `<div class="tabs" role="tablist">${[['next', 'This round', S.queue.filter((q) => !q.skipped).length], ['pool', 'Pool', S.poolTotal], ['scan', 'Last scan', null]].map(([k, l, n]) => `<button type="button" role="tab" aria-selected="${f.tab === k}" data-act="set" data-arg="f.queue.tab=${k}">${l}${n != null ? `<span class="nb">${num(n)}</span>` : ''}</button>`).join('')}</div>`;
    let body = '';
    if (f.tab === 'next') {
      const per = running && r.done ? (Date.now() - r.start) / (r.done + 0.5) : 10 * MIN, n = S.queue.filter((q) => !q.skipped).length;
      body = card('', S.queue.length ? queueTable(S.queue, true) : empty('queue', running ? 'Nothing left in this round' : 'No round is running', running ? 'The job in hand is the last one.' : 'A round fills this list from the pool when it starts.', running ? '' : btn('Start a round', 'askStart', { kind: 'primary', icon: 'play', disabled: !online() })),
        { flush: true, sub: running ? `${plural(n, 'job')} after the one in hand · about ${dur(per * n / MIN)} at ${dur(per / MIN)} a job` : '' });
    } else if (f.tab === 'pool') {
      body = card('', S.pool.length ? queueTable(S.pool.slice(0, 80), false) + `<div class="card-foot"><span class="muted">Showing the best ${Math.min(80, S.pool.length)} of ${num(S.poolTotal)}. The next round takes the best that pass its checks.</span></div>` : empty('scan', 'The pool is empty', 'Run a scan to find new postings.', btn('Scan now', 'askScan', { kind: 'primary', icon: 'scan', disabled: !online() })),
        { flush: true, sub: `Postings the rules kept, best first${S.poolAt ? ', as ranked ' + when(S.poolAt) : ''}. A round builds it again before it starts.` });
    } else body = scanView();
    const ps = pending('scan');
    return pageHead('Queue & scan', 'What the round applies to next, and what the scans found.', btn(ps ? (ps.message && ps.status === 'running' ? 'Scanning…' : 'Scan sent…') : 'Scan now', 'askScan', { icon: 'scan', busy: !!ps, disabled: !online(), tip: offlineTip() })) + tabs + body;
  }
  function queueTable(list, inRound) {
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${inRound ? '<th class="num">#</th>' : '<th class="num">Rank</th>'}<th>Posting</th><th class="opt">Site</th><th class="opt">Place</th><th class="num">Fit</th><th class="act-col"><span class="sr">Actions</span></th></tr></thead><tbody>${list.map((q, i) => {
      const ps = inRound && pending('skip', (a) => (a.urls || []).includes(q.url));
      const black = isBlack(q.company);
      return `<tr class="${q.skipped ? 'is-skipped' : ''}">
      <td class="num mono">${inRound ? i + 1 : q.rank}</td><td class="cell-main"><b>${esc(q.company)}</b><span>${esc(q.role)}${q.skipped ? ' · taken out of this round' : ''}</span></td><td class="opt">${esc(q.siteName)}</td><td class="opt">${esc(q.place || '—')}</td>
      <td class="num"><span class="fit"><span class="fit-b"><b style="width:${q.fit == null ? 0 : q.fit * 20}%"></b></span><span class="mono">${fitText(q.fit)}</span></span></td>
      <td class="act-col"><div class="row-acts">${inRound ? btn('', 'queueSkip', { arg: q.url, icon: q.skipped ? 'undo' : 'skip', sm: true, busy: !!ps, disabled: !online(), aria: (q.skipped ? 'Put ' + q.company + ' back in' : 'Take ' + q.company + ' out of') + ' this round', tip: q.skipped ? 'Put it back in this round' : 'Take it out of this round' }) : ''}${btn('', 'askBlack', { arg: q.company, icon: 'ban', sm: true, disabled: black || !online(), aria: 'Blacklist ' + q.company, tip: black ? 'Already on the blacklist' : 'Blacklist the company' })}</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  const DROPS = [['filtered_title', 'Title is not a target role'], ['filtered_blacklist', 'Company is on the blacklist'], ['dupes', 'Seen in an earlier scan'], ['filtered_location', 'Location outside the targets'],
    ['filtered_content', 'Posting text broke a content rule'], ['filtered_country_eligibility', 'Not open to candidates in France'], ['filtered_posting_age', 'Posting too old'], ['filtered_posted_date', 'Posted date outside the window'],
    ['filtered_salary', 'Salary below the floor'], ['filtered_visa', 'Needs a visa'], ['filtered_tier', 'Company tier'], ['filtered_cooldown', 'Company on cooldown']];
  function scanView() {
    const sc = S.scans[0], ps = pending('scan');
    const run = ps ? `<div class="callout t-info">${icon('scan')}<div><b>${ps.status === 'running' ? 'Scanning' : 'Scan ' + esc(statusWord(ps))}.</b> ${esc(ps.message && ps.message !== 'Started' ? ps.message : 'It reads every source, then builds the pool.')}</div></div>` : '';
    if (!sc) return run + card('', empty('scan', 'No scan recorded', 'Run one to see where postings come from.'));
    const found = sc.found || 0, added = sc.new_added || 0;
    const drops = DROPS.map(([k, l]) => ({ label: l, v: +sc[k] || 0 })).filter((d) => d.v).sort((a, b) => b.v - a.v);
    const dropped = sum(drops.map((d) => d.v));
    const funnel = hbars([
      { label: 'Listings found', v: found, cls: 'o1', tip: 'Every listing the sources returned' },
      { label: 'New after the filters', v: added, cls: 'o2', tip: pct(added, found, 1) + ' of the listings found' },
      { label: 'In the pool now', v: S.poolTotal, cls: 'o3', tip: 'Kept by the rules and ranked, from every scan so far' },
      { label: 'In this round', v: S.queue.length + (S.run.current ? 1 : 0) + S.run.done, cls: 'o4', tip: 'The round’s list' },
    ], { cls: 'funnel' });
    const hist = S.scans.slice(0, 14).map((h) => `<tr><td class="nowrap">${when(h.at)}</td><td class="num">${num(h.found || 0)}</td><td class="num">${num(h.new_added || 0)}</td><td class="num opt">${num(h.companies || 0)}</td><td>${h.status === 'completed' && !(h.errors > 0) ? pill('ok', 'Complete') : h.status === 'completed' ? pill('warn', 'Some errors', h.errors + ' sources answered with an error') : pill('bad', cap(h.status || 'failed'))}${h.errors ? `<span class="muted cell-note">${h.errors} source errors</span>` : ''}</td></tr>`).join('');
    return run + `<div class="tiles small">
      ${tileStatic('Last scan', when(sc.at), sc.companies ? sc.companies + ' companies, ' + (sc.boards || 0) + ' job boards' : '')}
      ${tileStatic('Listings found', num(found), sc.errors ? sc.errors + ' source errors' : 'no source error')}
      ${tileStatic('New after the filters', num(added), pct(added, found, 1) + ' of what was found')}
      ${tileStatic('In the pool', num(S.poolTotal), S.poolAt ? 'ranked ' + when(S.poolAt) : '')}</div>
      <div class="grid g-2">${card('From listings to the round', funnel, { sub: 'The first two bars are this scan; the pool gathers every scan' })}${card('Why listings were dropped', drops.length ? hbars(drops.map((d) => Object.assign(d, { tip: pct(d.v, found, 1) + ' of all listings' }))) : '<p class="muted">Nothing was dropped.</p>', { sub: num(dropped) + ' dropped by the filters' })}</div>
      ${card('Recent scans', `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Started</th><th class="num">Found</th><th class="num">New</th><th class="num opt">Companies</th><th>Status</th></tr></thead><tbody>${hist}</tbody></table></div>`, { flush: true, sub: 'The scheduled one runs every day at 06:00' })}`;
  }
  const tileStatic = (l, v, s) => `<div class="tile static"><span class="tile-l">${esc(l)}</span><span class="tile-v">${v}</span><span class="tile-s muted">${esc(s)}</span></div>`;

  // ---- Applications ----------------------------------------------------------------------------
  // A search looks through every application, not only the time range, and through what the employers wrote.
  const REPLY_F = { positive: (a) => lrank(a.level) >= lrank('contacted'), answered: (a) => !!a.first, rejected: (a) => a.rejected, none: (a) => !a.first };
  function appsFiltered(skipResults) {
    const f = S.f.apps, q = fold(f.q.trim()), from = f.run || q ? 0 : rangeStart(f.range);
    const said = (j) => (j.reply ? j.reply.reactions.map((x) => x.who + ' ' + x.summary).join(' ') : '');
    return S.jobs.filter((j) => j.end >= from && (!f.run || j.round === f.run) && (!f.site || j.site === f.site) && (!f.driver || j.driver === f.driver)
      && (skipResults || !f.results.length || f.results.includes(j.result))
      && (!f.reply || (isSent(j) && REPLY_F[f.reply](answerOf(j))))
      && (!q || fold(j.company + ' ' + j.role + ' ' + j.place + ' ' + j.id + ' ' + j.siteName + ' ' + said(j)).includes(q)));
  }
  /** Companies whose name holds the search words, most applications first. */
  function companiesFor(q) {
    const k = ckey(q);
    if (k.length < 2) return [];
    const by = new Map();
    const add = (name, j, x) => { const c = ckey(name); if (!c.includes(k)) return; const e = by.get(c) || by.set(c, { name, jobs: 0, sent: 0, best: '', rejected: 0, last: 0 }).get(c);
      if (j) { e.jobs++; if (isSent(j)) e.sent++; e.last = Math.max(e.last, j.end); }
      if (x) { if (x.level === 'rejected') e.rejected++; else if (lrank(x.level) > lrank(e.best)) e.best = x.level; } };
    S.jobs.forEach((j) => add(j.company, j, null));
    S.reactions.forEach((x) => add(x.company, null, x));
    return [...by.values()].sort((a, b) => b.jobs - a.jobs).slice(0, 4);
  }
  function vApps() {
    const f = S.f.apps, base = appsFiltered(true), list = appsFiltered(false);
    const counts = {}; RESULT_ORDER.forEach((k) => { counts[k] = 0; }); base.forEach((j) => { counts[j.result]++; });
    const key = { start: (j) => j.end, company: (j) => fold(j.company), site: (j) => j.siteName, mins: (j) => j.end - j.start, result: (j) => RESULT_ORDER.indexOf(j.result), fit: (j) => (j.fit == null ? -1 : j.fit), driver: (j) => j.driver };
    const k = key[f.sort];
    list.sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0) * f.dir || b.end - a.end);
    const pages = Math.max(1, Math.ceil(list.length / f.size)); if (f.page > pages) f.page = pages;
    const from = (f.page - 1) * f.size, shown = list.slice(from, from + f.size), sent = list.filter(isSent).length;
    const active = f.q || f.results.length || f.reply || f.site || f.driver || f.run || f.range !== '30d';
    const th = (label, kk, cls) => { const on = f.sort === kk; return `<th class="${cls || ''}" aria-sort="${on ? (f.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-sort${on ? ' on' : ''}" data-act="sort" data-arg="${kk}">${label}${icon(on && f.dir > 0 ? 'up' : 'down')}</button></th>`; };
    const drivers = [...new Set(S.jobs.map((j) => j.driver))].sort();
    const filters = `<div class="filters">
      <div class="search inline">${icon('search')}<input id="apps-q" type="search" placeholder="Company, role, place or job number" aria-label="Search applications" value="${esc(f.q)}" data-model="f.apps.q" autocomplete="off"></div>
      ${f.q && !f.run ? '<span class="muted al-auto">Searching every application, any date</span>' : f.run ? `<span class="chip lead">Round ${esc(f.run)}<button type="button" class="chip-x" data-act="set" data-arg="f.apps.run=" aria-label="Remove the round filter">${icon('x')}</button></span>` : seg('f.apps.range', f.range, [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']], 'Time range')}
      <label class="sel"><span class="sr">Site</span><select id="apps-site" data-model="f.apps.site"><option value="">All sites</option>${sites().map(([id, name]) => `<option value="${esc(id)}"${f.site === id ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select></label>
      <label class="sel"><span class="sr">Reply</span><select id="apps-reply" data-model="f.apps.reply"><option value="">Any reply</option>${[['positive', 'Positive reply (contacted or further)'], ['answered', 'Any answer'], ['rejected', 'Rejected'], ['none', 'No answer yet']].map(([v, l]) => `<option value="${v}"${f.reply === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="sel"><span class="sr">Driver</span><select id="apps-driver" data-model="f.apps.driver"><option value="">All drivers</option>${drivers.map((d) => `<option value="${esc(d)}"${f.driver === d ? ' selected' : ''}>${esc(drvName(d))}</option>`).join('')}</select></label>
      ${active ? btn('Clear filters', 'clearApps', { kind: 'ghost', sm: true, icon: 'x' }) : ''}</div>
      <div class="rchips" role="group" aria-label="Result">${RESULT_ORDER.map((r) => `<button type="button" class="rchip t-${RESULTS[r].tone}" aria-pressed="${f.results.includes(r)}" data-act="toggleResult" data-arg="${r}"><i></i>${RESULTS[r].label}<span class="mono">${num(counts[r])}</span></button>`).join('')}</div>`;
    const table = shown.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${th('Ended', 'start', 'nowrap')}${th('Posting', 'company')}${th('Site', 'site', 'opt')}${th('Driver', 'driver', 'opt')}${th('Fit', 'fit', 'num opt')}${th('Took', 'mins', 'num opt')}<th class="opt">Documents</th>${th('Result', 'result')}<th>Reply</th></tr></thead><tbody>${shown.map((j) => row('openJob', j.uid,
      `<td class="nowrap"><span class="mono">${hhmm(j.end)}</span><span class="cell-sub">${esc(shortDay(j.end))}</span></td><td class="cell-main"><b>${esc(j.company)}</b><span>${esc(j.role)}${j.place ? ' · ' + esc(j.place) : ''}</span></td><td class="opt">${esc(j.siteName)}</td><td class="opt mono">${esc(drvName(j.driver))}</td><td class="num opt mono">${fitText(j.fit)}</td><td class="num opt">${dur((j.end - j.start) / MIN)}</td>
      <td class="opt docs-cell"><span>${esc(ARMS.cv[j.cv.arm] || j.cv.arm)}</span><span class="muted">${esc(ARMS.letter[j.letter.arm] || j.letter.arm)}</span></td><td>${rpill(j.result)}</td><td>${replyCell(j)}</td>`)).join('')}</tbody></table></div>
      <div class="pager"><label class="sel sm"><span>Rows</span><select id="apps-size" data-model="f.apps.size">${[25, 50, 100].map((n) => `<option${f.size === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label><span class="mono">${num(from + 1)}–${num(from + shown.length)} of ${num(list.length)}</span>${btn('', 'page', { arg: -1, icon: 'left', sm: true, disabled: f.page <= 1, aria: 'Previous page' })}${btn('', 'page', { arg: 1, icon: 'right', sm: true, disabled: f.page >= pages, aria: 'Next page' })}</div>`
      : empty('search', 'No application matches', 'Try fewer filters or another word.', btn('Clear filters', 'clearApps', { kind: 'primary' }));
    const cos = f.q ? companiesFor(f.q) : [];
    const coCard = cos.length ? card('Companies that match', `<div class="co-hits">${cos.map((c) => `<button type="button" class="co-hit" data-act="openCompany" data-arg="${esc(c.name)}"><b>${esc(c.name)}</b>
      <span class="muted">${plural(c.jobs, 'application')}, ${c.sent} sent${c.last ? ' · last ' + esc(shortDay(c.last)) : ''}</span><span class="co-st">${c.best ? lpill(c.best) : '<span class="muted">No positive reply</span>'}${c.rejected ? '<span class="muted">' + plural(c.rejected, 'rejection') + '</span>' : ''}</span></button>`).join('')}</div>`, { sub: 'Open one to see every application, reply and person' }) : '';
    return pageHead('Applications', `Every job the drivers finished. <b>${num(list.length)}</b> match, ${num(sent)} of them sent (${pct(sent, list.length)}).`) + card('', filters, { cls: 'filter-card' }) + coCard + card('', table, { flush: true });
  }

  // ---- Runs ------------------------------------------------------------------------------------
  function vRuns() {
    const f = S.f.runs, from = rangeStart(f.range), r = S.run;
    const list = S.runs.filter((x) => x.start >= from && x.ended !== 'running').slice().sort((a, b) => b.start - a.start);
    const stats = list.map((x) => Object.assign({ run: x }, runStats(x.id)));
    const jobs = sum(stats.map((s) => s.jobs)), sent = sum(stats.map((s) => s.sent)), early = list.filter((x) => x.ended !== 'finished').length;
    const allMins = stats.filter((s) => s.jobs).map((s) => s.mins * s.jobs);
    const rows = [];
    const live = S.runs.find((x) => x.ended === 'running');
    if (live) {
      const s = runStats(live.id);
      rows.push(row('openRun', live.id, `<td class="mono">${live.id}</td><td class="nowrap">${when(live.start)}</td><td class="opt">${esc(live.by)}</td><td class="num opt">${since(live.start)}</td><td class="num">${s.jobs + (r.current ? 1 : 0)} / ${r.planned || live.planned}</td><td class="num">${s.sent}</td><td class="num opt">${pct(s.sent, s.jobs)}</td><td class="opt">${s.drivers.slice(0, 3).map(([d]) => `<span class="tag mono">${esc(drvName(d))}</span>`).join('')}</td><td>${pill('info', 'Running')}</td>`, 'is-live'));
    }
    stats.forEach((s) => { const x = s.run; rows.push(row('openRun', x.id, `<td class="mono">${x.id}</td><td class="nowrap">${when(x.start)}</td><td class="opt">${esc(x.by)}</td><td class="num opt">${dur((x.end - x.start) / MIN)}</td><td class="num">${s.jobs} / ${x.planned || '—'}</td><td class="num">${s.sent}</td><td class="num opt">${pct(s.sent, s.jobs)}</td><td class="opt">${s.drivers.slice(0, 3).map(([d]) => `<span class="tag mono">${esc(drvName(d))}</span>`).join('')}</td><td>${ended(x.ended)}</td>`)); });
    const tmin = dailyMedian(30, (j) => (j.end - j.start) / MIN);
    const tsteps = dailyMedian(30, (j) => j.steps, (j) => FAMILY[j.driver] === 'agy');
    const fmtMin = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + ' min';
    const showT = S.ui.chart.time, showS = S.ui.chart.steps;
    const timeCard = card('Time per sent job', tmin.series.length ? (showT ? trendTable(tmin.days, tmin.series, fmtMin) : legend(tmin.series.map((x) => [x.cls, x.label])) + trendChart(tmin.days, tmin.series, { fmt: fmtMin, label: 'Minutes per sent job, daily median, by driver' })) : empty('runs', 'No sent job in 30 days', ''),
      { sub: 'Daily median of the last 30 days (days with 3 sent jobs or more), from the driver’s start to its result. Writing the CV and letter (about 2 min) comes first and is not counted.', right: seg('ui.chart.time', showT ? 'true' : '', [['', 'Chart'], ['true', 'Table']], 'View'), cls: 'span-2' });
    const agySteps = tsteps.series.find((x) => x.key === 'agy');
    const stepsCard = card('agy: steps per sent job', agySteps ? (showS ? trendTable(tsteps.days, [agySteps], (v) => String(Math.round(v))) : trendChart(tsteps.days, [agySteps], { fmt: (v) => String(Math.round(v)), label: 'agy steps per sent job, daily median', narrow: true })) : empty('runs', 'No agy step log in 30 days', ''),
      { sub: 'One step is one “next, because” line in agy’s log. Each takes about 8 seconds, so more steps means a longer job.', right: seg('ui.chart.steps', showS ? 'true' : '', [['', 'Chart'], ['true', 'Table']], 'View') });
    // The agy model test: every agy job draws Flash High or Medium (agy-jobs.mjs); jobs from before it ran on the default.
    const modelName = (m) => ({ 'gemini-3.8-flash-high': 'Flash High', 'gemini-3.8-flash-medium': 'Flash Medium', 'gemini-3.8-flash-low': 'Flash Low', 'claude-sonnet-4-6': 'Claude Sonnet 4.6' }[m] || m || 'unknown');
    const mg = {};
    for (const j of S.jobs) {
      if (!j.agy || !(j.agy.model || j.agy.asked)) continue;   // no model seen: agy stopped before its first answer
      const k = (j.agy.asked ? '1' : '0') + (j.agy.model || j.agy.asked);
      const g = mg[k] ||= { k, label: modelName(j.agy.model || j.agy.asked) + (j.agy.asked ? '' : ' (before the test)'), jobs: 0, sent: 0, mins: [], tools: [], calls: 0, fails: 0 };
      g.jobs++; g.calls += j.agy.tools; g.fails += j.agy.fails;
      if (isSent(j)) { g.sent++; g.mins.push((j.end - j.start) / MIN); g.tools.push(j.agy.tools); }
    }
    const mrows = Object.values(mg).filter((g) => g.jobs >= 3).sort((a, b) => b.k.localeCompare(a.k));
    const testing = mrows.some((g) => g.k[0] === '1');
    const modelCard = card('agy model test', mrows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Model</th><th class="num">Jobs</th><th class="num">Sent rate</th><th class="num">Time per sent job</th><th class="num opt">Tool calls per sent job</th><th class="num opt">Failed tool calls</th></tr></thead><tbody>${mrows.map((g) => `<tr><td>${esc(g.label)}</td><td class="num">${num(g.jobs)}</td><td class="num">${pct(g.sent, g.jobs)}</td><td class="num">${g.mins.length ? fmtMin(median(g.mins)) : '—'}</td><td class="num opt">${g.tools.length ? Math.round(median(g.tools)) : '—'}</td><td class="num opt">${pct(g.fails, g.calls, 1)}</td></tr>`).join('')}</tbody></table></div>` : empty('runs', 'No agy job recorded yet', ''),
      { sub: (testing ? 'Each agy job draws Gemini 3.8 Flash High or Medium, 50/50.' : 'From the next round, each agy job draws Gemini 3.8 Flash High or Medium, 50/50.') + ' Times and tool calls are medians over sent jobs. A model needs about 30 sent jobs before the difference means much.', cls: 'span-3' });
    return pageHead('Runs', 'Each round of applications, from its start to how it ended.', seg('f.runs.range', f.range, [['7d', '7 days'], ['30d', '30 days'], ['all', 'All']], 'Time range')) +
      `<div class="grid g-3">${timeCard}${stepsCard}${modelCard}</div><div class="tiles small">${tileStatic('Rounds ended', num(list.length), early + ' ended early')}${tileStatic('Sent per round', list.length ? (sent / list.length).toFixed(1) : '—', 'average')}${tileStatic('Sent rate', pct(sent, jobs), num(sent) + ' of ' + num(jobs) + ' jobs')}${tileStatic('Time per job', allMins.length ? dur(sum(allMins) / jobs) : '—', 'average, documents included')}</div>` +
      card('', rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Round</th><th>Started</th><th class="opt">Started by</th><th class="num opt">Took</th><th class="num">Jobs</th><th class="num">Sent</th><th class="num opt">Sent rate</th><th class="opt">Drivers</th><th>How it ended</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : empty('runs', 'No rounds in this range', 'Pick a longer range.'), { flush: true });
  }

  // ---- Results ---------------------------------------------------------------------------------
  function vResults() {
    const f = S.f.results, now = Date.now(), from = rangeStart(f.range), st = replyStats(from, now);
    const sentAll = S.jobs.filter((j) => isSent(j) && j.end >= from).length;
    const funnel = hbars([
      { label: 'Sent, 2+ days ago', v: st.n, cls: 'o1', tip: 'Applications old enough to have an answer' },
      { label: 'Got an answer', v: st.answered, cls: 'o2', tip: pct(st.answered, st.n, 1) + ' of sent: rejections, replies and interviews' },
      ...LEVELS.map(([k, label, , tip], i) => ({ label: i ? label + ' or further' : 'Viewed or further', v: st.reached[i], cls: i < 1 ? 'o2' : i < 4 ? 'o3' : 'o4', tip: tip + '. ' + pct(st.reached[i], st.n, 1) + ' of sent got this far.' })),
    ], { cls: 'funnel' });
    const by = (k, arms) => arms.map((a) => [a, st.old.filter((j) => j[k].arm === a)]);
    const siteRows = sites().map(([id, name]) => {
      const tried = S.jobs.filter((j) => j.site === id && j.end >= from), sent = st.old.filter((j) => j.site === id);
      return { id, name, tried: tried.length, sentRate: pct(tried.filter(isSent).length, tried.length), n: sent.length,
        ans: sent.filter((j) => j.reply && j.reply.outcome).length, pos: sent.filter((j) => j.reply && (j.reply.outcome === 'interview' || j.reply.outcome === 'positive')).length };
    }).filter((x) => x.tried).sort((a, b) => b.n - a.n || b.tried - a.tried);
    const restSites = siteRows.splice(12);
    const rest = restSites.length ? restSites.reduce((o, x) => ({ tried: o.tried + x.tried, n: o.n + x.n, ans: o.ans + x.ans, pos: o.pos + x.pos }), { tried: 0, n: 0, ans: 0, pos: 0 }) : null;
    const jobFor = (url) => (url ? S.jobs.find((j) => j.url === url) : null);
    const who = (x) => (x.source === 'you' ? 'you told' : 'email') + (x.by && x.by !== 'you' ? ' · read by ' + (x.by === 'rules' ? 'the wording rules' : x.by) : '');
    const posting = (x) => { const j = jobFor(x.url), co = x.company || (j && j.company) || ''; return (co ? coLink(co) : '<b>Unknown company</b>') + (x.role ? (j ? ` · <button type="button" class="link sub" data-act="openJob" data-arg="${j.uid}" data-tip="Open this application">${esc(x.role)}</button>` : `<span class="muted"> · ${esc(x.role)}</span>`) : x.num ? '' : '<span class="muted"> · no application found</span>'); };
    const recent = S.reactions.filter((x) => !NOT_ANSWER[x.level]).slice(0, 8);
    const repBody = recent.length ? `<ul class="props">${recent.map((x) => `<li>
      <div class="pr-h"><span class="pr-k">${lpill(x.level)}${x.replyNeeded ? pill('warn', 'Answer needed') : ''}</span><span class="muted">${esc(dayLabel(new Date(x.date + 'T12:00').getTime()))}</span></div>
      <div class="pr-f"><span>${posting(x)}</span></div>${x.summary ? `<span class="muted">${esc(x.summary)}</span>` : ''}</li>`).join('')}</ul>` : empty('mail', 'No answers yet', 'Answers show here after the reply check that ends each round.');
    // How long answers take, by week sent and by fit score: did the score predict who answers?
    const facts = st.old.map((j) => Object.assign({ j }, answerOf(j)));
    const days = (a, b) => (b - a) / DAY;
    const dFirst = facts.filter((x) => x.first).map((x) => Math.max(0, days(x.j.end, x.first)));
    const dPos = facts.filter((x) => x.firstPos).map((x) => Math.max(0, days(x.j.end, x.firstPos)));
    const fmtDays = (v) => (v == null ? '—' : v < 1 ? 'under a day' : Math.round(v) + (Math.round(v) === 1 ? ' day' : ' days'));
    const rateBar = (k, n, d) => `<span class="fit rate${n < 20 ? ' thin' : ''}"${n < 20 ? ' data-tip="Fewer than 20 sent: the rate can swing a lot"' : ''}><span class="fit-b"><b style="width:${n ? Math.min(100, 100 * k / n) : 0}%"></b></span><span class="mono">${pct(k, n, d)}</span></span>`;
    const group = (keyOf, label) => { const m = new Map(); for (const x of facts) { const k = keyOf(x.j); if (k == null) continue; (m.get(k) || m.set(k, []).get(k)).push(x); } return [...m].map(([k, xs]) => ({ k, label: label(k), n: xs.length,
      ans: xs.filter((x) => x.first).length, pos: xs.filter((x) => x.firstPos).length, rej: xs.filter((x) => x.rejected).length, med: median(xs.filter((x) => x.first).map((x) => days(x.j.end, x.first))) })); };
    const monday = (t) => { const d = new Date(sod(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
    const weeks = group((j) => monday(j.end), (k) => 'Week of ' + shortDay(k)).sort((a, b) => b.k - a.k);
    const BANDS = [[4, '4 and up'], [3.5, '3.5 to 4'], [3, '3 to 3.5'], [0, 'Under 3']];
    const fits = group((j) => (j.fit == null ? 'none' : BANDS.find(([lo]) => j.fit >= lo)[0]), (k) => (k === 'none' ? 'No score' : BANDS.find(([lo]) => lo === k)[1])).sort((a, b) => (a.k === 'none' ? 1 : b.k === 'none' ? -1 : b.k - a.k));
    const cohortTable = (rows, first) => rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>${first}</th><th class="num">Sent</th><th>Answered</th><th>Positive</th><th class="opt">Rejected</th><th class="num opt">Days to answer</th></tr></thead><tbody>${rows.map((r) => `<tr>
      <td class="nowrap">${esc(r.label)}</td><td class="num">${num(r.n)}</td><td>${rateBar(r.ans, r.n)}</td><td>${rateBar(r.pos, r.n, 1)}</td><td class="opt">${rateBar(r.rej, r.n)}</td><td class="num opt">${r.med == null ? '—' : r.med.toFixed(1)}</td></tr>`).join('')}</tbody></table></div>`
      : empty('chart', 'Nothing sent in this range', 'Pick a longer range.');
    // Every reaction in the range: the positive ones by default.
    const LV = { positive: (x) => lrank(x.level) >= lrank('contacted'), seen: (x) => x.level !== 'rejected', all: () => true };
    const inRange = S.reactions.filter((x) => new Date(x.date + 'T12:00').getTime() >= from && (LV[f.lv] || LV.positive)(x));
    const shown = inRange.slice(0, 200);
    const reactTable = shown.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Application</th><th>Reached</th><th class="opt">Who</th><th>What they said</th><th class="opt">From</th></tr></thead><tbody>${shown.map((x) => `<tr>
        <td class="nowrap">${esc(dayLabel(new Date(x.date + 'T12:00').getTime()))}</td><td>${posting(x)}</td>
        <td class="nowrap">${lpill(x.level)}${x.replyNeeded ? ' ' + pill('warn', 'Answer needed') : ''}</td><td class="opt">${esc(x.who || '—')}</td>
        <td><span${x.evidence ? ` data-tip="${esc('“' + x.evidence + '”')}"` : ''}>${esc(x.summary || (x.evidence ? '“' + x.evidence + '”' : '—'))}</span></td><td class="opt muted nowrap">${esc(who(x))}</td></tr>`).join('')}</tbody></table></div>`
      + (inRange.length > shown.length ? `<p class="muted card-foot">The latest 200 of ${num(inRange.length)}. Pick a shorter range to see older ones.</p>` : '')
      : empty('mail', f.lv === 'positive' ? 'No positive reply in this range' : 'No reaction in this range', 'Each round ends with the reply check, which reads the new emails.');
    return pageHead('Results', 'What employers did with the applications. Only applications at least 2 days old count, so each one had time for an answer.', seg('f.results.range', f.range, [['7d', '7 days'], ['30d', '30 days'], ['all', 'All']], 'Time range')) +
      `<div class="tiles small">${tileStatic('Sent', num(sentAll), num(st.n) + ' old enough to judge')}${tileStatic('Got an answer', pct(st.answered, st.n), num(st.answered) + ' answers')}${tileStatic('Positive answers', pct(st.positive, st.n, 1), num(st.positive) + ' replies or interviews')}${tileStatic('Time to an answer', fmtDays(median(dFirst)), 'median; a positive one: ' + fmtDays(median(dPos)))}</div>
      <div class="grid g-3">${card('From sent to offer', funnel, { sub: 'Each bar counts applications whose furthest step is that one or a later one. A rejection after a call still counts the call.', cls: 'span-2' })}${card('Latest answers', repBody, { sub: 'Read from the employers’ emails by the model, or told by you' })}</div>
      ${card('Replies from employers', reactTable, { sub: 'The model reads each application email once and quotes the words it went by (hover the text). The tracker status follows by itself.', right: seg('f.results.lv', f.lv, [['positive', 'Positive'], ['seen', 'No rejections'], ['all', 'All']], 'Which replies: positive only, everything but rejections, or all'), flush: !!shown.length })}
      <div class="grid g-2">${card('By week sent', cohortTable(weeks, 'Sent in'), { sub: 'Each week’s applications and what came back from them so far. Recent weeks have had less time.', flush: true })}
      ${card('By fit score', cohortTable(fits, 'Fit score'), { sub: 'Does the score the pool gave a posting predict an answer? Higher bands should answer more.', flush: true })}</div>
      <div class="grid g-2">${card('Positive answers by CV', armChart('cv', by('cv', ['generic', 'loose', 'strict'])), { sub: 'The bar is the rate; the line is its 90% range. Overlapping lines can be chance.' })}
      ${card('Positive answers by letter', armChart('letter', by('letter', ['none', 'short', 'full'])), { sub: 'Same reading as the CV chart.' })}</div>` +
      card('By site', `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Site</th><th class="num opt">Jobs tried</th><th class="num opt">Sent rate</th><th class="num">Sent, 2+ days</th><th class="num opt">Answered</th><th class="num">Positive</th></tr></thead><tbody>${siteRows.map((x) => row('goApps', 'site:' + x.id,
        `<td><b>${esc(x.name)}</b></td><td class="num opt">${num(x.tried)}</td><td class="num opt">${x.sentRate}</td><td class="num">${num(x.n)}</td><td class="num opt">${pct(x.ans, x.n)}</td><td class="num">${pct(x.pos, x.n, 1)}</td>`)).join('')}${rest ? `<tr><td><span class="muted">${restSites.length} other sites</span></td><td class="num opt">${num(rest.tried)}</td><td class="num opt">—</td><td class="num">${num(rest.n)}</td><td class="num opt">${pct(rest.ans, rest.n)}</td><td class="num">${pct(rest.pos, rest.n, 1)}</td></tr>` : ''}</tbody></table></div>`, { flush: true, sub: 'Select a site to see its applications' });
  }

  // ---- Drivers ---------------------------------------------------------------------------------
  function vDrivers() {
    const rows = S.drivers.map((d) => {
      const s = status(d), t = driverToday(d), ru = rule(d), pd = pending('driver', (a) => a.id === d.id);
      const rsv = d.lastResort && !d.lastHours ? WINDOWS.filter((w) => d.reserve[w.k]).map((w) => w.col + ' ' + d.reserve[w.k] + '%') : [];
      return `<tr class="row-link" tabindex="0" data-act="openDriver" data-arg="${d.id}">
        <td class="num mono">${d.priority || '—'}</td>
        <td class="cell-main"><b class="mono">${d.id}</b><span>${esc(d.service)}</span></td>
        <td class="st-cell">${spill(s)}<span class="cell-note muted" data-tip="${esc(s.why)}">${esc(s.why)}</span></td>
        ${WINDOWS.map((w) => `<td class="mcell opt">${meter(d.windows[w.k], d.lastResort && !d.lastHours ? d.reserve[w.k] : 0, true)}</td>`).join('')}
        <td class="opt nowrap"><span class="cell-line" data-tip="${esc(ru.text)}">${esc(ru.label)}</span>${rsv.length ? `<span class="cell-sub">keeps ${esc(rsv.join(', '))}</span>` : ''}</td>
        <td class="num nowrap">${plural(t.jobs, 'job')}<span class="cell-sub">${t.sent} sent</span></td>
        <td class="act-col">${btn('', 'toggleDriver', { arg: d.id, icon: d.off ? 'play' : 'stop', sm: true, busy: !!pd, disabled: d.expired || !online(), aria: (d.off ? 'Turn on ' : 'Turn off ') + d.id, tip: d.expired ? 'Its time with the timer ended' : !online() ? offlineTip() : d.off ? 'Turn on: it may take jobs again' : 'Turn off: it takes no new job' })}</td></tr>`;
    }).join('');
    return pageHead('Drivers', 'The agents that apply. Each round tries them in this order: the one whose week resets soonest first, last-resort drivers after. Each follows its rule, read from the burn timer’s settings.') +
      card('', `<div class="tbl-wrap"><table class="tbl drivers"><thead><tr><th class="num">Order</th><th>Driver</th><th>Status</th>${WINDOWS.map((w) => `<th class="opt">${w.col}</th>`).join('')}<th class="opt">Rule</th><th class="num">Today</th><th class="act-col"><span class="sr">Turn on or off</span></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="card-foot keys"><span><i class="k-used"></i>Used</span><span><i class="k-rsv"></i>Reserve, kept back</span><span class="muted">— means no reading of that kind: the service has no such limit, or it does not report it</span></div>`, { flush: true });
  }

  // ---- Alerts ----------------------------------------------------------------------------------
  function visibleAlerts() {
    const f = S.f.alerts;
    return S.alerts.filter((a) => a.state === f.tab && (!f.sev || a.sev === f.sev)).sort((a, b) => SEV[a.sev].rank - SEV[b.sev].rank || b.last - a.last);
  }
  function vAlerts() {
    const f = S.f.alerts, list = visibleAlerts(), cnt = (s) => S.alerts.filter((a) => a.state === s).length;
    const tabs = `<div class="tabs" role="tablist">${[['open', 'Open'], ['snoozed', 'Snoozed'], ['resolved', 'Resolved']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${f.tab === k}" data-act="set" data-arg="f.alerts.tab=${k}">${l}<span class="nb">${cnt(k)}</span></button>`).join('')}</div>`;
    const bulk = f.sel.length ? `<div class="bulk"><span><b>${f.sel.length}</b> selected</span>${f.tab !== 'resolved' ? btn('Resolve', 'alertState', { arg: 'resolve:sel', sm: true, icon: 'check', disabled: !online() }) : ''}${f.tab === 'open' ? btn('Snooze for a day', 'alertState', { arg: 'snooze:sel', sm: true, icon: 'clock' }) : ''}${f.tab !== 'open' ? btn('Reopen', 'alertState', { arg: 'open:sel', sm: true }) : ''}${btn('Clear', 'set', { arg: 'f.alerts.sel=', sm: true, kind: 'ghost' })}</div>` : '';
    const items = list.map((a) => {
      const pa = a.line && pending('alert', (x) => x.line === a.line);
      const acts = a.state === 'open'
        ? btn('Snooze', 'alertState', { arg: 'snooze:' + a.id, sm: true, tip: 'Hide it for a day on this device' }) + (a.auto ? `<span class="muted al-auto" data-tip="It closes by itself 3 hours after the problem last showed">Clears by itself</span>` : btn('Resolve', 'alertState', { arg: 'resolve:' + a.id, sm: true, kind: 'primary', busy: !!pa, disabled: !online(), tip: online() ? 'Ticks it off in the agent inbox' : offlineTip() }))
        : a.state === 'snoozed' ? btn('Reopen', 'alertState', { arg: 'open:' + a.id, sm: true }) : a.line ? btn('Reopen', 'alertState', { arg: 'open:' + a.id, sm: true, busy: !!pa, disabled: !online() }) : '';
      return `<li class="al${f.sel.includes(a.id) ? ' sel' : ''}">
      <label class="cb"><input type="checkbox" id="al-${a.id}" ${f.sel.includes(a.id) ? 'checked' : ''} data-act="selAlert" data-arg="${a.id}"><span class="sr">Select</span></label>
      ${sevIcon(a.sev)}<div class="al-b"><div class="al-t"><b>${esc(a.title)}</b>${pill(SEV[a.sev].tone, SEV[a.sev].label)}</div><p>${esc(a.detail)}</p>
      <span class="muted al-m">${esc(a.source)}${a.first ? ' · first ' + when(a.first) : ''}${a.last && a.last !== a.first ? ' · last ' + agoS(a.last) : ''}${a.count > 1 ? ' · ' + a.count + ' times' : ''}${a.state === 'snoozed' ? ' · snoozed until ' + when(a.snoozeUntil) : ''}</span></div>
      <div class="al-a">${acts}</div></li>`;
    }).join('');
    const head = list.length ? `<div class="al-head"><label class="cb"><input type="checkbox" id="al-all" ${f.sel.length && f.sel.length === list.length ? 'checked' : ''} data-act="selAllAlerts"><span>Select all</span></label>${seg('f.alerts.sev', f.sev, [['', 'All'], ['critical', 'Critical'], ['warning', 'Warning'], ['info', 'Info']], 'Severity')}</div>` : '';
    const msg = { open: ['check', 'No open alerts', 'Problems from runs, scans and the burn timer show up here.'], snoozed: ['clock', 'Nothing snoozed', 'Snoozed alerts come back by themselves after a day.'], resolved: ['check', 'Nothing resolved in the last 30 days', 'Alerts you resolve stay here.'] }[f.tab];
    return pageHead('Alerts', 'Problems that need a person: the agent inbox and the burn timer’s warnings. Resolve what you fixed; snooze what can wait.') + tabs + bulk +
      card('', list.length ? head + `<ul class="alerts">${items}</ul>` : (f.sev ? empty('search', 'No ' + SEV[f.sev].label.toLowerCase() + ' alerts here', 'Show all severities instead.', btn('Show all', 'set', { arg: 'f.alerts.sev=', kind: 'primary' })) : empty(msg[0], msg[1], msg[2])), { flush: true });
  }

  // ---- Activity --------------------------------------------------------------------------------
  function vActivity() {
    const f = S.f.activity, q = fold(f.q.trim());
    const list = S.activity.filter((a) => (!f.actor || a.actor === f.actor) && (!q || fold(a.text).includes(q))).slice(0, 400);
    const groups = [];
    for (const a of list) { const d = sod(a.t); if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] }); groups[groups.length - 1].items.push(a); }
    const today = sod(Date.now());
    const cmdState = (c) => (c.status === 'done' ? `<span class="muted"> · ${esc(c.message)}</span>` : c.status === 'failed' || c.status === 'cancelled' ? ` ${pill('bad', cap(c.status), c.message)}` : ` ${pill('info', cap(statusWord(c)))}`);
    const body = groups.length ? groups.map((g) => `<h3 class="day-h">${g.d === today ? 'Today' : g.d === today - DAY ? 'Yesterday' : dayLabel(g.d)}</h3><ul class="acts">${g.items.map((a) => `<li><span class="mono muted">${hhmm(a.t)}</span><span class="who ${a.actor === 'You' ? 'you' : ''}"${a.by ? ` data-tip="${esc(a.by)}"` : ''}>${a.actor}</span><span class="act-t">${esc(a.cmd ? cmdLabel(a.cmd) : a.text)}${a.cmd ? cmdState(a.cmd) : ''}${a.run ? ` <button type="button" class="link" data-act="openRun" data-arg="${a.run}">Round ${a.run}</button>` : ''}</span></li>`).join('')}</ul>`).join('')
      : empty('clock', 'Nothing matches', 'Try another word or show everyone.');
    return pageHead('Activity', 'Everything you asked for and everything the runs reported, newest first.') +
      card('', `<div class="filters"><div class="search inline">${icon('search')}<input id="act-q" type="search" placeholder="Search activity" aria-label="Search activity" value="${esc(f.q)}" data-model="f.activity.q" autocomplete="off"></div>${seg('f.activity.actor', f.actor, [['', 'Everyone'], ['You', 'You'], ['System', 'System']], 'Who')}</div>`, { cls: 'filter-card' }) + card('', body, { cls: 'act-card' });
  }

  // ---- Preferences -----------------------------------------------------------------------------
  function vPrefs() {
    const p = S.pd, e = S.ui.errors, ch = prefChanges(), b = S.burnRaw || {};
    const field = (id, label, input, help) => `<div class="field${e[id] ? ' has-err' : ''}"><label for="pf-${id}">${label}</label>${input}${e[id] ? `<span class="err" id="pf-${id}-err">${esc(e[id])}</span>` : help ? `<span class="help">${help}</span>` : ''}</div>`;
    const timeIn = (k) => `<input id="pf-${k}" type="time" value="${esc(p.work[k])}" data-model="pd.work.${k}"${e['work' + cap(k)] ? ' aria-invalid="true"' : ''}>`;
    const section = (title, desc, body) => `<section class="pref"><div class="pref-d"><h2>${title}</h2><p>${desc}</p></div><div class="pref-f">${body}</div></section>`;
    const pb = pending('burn'), sv = pending('settings');
    const rules = [['Rounds at least', (b.min_round_gap_minutes || 30) + ' minutes apart'], ['Your Claude account keeps', (b.buffer ?? 10) + '% of each 5-hour window while you work, and ' + (b.week_keep ?? 15) + '% of its week until ' + (b.week_free_hours ?? 24) + ' hours before it resets'],
      ['Copilot', 'about ' + (b.credits_per_job ?? 10) + ' credits a job, spread over the month'], ['Progress emails', b.mail ? 'on' : 'off']];
    const blRows = S.prefs.blRows || [];
    const body = [
      section('Rounds', 'When rounds start and how much each one applies to.',
        `<div class="field row"><div><b>Burn timer${pb ? ' <em class="pend">' + esc(statusWord(pb)) + '…</em>' : ''}</b><span class="help">${S.burn ? 'On: when no run is going, a round starts within 10 minutes.' : 'Off: rounds start only by hand.'} Applies at once.</span></div>${sw(S.burn, 'toggleBurn', 'Burn timer', { busy: !!pb, disabled: !online(), tip: offlineTip() })}</div>
        <div class="fields">${field('roundSize', 'Jobs per round', `<div class="in-unit"><input id="pf-roundSize" type="number" inputmode="numeric" min="1" max="200" value="${esc(p.roundSize)}" data-model="pd.roundSize"${e.roundSize ? ' aria-invalid="true" aria-describedby="pf-roundSize-err"' : ''}><span>jobs</span></div>`, 'A running round keeps its size.')}</div>`),
      section('Working hours', 'While you work, your own Claude account applies only on schedule, so you keep enough of it.',
        `<div class="field${e.workDays ? ' has-err' : ''}"><span class="lbl">Days</span><div class="days" role="group" aria-label="Working days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" aria-pressed="${p.work.days.includes(d)}" data-act="pdDay" data-arg="${d}">${DAYS[d]}</button>`).join('')}</div>${e.workDays ? `<span class="err">${e.workDays}</span>` : ''}</div>
        <div class="fields">${field('workFrom', 'From', timeIn('from'))}${field('workTo', 'To', timeIn('to'))}</div>`),
      section('Blacklist', 'Companies that never get an application. Adding one also passes over its jobs in the round in hand.',
        `<div class="bl">${blRows.length ? blRows.map((r) => `<span class="chip" data-tip="${esc((r.reason || '') + (r.since ? ' · since ' + r.since : ''))}">${esc(r.company)}<button type="button" class="chip-x" data-act="askBlRemove" data-arg="${esc(r.company)}" aria-label="Take ${esc(r.company)} off"${online() ? '' : ' disabled'}>${icon('x')}</button></span>`).join('') : '<span class="muted">No company on the list.</span>'}</div>
        <div class="field${e.bl ? ' has-err' : ''}"><label for="bl-in">Add a company</label><div class="in-btn"><input id="bl-in" type="text" placeholder="Company name" value="${esc(S.ui.blInput)}" data-model="ui.blInput" data-enter="blAdd">${btn('Add', 'blAdd', { icon: 'plus', disabled: !online(), busy: !!pending('blacklist', (a) => a.add) })}</div>${e.bl ? `<span class="err">${esc(e.bl)}</span>` : '<span class="help">Saved at once, in data/blacklist.md.</span>'}</div>`),
      section('Other rules', 'Set in data/burn-settings.json on the PC. Shown here so the numbers above make sense.',
        `<dl class="kv">${rules.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`),
    ].join('');
    const bar = ch.length || sv ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span>${sv ? '<b>Saving:</b> ' + esc(statusWord(sv)) + '…' : '<b>Unsaved:</b> ' + esc(ch.join(', '))}</span><span class="sb-a">${btn('Discard', 'discardPrefs', { disabled: !!sv })}${btn('Save changes', 'savePrefs', { kind: 'primary', icon: 'check', busy: !!sv, disabled: !online(), tip: offlineTip() })}</span></div>` : '';
    return pageHead('Preferences', 'Settings the PC uses for rounds. Each one is saved on the PC; the page shows it once the PC has.') + `<div class="prefs card">${body}</div>` + bar;
  }

  // ---- Drawers ---------------------------------------------------------------------------------
  function dJob(j) {
    let reply = '';
    if (isSent(j)) {
      const r = j.reply;
      const reacts = r && r.reactions.length ? `<ul class="props">${r.reactions.map((x) => `<li><div class="pr-h"><span class="pr-k">${lpill(x.level)}${x.replyNeeded ? pill('warn', 'Answer needed') : ''}</span><span class="muted">${esc(dayLabel(new Date(x.date + 'T12:00').getTime()))}</span></div>
        ${x.summary ? `<span>${esc(x.summary)}</span>` : ''}${x.who ? `<span class="muted">${esc(x.who)}${x.source === 'you' ? ' · you told' : ''}</span>` : ''}${x.evidence ? `<span class="muted">“${esc(x.evidence)}”</span>` : ''}</li>`).join('')}</ul>` : '';
      if (r && (r.history.length || reacts)) reply = (r.level ? `<p>Furthest step: ${lpill(r.level)}</p>` : '') + reacts + (r.history.length ? `<dl class="kv">${r.history.map((h) => `<div><dt>${esc(h.to)}</dt><dd>${esc(dayLabel(h.at))}</dd></div>`).join('')}</dl>` : '');
      else if (Date.now() - j.end < 2 * DAY) reply = '<p class="muted">Sent less than 2 days ago. Too early to expect an answer.</p>';
      else reply = '<p class="muted">No answer recorded so far.</p>';
    }
    const acts = [btn('Copy posting link', 'copy', { arg: j.url, icon: 'copy', sm: true })];
    if (!isBlack(j.company)) acts.push(btn('Blacklist ' + j.company, 'askBlack', { arg: j.company, icon: 'ban', sm: true, disabled: !online() }));
    const docs = `<dl class="kv">${[['CV', (ARMS.cv[j.cv.arm] || j.cv.arm) + (j.cv.writer ? ', written by ' + writer(j.cv.writer) : ', not tailored') + (j.cv.fallback ? ' (the tailored one failed)' : '')], ['Letter', j.letter.arm === 'none' ? 'None' : (ARMS.letter[j.letter.arm] || j.letter.arm) + ', ' + j.letter.words + ' words, written by ' + writer(j.letter.writer)]].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
    return `<div class="dr-h"><div><span class="eyebrow">Job ${j.id}${j.round ? ` · <button type="button" class="link" data-act="openRun" data-arg="${j.round}">round ${j.round}</button>` : ''}</span><h2 id="dr-title">${esc(j.role)}</h2><p>${coLink(j.company)}${j.place ? ' · ' + esc(j.place) : ''}</p></div>${btn('', 'closeDrawer', { icon: 'x', aria: 'Close', kind: 'ghost' })}</div>
      <div class="dr-b" data-keep="drawer">
        <div class="dr-res">${rpill(j.result)}<span class="muted">${esc(RESULTS[j.result].desc)}</span></div>
        ${j.result !== 'sent' && j.reason ? `<div class="callout t-${RESULTS[j.result].tone === 'neutral' ? 'info' : RESULTS[j.result].tone}">${icon('info')}<div><b>Why it ended:</b> ${esc(j.reason)}</div></div>` : j.result === 'sent' && j.reason ? '' : ''}
        <div class="dr-acts">${acts.join('')}</div>
        <h3>Summary</h3><dl class="kv two">${[['Site', esc(j.siteName)], ['Driver', j.driver && DRIVER_NAMES[j.driver] == null ? `<button type="button" class="link mono" data-act="openDriver" data-arg="${j.driver}">${esc(j.driver)}</button>` : esc(drvName(j.driver))], ['Started', when(j.start)], ['Took', dur((j.end - j.start) / MIN)], ['Fit score', fitText(j.fit) + ' / 5'], ['Ended', when(j.end)], ['Tries', String(j.tries || 1)], ['Language', j.lang ? j.lang.toUpperCase() : '—']].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        <h3>Documents</h3>${docs}<div class="dr-acts">${fileBtn('cv', j.id, 'CV', 'file')}${j.letter.arm !== 'none' ? fileBtn('letter', j.id, 'letter', 'file') : ''}${fileBtn('shot', j.id, 'last screenshot', 'image')}${fileBtn('report', j.id, 'driver’s report', 'file')}</div>
        ${isSent(j) ? '<h3>Employer</h3>' + reply : ''}
        <h3>Posting</h3><div class="url-row"><a class="mono url" href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">${esc(j.url)}</a></div>
      </div>`;
  }
  function dRun(id) {
    const x = runById(id);
    if (!x) return '';
    const live = x.ended === 'running';
    const s = runStats(id), rj = runJobs(id);
    const res = RESULT_ORDER.map((k) => ({ label: RESULTS[k].label, v: rj.filter((j) => j.result === k).length })).filter((r) => r.v);
    return `<div class="dr-h"><div><span class="eyebrow">Round · started by ${esc(byWho(x.by))}</span><h2 id="dr-title" class="mono">${esc(id)}</h2><p>${when(x.start)}${live ? '' : ' to ' + when(x.end)}</p></div>${btn('', 'closeDrawer', { icon: 'x', aria: 'Close', kind: 'ghost' })}</div>
      <div class="dr-b" data-keep="drawer"><div class="dr-res">${ended(x.ended)}<span class="muted">${esc(ENDED[x.ended].note)}</span></div>
      <div class="dr-acts">${btn('Show its ' + plural(s.jobs, 'job'), 'goApps', { arg: 'run:' + id, icon: 'table', sm: true, kind: 'primary', disabled: !s.jobs })}</div>
      <h3>Summary</h3><dl class="kv two">${[['Took', live ? since(x.start) : dur((x.end - x.start) / MIN)], ['Jobs', s.jobs + (x.planned ? ' of ' + x.planned + ' planned' : '')], ['Sent', s.sent + ' (' + pct(s.sent, s.jobs) + ')'], ['Time per job', s.jobs ? dur(s.mins) : '—']].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <h3>Results</h3>${res.length ? hbars(res, { max: s.jobs }) : '<p class="muted">No job finished yet.</p>'}
      <h3>Drivers</h3>${s.drivers.length ? `<table class="tbl mini"><thead><tr><th>Driver</th><th class="num">Jobs</th><th class="num">Sent</th><th class="num">Time per job</th></tr></thead><tbody>${s.drivers.map(([d, n]) => { const dj = rj.filter((j) => j.driver === d); return `<tr><td class="mono">${esc(drvName(d))}</td><td class="num">${n}</td><td class="num">${dj.filter(isSent).length}</td><td class="num">${dur(sum(dj.map((j) => (j.end - j.start) / MIN)) / n)}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">None yet.</p>'}
      ${x.notes && x.notes.length ? `<h3>What the run noted</h3><ul class="notes">${x.notes.slice(-12).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      </div>`;
  }
  // Everything about one company: what was sent there, what came back, and who wrote.
  function dCompany(name) {
    const key = ckey(name);
    const jobs = S.jobs.filter((j) => ckey(j.company) === key).sort((a, b) => b.end - a.end);
    const reacts = S.reactions.filter((x) => ckey(x.company) === key);
    const sent = jobs.filter(isSent), answers = sent.map(answerOf);
    // Tracker status changes from before the reactions (or not read by the model yet) count too.
    const STATUS_LEVEL = { Responded: 'contacted', Assessment: 'assessment', Interview: 'interview', Offer: 'offer', Hired: 'offer', Rejected: 'rejected' };
    const covered = new Set(reacts.map((x) => x.url + '|' + x.date));
    const tracked = S.replies.filter((r) => ckey(r.company) === key && STATUS_LEVEL[r.to] && !covered.has(r.url + '|' + r.date))
      .map((r) => ({ level: STATUS_LEVEL[r.to], date: r.date, role: r.role, url: r.url, summary: 'Tracker status set to ' + r.to + (r.note ? ': ' + r.note : '.'), who: '', source: 'tracker' }));
    const events = reacts.concat(tracked).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const best = events.reduce((b, x) => (lrank(x.level) > lrank(b) ? x.level : b), '');
    const rejected = new Set(events.filter((x) => x.level === 'rejected').map((x) => x.url || x.role)).size;
    const people = [...new Set(reacts.filter((x) => x.who && x.source !== 'you').map((x) => x.who))];
    const places = [...new Set(jobs.map((j) => j.place).filter(Boolean))];
    const last = jobs[0];
    const tl = events.length ? `<ul class="props">${events.slice(0, 40).map((x) => `<li><div class="pr-h"><span class="pr-k">${lpill(x.level)}${x.replyNeeded ? pill('warn', 'Answer needed') : ''}</span><span class="muted">${esc(dayLabel(new Date(x.date + 'T12:00').getTime()))}</span></div>
      <span>${x.role ? esc(x.role) : '<span class="muted">No application found for it</span>'}</span>${x.summary ? `<span class="muted">${esc(x.summary)}</span>` : ''}${x.who ? `<span class="muted">${esc(x.who)}${x.source === 'you' ? ' · you told' : ''}</span>` : ''}${x.evidence ? `<span class="muted">“${esc(x.evidence)}”</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="muted">No reply recorded from this company.</p>';
    const apps = jobs.length ? `<table class="tbl mini"><thead><tr><th>Ended</th><th>Role</th><th>Documents</th><th>Reply</th></tr></thead><tbody>${jobs.map((j) => row('openJob', j.uid,
      `<td class="nowrap">${esc(shortDay(j.end))}</td><td><b>${esc(j.role)}</b><span class="cell-sub">${esc([j.place, j.siteName].filter(Boolean).join(' · '))}${isSent(j) ? '' : ' · ' + esc(RESULTS[j.result].label.toLowerCase())}</span></td>
      <td><span class="cell-sub">${esc(ARMS.cv[j.cv.arm] || j.cv.arm)}${j.cv.fallback ? ' (fallback)' : ''}</span><span class="cell-sub">${esc(ARMS.letter[j.letter.arm] || j.letter.arm)}</span></td><td>${replyCell(j)}</td>`)).join('')}</tbody></table>`
      : '<p class="muted">No job from the runs. Replies above came for applications made another way.</p>';
    const acts = [btn('Show in Applications', 'goApps', { arg: 'q:' + name, icon: 'table', sm: true, kind: 'primary', disabled: !jobs.length })];
    if (!isBlack(name)) acts.push(btn('Blacklist ' + name, 'askBlack', { arg: name, icon: 'ban', sm: true, disabled: !online() }));
    return `<div class="dr-h"><div><span class="eyebrow">Company</span><h2 id="dr-title">${esc(name)}</h2><p>${esc(places.length ? places.slice(0, 3).join(' · ') + (places.length > 3 ? ' · +' + (places.length - 3) : '') : 'Place not known')}</p></div>${btn('', 'closeDrawer', { icon: 'x', aria: 'Close', kind: 'ghost' })}</div>
      <div class="dr-b" data-keep="drawer">
        <div class="dr-acts">${acts.join('')}</div>
        <h3>Summary</h3><dl class="kv two">${[['Applications', String(jobs.length)], ['Sent', String(sent.length)], ['Furthest step', best ? lpill(best) : '<span class="muted">None yet</span>'], ['Rejections', String(rejected)],
          ['Last applied', last ? esc(when(last.end)) : '—'], ['Answered', sent.length ? pct(answers.filter((a) => a.first).length, sent.length) : '—']].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
        ${people.length ? `<h3>Who wrote</h3><p>${people.map(esc).join('<br>')}</p>` : ''}
        <h3>Replies</h3>${tl}
        <h3>Applications</h3>${apps}
      </div>`;
  }
  function dDriver() {
    const dd = S.dd, d = driverById(dd.id);
    if (!d) return '';
    const s = status(d), t = driverToday(d), e = S.ui.errors, ru = rule(d), pd = pending('driver', (a) => a.id === d.id);
    const usage = WINDOWS.map((w) => `<div class="use"><span class="use-l">${w.label}</span>${d.windows[w.k] ? meter(d.windows[w.k], ru.k === 'reserve' ? d.reserve[w.k] : 0) + `<span class="muted use-r">${winNow(d.windows[w.k]).stale ? 'Reset ' : 'Resets '}${when(d.windows[w.k].reset)} · read ${when(d.windows[w.k].at)}</span>` : '<span class="muted">No reading of this kind.</span>'}</div>`).join('');
    const reserve = ru.k === 'reserve' ? `<h4>Reserve: share of each window it never uses</h4><div class="fields">${[['week', 'Weekly allowance'], ['five', '5-hour window']].map(([k, l]) => `<div class="field${e['rsv-' + k] ? ' has-err' : ''}"><label for="dd-${k}">${l}</label><div class="in-unit"><input id="dd-${k}" type="number" min="0" max="90" value="${esc(dd[k])}" data-model="dd.${k}"><span>%</span></div>${e['rsv-' + k] ? `<span class="err">${e['rsv-' + k]}</span>` : ''}</div>`).join('')}</div>` : '';
    return `<div class="dr-h"><div><span class="eyebrow">Driver${d.priority ? ' · tried ' + ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][d.priority - 1] : ''}</span><h2 id="dr-title" class="mono">${d.id}</h2><p>${esc(d.service)}${d.account ? ' · ' + esc(d.account) : ''}</p></div>${btn('', 'closeDrawer', { icon: 'x', aria: 'Close', kind: 'ghost' })}</div>
      <div class="dr-b" data-keep="drawer"><div class="dr-res">${spill(s)}<span class="muted">${esc(s.why)}</span></div>
      <div class="dr-acts">${btn('Show its jobs, 7 days', 'goApps', { arg: 'driver:' + d.id, icon: 'table', sm: true })}${btn(d.off ? 'Turn on' : 'Turn off', 'toggleDriver', { arg: d.id, icon: d.off ? 'play' : 'stop', sm: true, busy: !!pd, disabled: d.expired || !online(), tip: d.expired ? 'Its time with the timer ended' : offlineTip() })}</div>
      <h3>Usage</h3><div class="uses">${usage}</div>
      <dl class="kv two">${[['Jobs today', t.jobs + ' (' + t.sent + ' sent)'], ['Jobs, 7 days', t.week + ' (' + pct(t.weekSent, t.week) + ' sent)'], ['Time per job, 7 days', t.week ? dur(t.mins) : '—'], ['Writes documents', d.writes ? 'Yes, CVs and letters' : 'No']].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <h3>Rule</h3><p><b>${esc(ru.label)}.</b> ${esc(ru.text)}</p>${reserve}
      </div>${reserve ? `<div class="dr-f">${btn('Cancel', 'closeDrawer')}${btn('Save changes', 'saveDriver', { kind: 'primary', icon: 'check', disabled: !online(), tip: offlineTip() })}</div>` : ''}`;
  }
  function vDrawer() {
    const d = S.drawer;
    if (!d) return '';
    let inner = '';
    if (d.type === 'job') { const j = jobByUid(d.id); if (!j) { S.drawer = null; return ''; } inner = dJob(j); }
    if (d.type === 'run') inner = dRun(d.id);
    if (d.type === 'driver') inner = dDriver();
    if (d.type === 'company') inner = dCompany(d.id);
    if (!inner) { S.drawer = null; return ''; }
    return `<div class="scrim" data-act="closeDrawer"></div><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="dr-title">${inner}</aside>`;
  }
  function vModal() {
    const m = S.modal;
    if (!m) return '';
    let body = '', foot = '';
    if (m.kind === 'confirm') {
      body = `<p>${esc(m.text)}</p>`;
      foot = btn('Cancel', 'closeModal') + btn(m.confirm, m.act, { kind: m.danger ? 'danger solid' : 'primary', arg: m.arg, disabled: !online() });
    } else if (m.kind === 'start') {
      const ready = S.drivers.filter((d) => ['ready', 'applying'].includes(status(d).k)).map((d) => d.id);
      body = `<p>A round builds the pool again, takes the best postings that pass its checks, and sends real applications.</p>
        <div class="field${m.error ? ' has-err' : ''}"><label for="m-n">Jobs in the round</label><div class="in-unit"><input id="m-n" type="number" min="1" max="200" value="${esc(m.value)}" data-model="modal.value" data-enter="doStart"><span>jobs</span></div>${m.error ? `<span class="err">${m.error}</span>` : '<span class="help">Fewer run if fewer postings pass the checks.</span>'}</div>
        <p class="muted">${ready.length ? 'Drivers that may apply now, in order: ' + ready.join(', ') + '.' : 'No driver may apply now: the round would wait until one comes back.'}</p>`;
      m.title = 'Start a round';
      foot = btn('Cancel', 'closeModal') + btn('Start round', 'doStart', { kind: 'primary', icon: 'play', disabled: !online() });
    }
    return `<div class="scrim modal-scrim" data-act="closeModal"></div><div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title"><h2 id="m-title">${esc(m.title)}</h2>${body}<div class="modal-f">${foot}</div></div>`;
  }
  function vToasts() {
    return S.toasts.map((t) => `<div class="toast${t.tone ? ' t-' + t.tone : ''}" role="status"><span>${esc(t.text)}</span>${t.undo ? btn('Undo', 'undo', { arg: t.id, kind: 'ghost sm', icon: 'undo' }) : ''}${t.action ? btn(t.action.label, t.action.act, { arg: t.action.arg, kind: 'ghost sm' }) : ''}${btn('', 'dismissToast', { arg: t.id, icon: 'x', kind: 'ghost sm', aria: 'Dismiss' })}</div>`).join('');
  }
  function vGate() {
    if (DB.error === 'signin') return `<div class="gate">${empty('wifi', 'Sign in again', 'Your Cloudflare sign-in ended. Reload the page to sign in.', '<a class="btn primary" href="/">Reload</a>')}</div>`;
    if (!DB.loaded) return `<div class="gate">${DB.error ? empty('wifi', 'Cannot reach the dashboard server', 'It retries every few seconds.', btn('Try now', 'retryLoad', { kind: 'primary' })) : '<div class="loading"><span class="spin"></span><span>Loading the records…</span></div>'}</div>`;
    if (!DB.machines.length) return `<div class="gate">${empty('cpu', 'No machine has connected yet', 'Start the agent on the PC: node freemotion-night/hub-agent.mjs')}</div>`;
    return '';
  }

  // ---- Render ----------------------------------------------------------------------------------
  const VIEWS = { overview: vOverview, live: vLive, queue: vQueue, applications: vApps, runs: vRuns, results: vResults, drivers: vDrivers, alerts: vAlerts, activity: vActivity, preferences: vPrefs };
  const $ = (s) => document.querySelector(s);
  function render() {
    const a = document.activeElement, fid = a && a.id;
    let sel = null;
    try { if (a && a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch (e) { sel = null; }
    const keep = {};
    document.querySelectorAll('[data-keep]').forEach((el) => { keep[el.dataset.keep] = el.scrollTop; });
    $('#side').innerHTML = vSide();
    $('#top').innerHTML = vTop();
    const gate = vGate();
    $('#main').innerHTML = gate || offlineBanner() + VIEWS[S.route]();
    $('#drawer-root').innerHTML = gate ? '' : vDrawer();
    $('#modal-root').innerHTML = gate ? '' : vModal();
    renderToasts();
    document.body.classList.toggle('nav-open', S.ui.nav);
    document.body.classList.toggle('locked', !!(S.drawer || S.modal));
    document.querySelectorAll('[data-keep]').forEach((el) => { if (keep[el.dataset.keep] != null) el.scrollTop = keep[el.dataset.keep]; });
    if (fid) {
      const el = document.getElementById(fid);
      if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* not a text input */ } } }
    }
  }
  // New data: pages that show the run redraw; the others only refresh the menu and the top bar while
  // the person is typing or choosing, so a half-typed field or an open select is never disturbed.
  function refresh() {
    const a = document.activeElement;
    const busy = a && (a.tagName === 'SELECT' || (/^(INPUT|TEXTAREA)$/.test(a.tagName) && a.id !== 'gsearch' && a.id !== 'apps-q' && a.id !== 'act-q'));
    if (busy || S.modal) { $('#side').innerHTML = vSide(); $('#top').innerHTML = vTop(); updateClocks(); return; }
    render();
  }
  function renderToasts() { const t = $('#toasts'); if (t) t.innerHTML = vToasts(); }
  function updateClocks() {
    const now = Date.now();
    document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = clock(now - +el.dataset.since); });
    document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(+el.dataset.ago); });
  }

  // ---- Theme -----------------------------------------------------------------------------------
  function applyTheme() {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }

  // ---- Events ----------------------------------------------------------------------------------
  function route() {
    const h = (location.hash || '').slice(1);
    S.route = VIEWS[h] ? h : 'overview';
    S.ui.nav = false;
    render();
    const a = document.activeElement;
    if (!(a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName))) $('#main').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const f = A[el.dataset.act];
    if (!f) return;
    if (el.type !== 'checkbox' && el.type !== 'radio') e.preventDefault();
    f(el.dataset.arg, el, e);
    render();
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a && a.getAttribute('href') === '#' + S.route) { S.drawer = null; S.ui.nav = false; render(); }
  });
  const onModel = (e) => {
    const el = e.target.closest('[data-model]');
    if (!el) return;
    setPath(el.dataset.model, el.type === 'checkbox' ? el.checked : el.value);
    if (el.dataset.goto && S.route !== el.dataset.goto) { location.hash = el.dataset.goto; return; }
    render();
  };
  document.addEventListener('input', (e) => { if (e.target.matches('input[data-model]')) onModel(e); });
  document.addEventListener('change', (e) => { if (e.target.matches('select[data-model]')) onModel(e); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (S.modal) S.modal = null; else if (S.drawer) { S.drawer = null; S.dd = null; } else if (S.ui.nav) S.ui.nav = false; else return;
      render(); return;
    }
    const t = e.target;
    if (e.key === 'Enter' && t.dataset && t.dataset.enter) { e.preventDefault(); A[t.dataset.enter](); render(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && t.matches && t.matches('tr[data-act]')) { e.preventDefault(); t.click(); return; }
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) { e.preventDefault(); const s = $('#gsearch'); if (s) s.focus(); }
  });

  // Tooltip: one element, filled from data-tip on hover or keyboard focus.
  const tip = $('#tip');
  let tipEl = null;
  function showTip(el, x, y) {
    tipEl = el;
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    let left = x + 14, top = y + 16;
    if (left + r.width > vw - 8) left = x - r.width - 14;
    if (top + r.height > vh - 8) top = y - r.height - 12;
    tip.style.left = Math.max(8, left) + 'px'; tip.style.top = Math.max(8, top) + 'px';
  }
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el.dataset.tip) showTip(el, e.clientX, e.clientY); else if (tipEl) { tip.hidden = true; tipEl = null; }
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && el.dataset.tip && e.target.matches(':focus-visible')) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.bottom - 8); }
    else { tip.hidden = true; tipEl = null; }
  });
  document.addEventListener('scroll', () => { tip.hidden = true; tipEl = null; }, true);
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { const c = window.innerWidth < 640; if (c !== S.ui.compact) { S.ui.compact = c; render(); } }, 150); });
  window.addEventListener('hashchange', route);

  // Poll faster while the page is in view; a hidden tab checks every 30 s.
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(async () => { await pull(); schedule(); }, document.hidden ? 30000 : 2500); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pull(); } schedule(); });
  setInterval(updateClocks, 1000);

  applyTheme();
  route();
  pull().then(schedule);
})();
