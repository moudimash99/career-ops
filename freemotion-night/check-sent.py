# freemotion-night/check-sent.py — did the night's applications really go out?
#
# Our records (data/freemotion-submissions.tsv) say what the agent THOUGHT happened.
# The inbox says what the sites did. 2026-09-30: of the HelloWork jobs, three the agent
# left "unconfirmed" had not been sent, one it marked "submitted" was "En erreur" on
# HelloWork, and one it marked "already applied" had never been sent at all. This
# script puts the two side by side, job by job, so that is seen the next morning.
#
# Evidence read (read-only IMAP, the same .env login as imap-link.py):
#   HelloWork  "Votre candidature est arrivée chez X"              -> sent through HelloWork
#              "Finalisez votre candidature sur le site de X"      -> passed on to the employer's
#                                                                    own site: sent only if the
#                                                                    agent finished it there
#              "... n'a pas été transmise ..."                     -> not sent (HelloWork error)
#   Employers  a "candidature" / "application" email naming the company or the job after
#              the attempt -> the employer confirms it received it
# Each email is matched to a job by company, then by job title when a company has several.
#
# Usage:
#   python freemotion-night/check-sent.py                 last 3 days
#   python freemotion-night/check-sent.py --days 1 --run fm-2026-09-30-c
#   python freemotion-night/check-sent.py --fix           also correct our records where the
#                                                         inbox is clear (appends a row through
#                                                         lib/freemotion-submissions.mjs finalize;
#                                                         nothing is ever deleted)
import csv, datetime, email, html, imaplib, os, re, subprocess, sys, unicodedata
from email.header import decode_header
from email.utils import parsedate_to_datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
args = sys.argv[1:]
def flag(name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default
DAYS = int(flag('--days', '3'))
RUN = flag('--run')
FIX = '--fix' in args
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# ── our records ─────────────────────────────────────────────────────────
def norm(s):
    s = unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\b[hf]\s*/\s*[hf](\s*/\s*[xn])?\b', ' ', s)          # H/F, F/H, H/F/X
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()
STOP = {'de', 'des', 'du', 'la', 'le', 'les', 'et', 'en', 'the', 'and', 'for', 'of', 'a', 'h', 'f', 'cdi', 'groupe', 'group', 'france', 'sas', 'sa'}
def words(s): return {w for w in norm(s).split() if w not in STOP and len(w) > 1}

since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=DAYS)
jobs = {}
with open(os.path.join(ROOT, 'data/freemotion-submissions.tsv'), encoding='utf-8', newline='') as fh:
    for r in csv.DictReader(fh, delimiter='\t'):
        try: at = datetime.datetime.fromisoformat(r['timestamp'].replace('Z', '+00:00'))
        except Exception: continue
        if at < since or (RUN and r['run_id'] != RUN) or r['outcome'] == 'rehearsal': continue
        key = (r['url_key'], r['run_id'])
        j = jobs.setdefault(key, {'url': r['raw_url'], 'company': r['company'], 'role': r['role'], 'run': r['run_id'], 'first': at})
        j.update(outcome=r['outcome'], note=r.get('notes', ''), at=at)
# One line per posting: its latest attempt across runs is what counts.
latest, first = {}, {}
for (url, run), j in jobs.items():
    first[url] = min(first.get(url, j['first']), j['first'])
    if j['outcome'] == 'in-progress': continue
    if url not in latest or j['at'] > latest[url]['at']: latest[url] = j
# Emails are looked for from the posting's FIRST attempt in any run: a retry that finds
# "already applied" is answered by the email of the attempt before it.
for url, j in latest.items(): j['first'] = first[url]
jobs = sorted(latest.values(), key=lambda j: j['at'])

# ── the inbox ───────────────────────────────────────────────────────────
env = {}
for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
user, pw = env.get('GMAIL_MACHAKA_USER'), env.get('GMAIL_MACHAKA_APP_PASSWORD')
if not user or not pw: sys.exit('GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD must be set in .env')
def dec(s): return ''.join(p.decode(e or 'utf-8', 'replace') if isinstance(p, bytes) else p for p, e in decode_header(s or ''))
def body_text(msg):
    out = ''
    for part in msg.walk():
        if part.get_content_type() in ('text/plain', 'text/html'):
            try: out += part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', 'replace')
            except Exception: pass
    out = re.sub(r'<style.*?</style>', ' ', out, flags=re.S | re.I)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', out))).replace('‌', '')

M = imaplib.IMAP4_SSL('imap.gmail.com'); M.login(user, pw); M.select('INBOX', readonly=True)
ids = M.search(None, f'(SINCE "{(since - datetime.timedelta(days=1)).strftime("%d-%b-%Y")}")')[1][0].split()
mails = []
for i in ids:
    h = email.message_from_bytes(M.fetch(i, '(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])')[1][0][1])
    subj, frm = dec(h['Subject']), dec(h['From'])
    hw = 'hellowork' in frm.lower()
    if not (hw or re.search(r'candidature|application|postul|applying|votre profil', subj, re.I)): continue
    try: date = parsedate_to_datetime(h['Date'])
    except Exception: continue
    msg = email.message_from_bytes(M.fetch(i, '(BODY.PEEK[])')[1][0][1])
    text = body_text(msg)
    kind, co, title = 'employer', '', ''
    if hw:
        if re.search(r'est arriv', subj, re.I):
            kind = 'hw-sent'
            m = re.search(r'"([^"]{3,160})" pour l.entreprise (.{2,80}?)\.', text)
            if m: title, co = m.group(1), m.group(2)
        elif re.search(r'finalisez', subj, re.I):
            kind = 'hw-redirect'
            m = re.search(r"l.offre (.{3,160}?), vous avez .t. redirig.\(e\) vers le site de l.entreprise (.{2,80}?)\.", text)
            if m: title, co = m.group(1), m.group(2)
        elif re.search(r'transmise', subj + ' ' + text[:600], re.I):
            kind = 'hw-failed'
        elif re.search(r'retenue', subj, re.I):
            kind = 'rejected'
        else:
            continue
        if not co:
            m = re.search(r'(?:chez|site de|entreprise) (.{2,80}?)(?:$|[.,!])', subj)
            co = m.group(1) if m else ''
    mails.append({'kind': kind, 'date': date, 'subject': subj, 'from': frm, 'company': co, 'title': title, 'text': text[:6000]})
M.logout()

# ── match ───────────────────────────────────────────────────────────────
BOARDS = {'hellowork', 'cadremploi', 'apec', 'france travail', 'meteojob', 'free work', 'jobteaser', 'indeed', 'linkedin'}
def company_match(job, mail):
    a, b = norm(job['company']), norm(mail['company'] or mail['subject'] + ' ' + mail['from'])
    # A posting relayed with the board's name as the employer ("Hellowork" for SCC,
    # 2026-09-30): the email names the real company, so only the job title can match.
    if a in BOARDS: return title_score(job, mail) >= 0.6
    if not a: return False
    if a in b or (mail['company'] and norm(mail['company']) in a): return True
    # "Swan.io" vs "Swanio": compare without the spaces too.
    if a.replace(' ', '') in b.replace(' ', ''): return True
    first = [w for w in a.split() if w not in STOP and len(w) >= 4]
    return bool(first) and first[0] in b.split()
def title_score(job, mail):
    jw = words(job['role'])
    return len(jw & words(mail.get('title') or mail.get('subject', '') + ' ' + mail.get('text', '')[:800])) / max(1, len(jw))

def evidence(job):
    after = job['first'] - datetime.timedelta(minutes=10)
    cands = [m for m in mails if m['date'] >= after and company_match(job, m)]
    same_co = [j for j in jobs if j is not job and company_match(j, {'company': job['company'], 'subject': '', 'from': ''})]
    best = {}
    for m in cands:
        s = title_score(job, m)
        if same_co:
            # Several jobs at one company (2026-09-30: two "Ingénieur Validation IVV" at
            # Groupe SII): an email counts only for the job its title fits best, and must
            # fit it at least half. Otherwise one confirmation answers for both.
            rivals = [title_score(j, m) for j in same_co if m['date'] >= j['first'] - datetime.timedelta(minutes=10)]
            if s < 0.5 or any(r > s for r in rivals): continue
        if m['kind'] not in best or s > best[m['kind']][0]: best[m['kind']] = (s, m)
    return {k: m for k, (s, m) in best.items()}

is_hw = lambda j: 'hellowork.com' in j['url']
rows = []
for j in jobs:
    ev = evidence(j)
    if 'hw-failed' in ev: verdict, sent = 'HelloWork: not sent (error)', False
    elif 'hw-sent' in ev: verdict, sent = 'HelloWork: sent', True
    elif 'hw-redirect' in ev:
        if 'employer' in ev: verdict, sent = 'passed to employer site; employer confirmed', True
        elif j['outcome'] == 'submitted': verdict, sent = 'passed to employer site; agent saw a confirmation there', True
        else: verdict, sent = 'passed to employer site; NOT finished there', False
    elif 'employer' in ev: verdict, sent = 'employer confirmed by email', True
    elif is_hw(j) and j['outcome'] in ('submitted', 'errored', 'unknown') and (datetime.datetime.now(datetime.timezone.utc) - j['at']).total_seconds() > 1800:
        verdict, sent = 'no HelloWork email: probably not sent', False
    else: verdict, sent = 'no email found', None
    ours = j['outcome'] in ('submitted', 'already-applied')   # both mean "it went out"
    # "already applied" is only true if it was sent somewhere: HelloWork says "déjà postulé"
    # after a mere redirect too (2026-09-30: Swan.io, never finished on the employer site).
    # An employer site saying so (Lever: "already submitted on August 22") is believed.
    hw_says_applied = j['outcome'] == 'already-applied' and 'hellowork' in (j.get('note') or '').lower()
    mismatch = sent is not None and sent != ours and not (j['outcome'] in ('already-applied', 'captcha') and (sent is not False or not hw_says_applied))
    rows.append((j, verdict, sent, mismatch, 'rejected' in ev))

paris = lambda d: d.astimezone(datetime.timezone(datetime.timedelta(hours=2))).strftime('%d/%m %H:%M')
print(f'Applications from the last {DAYS} day(s){f" (run {RUN})" if RUN else ""}: {len(rows)} postings, {len(mails)} related emails\n')
print(f'{"when":11} {"our record":17} {"what the inbox says":52} company | job')
for j, verdict, sent, mismatch, rej in rows:
    mark = '!!' if mismatch else '  '
    print(f'{mark}{paris(j["at"]):11} {j["outcome"]:17} {verdict + (" (then rejected)" if rej else ""):52} {j["company"]} | {j["role"][:60]}')
bad = [r for r in rows if r[3]]
print(f'\n!! = our record disagrees with the inbox: {len(bad)}')
for j, verdict, sent, *_ in bad:
    print(f'   {("SENT" if sent else "NOT SENT") + ", record says " + j["outcome"]}: {j["company"]} | {j["role"][:60]} | {j["url"]}')

if FIX and bad:
    print('\n--fix: correcting our records (a new row per job; nothing deleted)')
    for j, verdict, sent, *_ in bad:
        outcome = 'submitted' if sent else 'errored'
        r = subprocess.run(['node', os.path.join(ROOT, 'lib/freemotion-submissions.mjs'), 'finalize', '--url', j['url'], '--outcome', outcome,
                            '--run-id', j['run'], '--notes', f'check-sent: {verdict} (inbox, {datetime.date.today()}); retry' if not sent else f'check-sent: {verdict} (inbox, {datetime.date.today()})'],
                           cwd=ROOT, capture_output=True, text=True)
        print(f'   {outcome:9} {j["company"]} | {j["role"][:50]}  {"ok" if r.returncode == 0 else "FAILED: " + (r.stderr or r.stdout)[:200]}')
elif bad:
    print('\nRun with --fix to correct these records (the NOT SENT ones then get retried).')
