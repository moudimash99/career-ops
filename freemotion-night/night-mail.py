# freemotion-night/night-mail.py [--to <address>] [--every 50] [--dry-run] [--once] [--log <file>]
# The address is NIGHT_MAIL_TO in .env unless --to is given.
# Progress emails for a full night run (full-night.sh): it reads tmp/fm/night/full-night.log as the night
# writes it, from the last "##### full night run" line on, and sends
#   - one email when it starts,
#   - one every --every finished jobs since the last email (default 50; 0 = none),
#   - one at the end of each round, and one when the night is done (then it exits).
# Each email is a full report: how long the run has gone, how much of it was spent applying, how many
# jobs are done of about how many planned (rounds left from ROUND_JOBS, EVERY_HOURS, END_AT, as
# full-night.sh uses them), applications sent, the pace and when the round in hand should end, a line
# per round, jobs per driver, every job since the last email (company and role from
# tmp/fm/night/job-<N>.json), the round's notes (a driver out, a wait, a failure) and the Claude, Codex
# and agy allowances run.sh prints before each round (claude-usage.mjs).
# Times are when this script saw the line (it reads the log every 30 s); a round's start comes from its
# "===== round" line, so a mailer started late still gets those right.
# Sent through Gmail's SMTP with the .env login the other mail scripts use (GMAIL_MACHAKA_USER,
# GMAIL_MACHAKA_APP_PASSWORD). --dry-run prints the emails instead; --once reads the log as it is, prints
# (or with --to, sends) one report and exits. It gives up after 30 hours.
import argparse, json, os, re, smtplib, sys, time
from collections import Counter
from datetime import datetime, timedelta
from email.message import EmailMessage

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ap = argparse.ArgumentParser()
ap.add_argument('--to')   # default: NIGHT_MAIL_TO in .env
ap.add_argument('--every', type=int, default=50)
ap.add_argument('--dry-run', action='store_true')
ap.add_argument('--once', action='store_true')
ap.add_argument('--log', default=os.path.join(ROOT, 'tmp/fm/night/full-night.log'))
args = ap.parse_args()
if args.once and not args.to: args.dry_run = True

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

# full-night.sh's settings (scheduled.mjs passes the night's environment on), with its defaults.
ROUND_JOBS = int(os.environ.get('ROUND_JOBS') or 50)
EVERY = int(os.environ.get('EVERY_HOURS') or 5) * 3600
END_AT = os.environ.get('END_AT') or '09:00'


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


class Run:
    def __init__(self):
        self.start = None; self.header = ''; self.rounds = []; self.jobs = []; self.allow = []
        self.mailed = 0; self.finished = None; self.end_line = ''; self._allow_open = False

    def round(self): return self.rounds[-1] if self.rounds else None

    def end_at(self):   # full-night.sh: END_AT on the start day, the next day if already past
        h, m = map(int, END_AT.split(':'))
        e = self.start.replace(hour=h, minute=m, second=0, microsecond=0)
        return e if e > self.start else e + timedelta(days=1)

    def rounds_left(self):
        """Rounds still to start after the last one that started (full-night.sh's rule)."""
        r = self.round()
        if r and r['last']: return 0
        return self._marks(r['start']) - 1 if r else self._marks(self.start)

    def _marks(self, t):
        """Rounds starting at t, t + EVERY, ... up to the first one at or after the end."""
        end, n = self.end_at(), 1
        while t < end:
            t += timedelta(seconds=EVERY); n += 1
        return n

    def applying(self, now):
        return sum(((r['end'] or now) - (r['apply'] or r['start'])).total_seconds() for r in self.rounds)

    def waiting(self, now):
        w = 0
        for a, b in zip(self.rounds, self.rounds[1:]):
            if a['end']: w += (b['start'] - a['end']).total_seconds()
        r = self.round()
        if r and r['end'] and not self.finished: w += (now - r['end']).total_seconds()
        return w

    def report(self, now, why):
        now = self.finished or now
        r, el = self.round(), (now - self.start).total_seconds()
        done = len(self.jobs); s = sent(self.jobs)
        planned_done = sum(r2['planned'] or ROUND_JOBS for r2 in self.rounds)
        left = self.rounds_left()
        planned = planned_done + left * ROUND_JOBS
        app = self.applying(now)
        scan = ((self.rounds[0]['start'] if self.rounds else now) - self.start).total_seconds()
        L = [f'Free Motion run — {why}, {now.strftime("%a %d %b %H:%M")}', '', 'OVERALL']
        state = f'finished after {dur(el)}' if self.finished else f'running for {dur(el)}'
        L.append(f'  Run:               {state} (started {hm(self.start)})')
        if self.finished:
            L.append(f'  Jobs finished:     {done} in {len(self.rounds)} round(s)')
        else:
            L.append(f'  Jobs finished:     {done} of about {planned} planned '
                     f'({len(self.rounds)} round(s) started, about {left} more; the last starts at the first '
                     f'{EVERY // 3600}-hour mark from {hm(self.end_at())})')
        L.append(f'  Applications sent: {s} ({pct(s, done)} of finished jobs)')
        L.append(f'  Other results:     {others(self.jobs)}')
        L.append(f'  Time applying:     {dur(app)} · scan and pools {dur(scan)} · waiting between rounds {dur(self.waiting(now))}')
        if done and app > 0:
            L.append(f'  Pace:              {app / 60 / done:.1f} min a job · {s / (app / 3600):.1f} applications an hour of applying')
        if r:
            rj = r['jobs']; rd = len(rj) + r['skipped']; rp = r['planned'] or ROUND_JOBS
            L += ['', f'ROUND {r["no"]}' + (' (the last one)' if r['last'] else '') + (' — done' if r['end'] else ' — running')]
            if r['end']:
                L.append(f'  Started {hm(r["start"])}, took {dur((r["end"] - r["start"]).total_seconds())} · {rd} of {rp} jobs done'
                         + (f' ({r["skipped"]} skipped)' if r['skipped'] else ''))
            else:
                L.append(f'  Started {hm(r["start"])}, running {dur((now - r["start"]).total_seconds())} · {rd} of {rp} jobs done'
                         + (f' ({r["skipped"]} skipped)' if r['skipped'] else ''))
            L.append(f'  Applications sent: {sent(rj)} · {others(rj)}')
            ra = ((r['end'] or now) - (r['apply'] or r['start'])).total_seconds()
            if not r['end'] and rd and ra > 0:
                per = ra / rd; rest = max(rp - rd, 0) * per
                L.append(f'  Pace {per / 60:.1f} min a job: about {dur(rest)} left, ending around {(now + timedelta(seconds=rest)).strftime("%H:%M")}')
            if not r['last'] and not self.finished:
                nxt = r['start'] + timedelta(seconds=EVERY)
                L.append(f'  Next round: {hm(nxt)}' + (' (or at once if this one runs past it)' if not r['end'] else '')
                         if nxt > now else '  Next round: right after this one')
        if len(self.rounds) > 1 or self.finished:
            L += ['', 'ROUNDS', '  #   started     took          jobs  sent']
            for r2 in self.rounds:
                took = dur(((r2['end'] or now) - r2['start']).total_seconds()) + ('' if r2['end'] else ' so far')
                L.append(f'  {r2["no"]:<3} {hm(r2["start"]):<11} {took:<13} {len(r2["jobs"]):>4}  {sent(r2["jobs"]):>4}')
        by = Counter(j['d'] for j in self.jobs)
        if by:
            L += ['', 'DRIVERS (whole run)', '  ' + ' · '.join(
                f'{d} {n} job{"s" * (n != 1)} ({sum(1 for j in self.jobs if j["d"] == d and j["o"] == "submitted")} sent)' for d, n in by.most_common())]
        new = self.jobs[self.mailed:]
        if new:
            L += ['', f'JOBS SINCE THE LAST EMAIL ({len(new)})']
            L += [f'  {j["at"].strftime("%H:%M")}  {j["o"]:<17} {j["n"]} ({j["d"]})  {job_name(j["n"])}' for j in new]
        if r and r['notes']:
            L += ['', f'NOTES (round {r["no"]})'] + [f'  {x}' for x in r['notes']]
        if self.allow:
            L += ['', 'ALLOWANCES (start of the latest round)'] + [f'  {x}' for x in self.allow]
        if self.end_line: L += ['', self.end_line]
        L += ['', 'Log: tmp/fm/night/full-night.log · stop after the round in hand: touch tmp/fm/night/stop-night']
        self.mailed = len(self.jobs)
        return '\n'.join(L)

    def subject(self, now, what):
        now = self.finished or now
        el = short((now - self.start).total_seconds()); s, d = sent(self.jobs), len(self.jobs)
        return f'FM run {el}: {what} · {s} sent of {d} jobs'


def round_time(text, after):
    """'Wed 05:44' from a '===== round' line, as the first such moment from the run's start day on."""
    m = re.search(r'(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d\d):(\d\d)', text)
    if not m: return None
    for d in range(8):
        t = (after + timedelta(days=d)).replace(hour=int(m[2]), minute=int(m[3]), second=0, microsecond=0)
        if t.strftime('%a') == m[1] and t >= after - timedelta(minutes=1): return t
    return None


JOB = re.compile(r'^job (\d+) \(([^)]+)\): (.*)$')
run, pos, buf = None, None, b''
deadline = time.time() + 30 * 3600
while time.time() < deadline:
    if not os.path.exists(args.log): time.sleep(30); continue
    with open(args.log, 'rb') as f:
        if pos is None:   # start at this night's first line
            data = f.read(); pos = max(data.rfind(b'##### full night run'), 0)
        f.seek(pos); chunk = f.read(); pos = f.tell()
    buf += chunk
    *done, buf = buf.split(b'\n')
    now = datetime.now().replace(microsecond=0)
    for raw in done:
        line = raw.decode('utf-8', 'replace').rstrip('\r')
        if line.startswith('##### full night run'):
            run = Run(); run.header = line.lstrip('# ')
            m = re.search(r'(\d{4}-\d\d-\d\d \d\d:\d\d)', line)
            run.start = datetime.strptime(m[1], '%Y-%m-%d %H:%M') if m else now
            if not args.once:
                send(f'FM run started: {ROUND_JOBS} jobs a round, every {EVERY // 3600} h',
                     f'{run.header}\n\nAbout {run.rounds_left() * ROUND_JOBS} jobs planned in about {run.rounds_left()} round(s), '
                     f'the last starting at the first {EVERY // 3600}-hour mark from {hm(run.end_at())}.\n'
                     f'A report comes every {args.every or "—"} jobs and at the end of each round.')
            continue
        if run is None: continue
        r = run.round()
        if line.startswith('FULL NIGHT DONE'):
            if r and not r['end']: r['end'] = now
            run.finished, run.end_line = now, line
            send(run.subject(now, 'finished'), run.report(now, 'finished'))
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
            if not args.once:
                send(run.subject(now, f'round {r["no"]} done, {sent(r["jobs"])} sent of {len(r["jobs"])}'), run.report(now, f'round {r["no"]} done'))
        elif r and re.match(r'^written (\d+) briefings', line):
            r['planned'] = int(re.match(r'^written (\d+)', line)[1]); r['apply'] = now
        elif r and JOB.match(line):
            n, d, o = JOB.match(line).groups()
            if 'skipped' in o: r['skipped'] += 1; continue
            j = {'n': n, 'd': d, 'o': o or 'no result', 'at': now}
            r['jobs'].append(j); run.jobs.append(j)
            rd = len(r['jobs']) + r['skipped']
            # every --every jobs since the last email, but not on the round's last job: its round-end email follows
            if args.every and len(run.jobs) - run.mailed >= args.every and rd < (r['planned'] or ROUND_JOBS) and not args.once:
                send(run.subject(now, f'round {r["no"]} at {rd}/{r["planned"] or ROUND_JOBS}'), run.report(now, 'progress'))
        elif r and line.startswith('note: ') and not line.startswith('note: round'):
            r['notes'].append(line[6:])
        elif line.startswith('allowance: '):   # run.sh, before each round: Claude's, Codex's and agy's windows
            if not run._allow_open: run.allow = []
            run.allow.append(line[11:]); run._allow_open = True
            continue
        run._allow_open = False   # the next allowance line starts a new round's block
    if args.once:
        if run: send(run.subject(now, 'status'), run.report(now, 'status'))
        else: print('no full night run in the log')
        sys.exit(0)
    time.sleep(30)
