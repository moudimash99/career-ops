# freemotion-night/night-mail.py [--to <address>] [--every 50] [--dry-run] [--once] [--log <file>]
# freemotion-night/night-mail.py --alert "<subject>"   one short email, the body on standard input
# The address is NIGHT_MAIL_TO in .env unless --to is given.
# Progress emails for a run (full-night.sh, started by hand or by the burn timer): it reads
# tmp/fm/night/full-night.log as the run writes it, from the last "##### full night run" line on, and sends
#   - one email when it starts,
#   - one every --every finished jobs since the last email (default 50; 0 = none),
#   - one at the end of each round but the last, one when the run is done (then it exits),
#   - one if no job has finished for STUCK_MIN minutes while the run is applying.
# Every email answers the same questions in the same order (user, 2026-10-23: "not sure run is on, how many
# did the previous sessions apply"): one line saying whether the run is going, then applications sent
# (today, yesterday, 7 and 30 days, from data/freemotion-submissions.tsv), this run, the recent runs
# (from the whole log), what happens next (the burn timer's state, from burn.mjs status), who wrote the
# CVs and letters (this run's "docs for job" lines and data/web-llm-events.tsv), the jobs since the last
# email, the notes and the allowances run.sh prints before each round.
# Job times come from tmp/fm/usage/night-runs.tsv when it has them, else when this script saw the line
# (it reads the log every 30 s).
# Sent through Gmail's SMTP with the .env login the other mail scripts use (GMAIL_MACHAKA_USER,
# GMAIL_MACHAKA_APP_PASSWORD). --dry-run prints the emails instead; --once reads the log as it is, prints
# (or with --to, sends) one report and exits. It gives up after 30 hours.
import argparse, json, os, re, smtplib, subprocess, sys, time
from collections import Counter
from datetime import datetime, timedelta
from email.message import EmailMessage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ap = argparse.ArgumentParser()
ap.add_argument('--to')   # default: NIGHT_MAIL_TO in .env
ap.add_argument('--every', type=int, default=50)
ap.add_argument('--dry-run', action='store_true')
ap.add_argument('--once', action='store_true')
ap.add_argument('--alert')   # lib/doc-writers.mjs: a website writer failed
ap.add_argument('--log', default=os.path.join(ROOT, 'tmp/fm/night/full-night.log'))
args = ap.parse_args()
if args.once and not args.to: args.dry_run = True
try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')   # --dry-run prints '·' and '—'
except Exception: pass

env = {}
for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
user, pw = env.get('GMAIL_MACHAKA_USER'), env.get('GMAIL_MACHAKA_APP_PASSWORD')
if not args.dry_run and (not user or not pw):
    sys.exit('GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD must be set in .env')
args.to = args.to or env.get('NIGHT_MAIL_TO')
if not args.dry_run and not args.to:
    sys.exit('no address: pass --to or set NIGHT_MAIL_TO in .env')

# full-night.sh's settings: scheduled.mjs passes the night's environment on; --once by hand reads them
# from the night's start file. Then full-night.sh's defaults.
try: NIGHT = json.load(open(os.path.join(ROOT, 'tmp/fm/night/night-start.json'), encoding='utf-8'))
except Exception: NIGHT = {}
def setting(k): return os.environ.get(k) or (NIGHT.get('env') or {}).get(k)
ROUND_JOBS = int(setting('ROUND_JOBS') or 50)
EVERY = int(setting('EVERY_HOURS') or 5) * 3600
END_AT = setting('END_AT') or '09:00'
MAX_ROUNDS = int(setting('MAX_ROUNDS') or 0)   # the burn timer's runs: one round each
STUCK_MIN = 75   # agy's slowest jobs take about 40 min, documents included


def send(subject, body):
    if args.dry_run:
        print(f'--- {subject}\n{body}\n', flush=True); return
    m = EmailMessage()
    m['From'], m['To'], m['Subject'] = user, args.to, subject
    m.set_content(body)
    for attempt in range(3):   # the network drops now and then at night; a lost email is not worth a crash
        try:
            with smtplib.SMTP_SSL('smtp.gmail.com', 465, timeout=60) as s:
                s.login(user, pw); s.send_message(m)
            print(f'sent: {subject}', flush=True); return
        except Exception as e:
            print(f'not sent ({e}); attempt {attempt + 1}', flush=True); time.sleep(60)


if args.alert:
    send(args.alert, sys.stdin.read()); sys.exit(0)


def job_name(num):
    try:
        j = json.load(open(os.path.join(ROOT, f'tmp/fm/night/job-{num}.json'), encoding='utf-8'))
        return f"{j['co']} — {j['title']}"
    except Exception:
        return ''


def dur(sec):
    m = int(max(sec, 0) // 60)
    return f'{m // 60} h {m % 60:02d} min' if m >= 60 else f'{m} min'


def short(sec):   # for subjects: 4h32
    m = int(max(sec, 0) // 60)
    return f'{m // 60}h{m % 60:02d}'


def hm(t): return t.strftime('%a %H:%M')


def pct(a, b): return f'{round(100 * a / b)}%' if b else '—'


def sent(jobs): return sum(1 for j in jobs if j['o'] == 'submitted')


def others(jobs):
    c = Counter(j['o'] for j in jobs if j['o'] != 'submitted')
    return ', '.join(f'{n} {o}' for o, n in c.most_common()) or 'none'


def local(ts):
    """'2026-10-23T02:12:11.664Z' as this machine's local time, without the zone."""
    try: return datetime.fromisoformat(ts.strip().replace('Z', '+00:00')).astimezone().replace(tzinfo=None, microsecond=0)
    except Exception: return None


def tsv(rel):
    try:
        with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
            return [l.rstrip('\n').split('\t') for l in f]
    except Exception:
        return []


def ledger():
    """Applications sent, oldest first: (time, company, role), one per posting at its first 'submitted' line."""
    seen = {}
    for c in tsv('data/freemotion-submissions.tsv')[1:]:
        if len(c) > 6 and c[5] == 'submitted' and c[0] not in seen:
            t = local(c[6])
            if t: seen[c[0]] = (t, c[2], c[3])
    return sorted(seen.values())


def sent_since(apps, t): return sum(1 for a in apps if a[0] >= t)


def sent_today(now): return sent_since(ledger(), datetime.combine(now.date(), datetime.min.time()))


_times = {}
def job_times(num):
    """(start, end) of a job from tmp/fm/usage/night-runs.tsv (run.sh writes it as each job ends)."""
    if num not in _times:
        for c in tsv('tmp/fm/usage/night-runs.tsv'):
            if len(c) > 2: _times[c[0]] = (local(c[1]), local(c[2]))
    return _times.get(num, (None, None))


def burn_state():
    """The burn timer as `burn.mjs status` prints it: on or off, who may apply, who is paused and why."""
    try:
        out = subprocess.run(['node', 'freemotion-night/burn.mjs', 'status'], cwd=ROOT, capture_output=True,
                             text=True, encoding='utf-8', errors='replace', timeout=90).stdout
    except Exception:
        return None
    m = re.search(r"^drivers, in today's order: (.*)$", out, re.M)
    paused = {}
    for p in re.finditer(r'^\s+(\S+): paused, (.*)$', out, re.M): paused[p[1]] = p[2]
    order = m[1].split() if m else []
    return {'on': out.startswith('burn on'), 'may': [d for d in order if d not in paused], 'paused': paused}


def started_by():
    try: return json.load(open(os.path.join(ROOT, 'tmp/fm/night/night-start.json'), encoding='utf-8')).get('by') or 'hand'
    except Exception: return NIGHT.get('by') or 'hand'


def web_events(now):
    """The websites' calls in the last 24 hours, as 'chatgpt 12 ok, 1 limit'."""
    c = Counter()
    for e in tsv('data/web-llm-events.tsv')[1:]:
        t = local(e[0]) if e else None
        if t and now - t < timedelta(hours=24) and len(e) > 2: c[(e[1], e[2])] += 1
    sites = sorted({s for s, _ in c})
    return [f'{s} ' + ', '.join(f'{n} {r}' for (s2, r), n in sorted(c.items(), key=lambda x: -x[1]) if s2 == s) for s in sites]


def round_time(text, after):
    """'Wed 05:44' from a '===== round' line, as the first such moment from the run's start day on."""
    m = re.search(r'(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d\d):(\d\d)', text)
    if not m: return None
    for d in range(8):
        t = (after + timedelta(days=d)).replace(hour=int(m[2]), minute=int(m[3]), second=0, microsecond=0)
        if t.strftime('%a') == m[1] and t >= after - timedelta(minutes=1): return t
    return None


JOB = re.compile(r'^job (\d+) \(([^)]+)\): (.*)$')
DOCS = re.compile(r'^docs for job (\d+): (.*)$')


def past_runs(text):
    """Every run in the log before this one: start, jobs, and its end if it reached FULL NIGHT DONE."""
    runs = []
    for line in text.splitlines():
        if line.startswith('##### full night run'):
            m = re.search(r'(\d{4}-\d\d-\d\d \d\d:\d\d)', line)
            if m: runs.append({'start': datetime.strptime(m[1], '%Y-%m-%d %H:%M'), 'jobs': [], 'end': None})
        elif not runs: continue
        elif line.startswith('FULL NIGHT DONE'):
            runs[-1]['end'] = round_time(line, runs[-1]['start'])
        else:
            m = JOB.match(line)
            if m and 'skipped' not in m[3]: runs[-1]['jobs'].append({'n': m[1], 'd': m[2], 'o': m[3] or 'no result'})
    return runs


def run_row(start, jobs, end, how):
    drivers = ', '.join(d for d, _ in Counter(j['d'] for j in jobs).most_common()) or '—'
    took = dur((end - start).total_seconds()) if end else '—'
    return f'  {hm(start):<11} {took:<13} {len(jobs):>4} {sent(jobs):>5}  {drivers:<18} {how}'


class Run:
    def __init__(self):
        self.start = None; self.header = ''; self.rounds = []; self.jobs = []; self.allow = []
        self.mailed = 0; self.finished = None; self.end_line = ''; self._allow_open = False
        self.past = []; self.by = 'hand'; self.writers = Counter(); self.pending = None
        self.last_job = None; self.stuck_mailed = False

    def round(self): return self.rounds[-1] if self.rounds else None

    def end_at(self):   # full-night.sh: END_AT on the start day, the next day if already past
        h, m = map(int, END_AT.split(':'))
        e = self.start.replace(hour=h, minute=m, second=0, microsecond=0)
        return e if e > self.start else e + timedelta(days=1)

    def rounds_left(self):
        """Rounds still to start after the last one that started (full-night.sh's rule)."""
        r = self.round()
        if r and r['last']: return 0
        n = self._marks(r['start']) - 1 if r else self._marks(self.start)
        return min(n, max(MAX_ROUNDS - len(self.rounds), 0)) if MAX_ROUNDS else n

    def _marks(self, t):
        """Rounds starting at t, t + EVERY, ... up to the first one at or after the end."""
        end, n = self.end_at(), 1
        while t < end:
            t += timedelta(seconds=EVERY); n += 1
        return n

    def applying(self, now):
        return sum(((r['end'] or now) - (r['apply'] or r['start'])).total_seconds() for r in self.rounds)

    def headline(self, now, why):
        """One plain sentence: is the run going, and where is it."""
        r, done, s = self.round(), len(self.jobs), sent(self.jobs)
        if self.finished:
            return [f'DONE. The run that started {hm(self.start)} finished at {now.strftime("%H:%M")}: '
                    f'{s} application{"s" * (s != 1)} sent from {done} job{"s" * (done != 1)} in {dur((now - self.start).total_seconds())}.']
        if why == 'stuck':
            return [f'STUCK? The run is still on, but nothing has moved for {dur((now - self.last_job).total_seconds())} '
                    f'(since {self.last_job.strftime("%a %H:%M")}). Look at the end of the log.']
        if not r or not r['apply']:
            return [f'RUNNING. Started {hm(self.start)} ({"by the burn timer" if self.by == "burn" else "by hand"}); '
                    f'it is still choosing jobs (scan, pool, live checks). Applying starts in a few minutes.']
        rd, rp = len(r['jobs']) + r['skipped'], r['planned'] or ROUND_JOBS
        L = [f'RUNNING. Round {r["no"]} started {hm(r["start"])}: {rd} of {rp} jobs done, {sent(r["jobs"])} sent.']
        if r['end']:
            L = [f'RUNNING, between rounds. Round {r["no"]} is done: {sent(r["jobs"])} sent of {len(r["jobs"])} jobs.']
        else:
            ra = (now - r['apply']).total_seconds()
            if rd and ra > 0:
                per = ra / rd; rest = max(rp - rd, 0) * per
                L.append(f'At {per / 60:.0f} min a job the round ends around {(now + timedelta(seconds=rest)).strftime("%a %H:%M")}.')
        return [' '.join(L)]

    def next_lines(self, now):
        """What happens after this round: the run's own next round, or the burn timer's."""
        r, b = self.round(), burn_state()
        L = []
        if r and not r['last'] and not self.finished:
            nxt = r['start'] + timedelta(seconds=EVERY)
            L.append(f'  This run: next round {hm(nxt)}' + (' (or at once if this one runs past it)' if not r['end'] else '')
                     + f', about {self.rounds_left()} more round(s) until {hm(self.end_at())}.')
        elif not self.finished:
            L.append('  This run: this is its only (or last) round.')
        if b is None:
            L.append('  Burn timer: could not read it (node freemotion-night/burn.mjs status).')
        elif b['on']:
            if b['may']:
                L.append(f'  Burn timer: ON. Once no run is going it starts a new round of {ROUND_JOBS} within 10 minutes.')
                L.append(f'  May apply now: {", ".join(b["may"])}.')
            else:
                L.append('  Burn timer: ON, but no driver may apply now, so no new round starts until one comes back.')
        else:
            L.append('  Burn timer: OFF. Nothing starts after this run. Start one: node freemotion-night/scheduled.mjs start-night')
        if b and b['paused']:
            L.append('  Paused: ' + '; '.join(f'{d} ({w})' for d, w in b['paused'].items()) + '.')
        return L

    def report(self, now, why):
        now = self.finished or now
        r, done, s = self.round(), len(self.jobs), sent(self.jobs)
        apps = ledger(); d0 = datetime.combine(now.date(), datetime.min.time())
        L = self.headline(now, why)

        L += ['', 'APPLICATIONS SENT',
              f'  Today {sent_since(apps, d0)} · yesterday {sent_since(apps, d0 - timedelta(days=1)) - sent_since(apps, d0)}'
              f' · last 7 days {sent_since(apps, d0 - timedelta(days=6))} · last 30 days {sent_since(apps, d0 - timedelta(days=29))}']
        if apps:
            t, co, role = apps[-1]
            L.append(f'  Last one: {hm(t)} ({dur((now - t).total_seconds())} ago) — {co} — {role}')

        L += ['', 'THIS RUN']
        L.append(f'  Started {hm(self.start)} {"by the burn timer" if self.by == "burn" else "by hand"} · '
                 + (f'took {dur((now - self.start).total_seconds())}' if self.finished else f'running for {dur((now - self.start).total_seconds())}'))
        L.append(f'  Jobs finished: {done} · sent {s} ({pct(s, done)}) · other results: {others(self.jobs)}')
        app = self.applying(now)
        if done and app > 0:
            L.append(f'  Pace: {app / 60 / done:.0f} min a job · {s / (app / 3600):.1f} applications an hour of applying')
        if len(self.rounds) > 1:
            L += ['  Rounds:  #   started     took          jobs  sent']
            for r2 in self.rounds:
                took = dur(((r2['end'] or now) - r2['start']).total_seconds()) + ('' if r2['end'] else ' so far')
                L.append(f'           {r2["no"]:<3} {hm(r2["start"]):<11} {took:<13} {len(r2["jobs"]):>4}  {sent(r2["jobs"]):>4}')

        L += ['', 'RECENT RUNS', '  started     took          jobs  sent  drivers            how it ended']
        for p in self.past[-6:]:
            ends = [job_times(j['n'])[1] for j in p['jobs']]
            last = max((e for e in ends if e), default=None)
            how = 'finished' if p['end'] else (f'stopped early, after job {p["jobs"][-1]["n"]}' if p['jobs'] else 'nothing to apply to')
            L.append(run_row(p['start'], p['jobs'], p['end'] or last, how))
        L.append(run_row(self.start, self.jobs, now, 'finished' if self.finished else 'this run, going'))

        L += ['', 'WHAT HAPPENS NEXT'] + self.next_lines(now)

        web = web_events(now)
        if self.writers or web:
            L += ['', 'CV AND LETTER WRITERS']
            if self.writers:
                L.append('  This run: ' + ' · '.join(f'{w} {n}' for w, n in self.writers.most_common()))
            if web:
                L.append('  Websites, last 24 h: ' + ' · '.join(web))

        new = self.jobs[self.mailed:]
        if new:
            L += ['', f'JOBS SINCE THE LAST EMAIL ({len(new)})']
            L += [f'  {j["at"].strftime("%H:%M")}  {"SENT" if j["o"] == "submitted" else j["o"]:<17} {j["n"]} ({j["d"]})  {job_name(j["n"])}' for j in new]
        if r and r['notes']:
            L += ['', f'NOTES (round {r["no"]})'] + [f'  {x}' for x in r['notes']]
        if self.allow:
            L += ['', 'ALLOWANCES (start of the latest round)'] + [f'  {x}' for x in self.allow]
        if self.end_line: L += ['', self.end_line]
        L += ['', 'Stop: node freemotion-night/burn.mjs off (no new rounds) · touch tmp/fm/night/stop-night (end after the round in hand)',
              'Log: tmp/fm/night/full-night.log']
        self.mailed = len(self.jobs)
        return '\n'.join(L)

    def subject(self, now, what):
        return f'FM: {what} · {sent_today(now)} sent today'


def mail(run, now, what, why):
    send(run.subject(now, what), run.report(now, why))


run, pos, buf = None, None, b''
deadline = time.time() + 30 * 3600
while time.time() < deadline:
    if not os.path.exists(args.log): time.sleep(30); continue
    history = None
    with open(args.log, 'rb') as f:
        if pos is None:   # start at this run's first line; what comes before is the runs' history
            data = f.read(); pos = max(data.rfind(b'##### full night run'), 0)
            history = past_runs(data[:pos].decode('utf-8', 'replace'))
        f.seek(pos); chunk = f.read(); pos = f.tell()
    buf += chunk
    *done, buf = buf.split(b'\n')
    now = datetime.now().replace(microsecond=0)
    for raw in done:
        line = raw.decode('utf-8', 'replace').rstrip('\r')
        if line.startswith('##### full night run'):
            past = run.past + [{'start': run.start, 'jobs': run.jobs, 'end': run.finished}] if run else (history or [])
            run = Run(); run.header = line.lstrip('# '); run.past = past; run.by = started_by()
            m = re.search(r'(\d{4}-\d\d-\d\d \d\d:\d\d)', line)
            run.start = datetime.strptime(m[1], '%Y-%m-%d %H:%M') if m else now
            if not args.once:
                mail(run, now, f'STARTED · round of {ROUND_JOBS}' if run.rounds_left() <= 1 else f'STARTED · about {run.rounds_left()} rounds of {ROUND_JOBS}', 'started')
            continue
        if run is None: continue
        r = run.round()
        if line.startswith('FULL NIGHT DONE'):
            if r and not r['end']: r['end'] = now
            run.finished, run.end_line, run.pending = now, line, None
            mail(run, now, f'DONE · {sent(run.jobs)} sent of {len(run.jobs)} jobs in {short((now - run.start).total_seconds())}', 'finished')
            sys.exit(0)
        if line.startswith('===== round'):
            t = round_time(line, run.start) or now
            if r and not r['end']: r['end'] = t   # a round that died without its end line
            run.rounds.append({'no': len(run.rounds) + 1, 'start': t, 'apply': None, 'end': None, 'planned': 0,
                               'skipped': 0, 'jobs': [], 'notes': [], 'last': '(the last one)' in line})
        elif r and not r['end'] and (line == 'ALL DONE' or 'nothing to apply to this round' in line
                                     or 'no jobs this round' in line or re.match(r'^note: round \d+ done at', line)):
            # full-night.sh's "round N done" line also ends a round whose run.sh died before ALL DONE
            r['end'] = now
            if line.startswith('note: ') and not line.startswith('note: round'): r['notes'].append(line[6:])
            # the last round's email is the DONE one, which follows at once; this one only if that never comes
            if r['last']: run.pending = now
            elif not args.once:
                mail(run, now, f'ROUND {r["no"]} DONE · {sent(r["jobs"])} sent of {len(r["jobs"])}', f'round {r["no"]} done')
        elif r and re.match(r'^written (\d+) briefings', line):
            r['planned'] = int(re.match(r'^written (\d+)', line)[1]); r['apply'] = now; run.last_job = now
        elif r and DOCS.match(line):
            n, what = DOCS.match(line).groups()
            if 'reused' in what: continue
            w = re.search(r'written for this posting by (\S+)', what)
            run.writers['CV by ' + w[1] if w else 'generic CV'] += 1
        elif r and JOB.match(line):
            n, d, o = JOB.match(line).groups()
            if 'skipped' in o: r['skipped'] += 1; continue
            start, end = job_times(n)
            if not len(r['jobs']) and start and r['apply'] and start < r['apply']: r['apply'] = start
            j = {'n': n, 'd': d, 'o': o or 'no result', 'at': end or now}
            r['jobs'].append(j); run.jobs.append(j); run.last_job, run.stuck_mailed = now, False
            rd = len(r['jobs']) + r['skipped']
            # every --every jobs since the last email, but not on the round's last job: its round-end email follows
            if args.every and len(run.jobs) - run.mailed >= args.every and rd < (r['planned'] or ROUND_JOBS) and not args.once:
                mail(run, now, f'RUNNING · {rd}/{r["planned"] or ROUND_JOBS} jobs, {sent(r["jobs"])} sent this round', 'progress')
        elif r and line.startswith('note: ') and not line.startswith('note: round'):
            r['notes'].append(line[6:])
        elif line.startswith('allowance: '):   # run.sh, before each round: Claude's, Codex's and agy's windows
            if not run._allow_open: run.allow = []
            run.allow.append(line[11:]); run._allow_open = True
            continue
        run._allow_open = False   # the next allowance line starts a new round's block
    if args.once:
        r = run and run.round()
        quiet = datetime.fromtimestamp(os.path.getmtime(args.log)).replace(microsecond=0)
        if r and r['apply'] and not r['end'] and not run.finished and now - quiet > timedelta(minutes=STUCK_MIN):
            run.last_job = quiet   # the log has not moved: say so first
            send(run.subject(now, f'STUCK? nothing for {short((now - quiet).total_seconds())}'), run.report(now, 'stuck'))
        elif run: send(run.subject(now, 'STATUS'), run.report(now, 'status'))
        else: print('no full night run in the log')
        sys.exit(0)
    if run and not run.finished:
        r = run.round()
        if run.pending and now - run.pending > timedelta(minutes=3):   # the last round ended, FULL NIGHT DONE never came
            run.pending = None
            mail(run, now, f'ROUND {r["no"]} DONE · {sent(r["jobs"])} sent of {len(r["jobs"])}', f'round {r["no"]} done')
        if (r and r['apply'] and not r['end'] and run.last_job and not run.stuck_mailed
                and now - run.last_job > timedelta(minutes=STUCK_MIN)):
            run.stuck_mailed = True
            mail(run, now, f'STUCK? no job finished for {short((now - run.last_job).total_seconds())}', 'stuck')
    time.sleep(30)
