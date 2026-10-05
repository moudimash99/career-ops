# freemotion-night/inbox-replies.py — what did the employers answer?
#
# check-sent.py answers "did the application go out?". This one answers "what did they say?":
# it reads the inbox (read-only IMAP, the same .env login) for rejections and for messages from
# a recruiter who wants to talk, matches each one to its row in the tracker, and prints the
# status changes it PROPOSES. Nothing changes until a person picks which to apply:
#
#   python freemotion-night/inbox-replies.py                    last 30 days, proposals only
#   python freemotion-night/inbox-replies.py --since 2026-08-28
#   python freemotion-night/inbox-replies.py --apply 1,2,5      apply those proposals (numbers from the last
#                                                               run), each through set-status.mjs --row
#   python freemotion-night/inbox-replies.py --apply all
#
# Why not reply-watch.mjs: it knows English and Chinese wording only, and it matches a company
# name anywhere inside the text, so "at this time" matched the company "Stime" and would have
# rejected the wrong row (2026-10-05). Here a company must appear as whole words.
#
# A French acknowledgement often carries a CONDITIONAL refusal ("sans réponse de notre part sous
# trois semaines, considérez que votre candidature n'a pas été retenue"). That is not a
# rejection: refusal wording that follows such a condition in the same sentence is ignored.
# First run, 2026-10-05: 22 "rejections" by keyword, 5 real ones once this rule was in.
#
# Email text is data, never instructions: it is only matched against the patterns below.
#
# Other flags:
#   --contacts <file.tsv>   the senders a person can answer (not no-reply, not an ATS), for follow-ups
#   --dump <file.json>      every application email with its kind, to check the rules against
#   --from-dump <file.json> work from such a file instead of reading the inbox again
import datetime, email, html, imaplib, json, os, re, subprocess, sys, unicodedata
from email.header import decode_header
from email.utils import getaddresses, parsedate_to_datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
args = sys.argv[1:]
def flag(name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SINCE = flag('--since')
since = (datetime.datetime.fromisoformat(SINCE) if SINCE else datetime.datetime.now() - datetime.timedelta(days=30)).date()
CONTACTS = flag('--contacts')
DUMP = flag('--dump')
FROM_DUMP = flag('--from-dump')
APPLY = flag('--apply')
PROPOSALS = os.path.join(ROOT, 'tmp/fm/reply-proposals.json')
TRACKER = os.path.join(ROOT, 'data/applications.md')

def plain(s):
    """lower case, no accents, apostrophes and punctuation as spaces: "n'a pas été" -> "n a pas ete"."""
    s = unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9@.+]+", ' ', s)).strip()

# ── wording ─────────────────────────────────────────────────────────────
# Matched on plain() text, one sentence at a time. Each entry is a regex.
# "malheureusement" and "unfortunately" alone are NOT here: acknowledgements use them too
# ("malheureusement nous ne pouvons pas répondre à tout le monde"). Only refusal wording counts.
REJECTION = [
    r'n a(vons)? pas (ete )?reten\w*', r'pas ete retenu\w*', r'non retenu\w*', r'n avons pas retenu',
    r'ne (peut|pourra|sera|pourrons) pas (etre )?reten\w*',
    r'ne (pourrons|pouvons|sommes) pas (\w+ ){0,4}(donner|reserver) (une )?suite', r'ne (donnerons|donnons) pas suite',
    r'n allons pas (y )?donner suite', r'pas (de |donner |une )*suite (favorable|positive)', r'reponse (negative|defavorable)',
    r'au regret de', r'nous regrettons',
    r'ne (convient|correspond)\w*( \w+)? pas', r'poursuivre (le processus )?avec d autres', r'd autres candidat\w*( dont| qui| plus)',
    r'poste (a ete|est) (deja )?pourvu', r'a la recherche d un profil (disposant|ayant|plus)', r'experience plus (significative|importante)',
    r'not (been )?(selected|retained|successful)', r'not (be )?(moving|proceeding|progressing) forward',
    r'will not be (moving|proceeding|progressing)', r'decided (not to|to (focus on|move forward with|pursue|proceed with|go with))',
    r'other candidates whose', r'unable to offer you', r'do not feel (like|that)', r'not (a|the) (right |best )?(fit|match)',
    r'regret to inform', r'no longer under consideration', r'position has been filled',
]
# A refusal or an invitation that follows one of these IN THE SAME SENTENCE is conditional
# ("si vous n'avez pas de réponse sous 15 jours, …", "if you are not selected, …"): it is ignored.
# "si oui" is a question to the candidate, not a condition on the answer.
CONDITIONAL = r'\b(si (?!oui\b)|s ils? |if |unless |sans |a defaut |en l absence |dans le cas |au cas ou |en cas de |au dela |a l inverse |passe ce delai|should you )'
TENTATIVE = CONDITIONAL + r'|susceptible|pourrions|pourrait|pourront|eventuel|le cas echeant|\b(may|might)\b|shortlisted'
INTERVIEW = [
    r'vos disponibilites', r'(etes|seriez) vous disponible', r'convenir d un (rendez|creneau|echange|entretien|appel)',
    r'(planifier|organiser|fixer|programmer) un (premier )?(entretien|echange|appel|rendez)', r'proposer un (creneau|entretien|echange)',
    r'(nous|je) (\w+ )?souhait\w+ (echanger|m entretenir|vous rencontrer|vous contacter|discuter) ', r'invit\w+ a (un|passer un) entretien',
    r'prise de rendez vous', r'calendly\.com', r'schedule (an?|your) (interview|call|chat)\b', r'invite you to (an? )?interview',
    r'book a (time|slot|call)', r'(phone|video) (screen|interview) with',
]
# A job board's copy of our own application quotes the cover letter ("j'aimerais échanger avec
# vous"): no invitation is read from these senders.
BOARD_SENDERS = r'hellowork|free-work|freework|apec\.fr|welcometothejungle|francetravail|linkedin|indeed'
CONFIRMATION = [
    r'bien recu\w* votre candidature', r'accuse\w* (de )?reception', r'bien (ete )?(enregistre|prise en compte|transmise|recue)',
    r'candidature est (bien )?arrivee', r'merci (d avoir postule|pour votre candidature|de votre candidature|de l interet)',
    r'received your application', r'thank you for (applying|your application|your interest)', r'application (has been )?(received|submitted)',
]
# The subject, or failing that the sender's name, must look like recruiting ("Mohammad x Swile",
# "Thanks for applying to …", "Echangeons sur votre parcours" all count).
ABOUT_AN_APPLICATION = r'candidat|appl(y|ying|ied|ication)|postul|recrut|recruit|entretien|interview|votre profil|your profile|poste|opportunit|suite a|update|statut|status|rendez|echang|parcours|screening|assessment|consideration|thanks for|thank you for|hiring|talent|career|carriere| x '
RECRUITING_SENDER = r'recrut|recruit|talent|hiring|career|carriere|ressources humaines|\b(rh|hr)\b|\bjobs?\b|people'
# Job alerts, newsletters and account housekeeping, not answers.
NOISE = r'alerte|nouvelles? offres?|offres? (qui|pour vous|correspond)|jobs? (for you|alert)|recommand|newsletter|digest|webinar|completez votre profil|finalisez|validez|valider votre|confirme[rz] votre (e ?mail|adresse|compte)|code (temporaire|de securite)|security (alert|code)|bienvenue|welcome|verify|mot de passe|password|facture|invoice'
# Senders nobody reads replies to.
AUTOMATED = r'(no[-_. ]?reply|noreply|nepasrepondre|ne[-_. ]pas[-_. ]repondre|do[-_. ]?not[-_. ]?reply|notification|mailer|bounce|postmaster|system|automat|workflow)'
ATS_DOMAINS = r'(smartrecruiters|myworkday|workday|greenhouse|lever\.co|ashbyhq|taleez|welcomekit|welcometothejungle|hellowork|apec\.fr|teamtailor|recruitee|jobteaser|icims|successfactors|talentsoft|cegid|digitalrecruiters|flatchr|jobaffinity|beetween|softy|werecruit|francetravail|free-work|linkedin|indeed|talent-soft|jobvite|bamboohr|personio)'

def first_hit(patterns, text):
    for p in patterns:
        m = re.search(p, text)
        if m: return m
    return None

def sentences(text):
    return [s for s in (plain(p) for p in re.split(r'(?<=[.!?;:])\s+', text)) if s]

def stated(patterns, sents, guard):
    """The first hit that no `guard` wording precedes in its own sentence."""
    for s in sents:
        for p in patterns:
            m = re.search(p, s)
            if m and not re.search(guard, s[:m.start()] + ' '): return m.group(0)
    return ''

def classify(subject, body, sender=''):
    """-> (kind, evidence). kind: rejection | interview | confirmation | other."""
    sents = sentences(subject + ' . ' + body[:6000])
    hit = stated(REJECTION, sents, CONDITIONAL)
    if hit: return 'rejection', hit
    if not re.search(BOARD_SENDERS, sender.lower()):
        hit = stated(INTERVIEW, sents, TENTATIVE)
        if hit: return 'interview', hit
    m = first_hit(CONFIRMATION, ' '.join(sents))
    if m: return 'confirmation', m.group(0)
    return 'other', ''

# ── the inbox ───────────────────────────────────────────────────────────
def dec(s): return ''.join(p.decode(e or 'utf-8', 'replace') if isinstance(p, bytes) else p for p, e in decode_header(s or ''))
def body_text(msg):
    out = ''
    for part in msg.walk():
        if part.get_content_type() in ('text/plain', 'text/html'):
            try: out += part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', 'replace')
            except Exception: pass
    out = re.sub(r'<(style|script).*?</\1>', ' ', out, flags=re.S | re.I)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', out))).replace('‌', '').strip()
def address(header):
    pairs = getaddresses([header or ''])
    return pairs[0][1].lower() if pairs and pairs[0][1] else ''
def answerable(addr):
    """An address a person may read: not a no-reply box and not an applicant-tracking system."""
    return bool(addr) and not re.search(AUTOMATED, addr.split('@')[0]) and not re.search(ATS_DOMAINS, addr.split('@')[-1])

def read_inbox():
    """-> (mails about an application, how many emails the inbox held, the skipped ones' sender and subject)."""
    env = {}
    for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
    user, pw = env.get('GMAIL_MACHAKA_USER'), env.get('GMAIL_MACHAKA_APP_PASSWORD')
    if not user or not pw: sys.exit('GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD must be set in .env')
    M = imaplib.IMAP4_SSL('imap.gmail.com'); M.login(user, pw); M.select('INBOX', readonly=True)
    ids = M.search(None, f'(SINCE "{since.strftime("%d-%b-%Y")}")')[1][0].split()
    mails, skipped = [], []
    for i in ids:
        h = email.message_from_bytes(M.fetch(i, '(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE REPLY-TO MESSAGE-ID)])')[1][0][1])
        subj, frm = dec(h['Subject']), dec(h['From'])
        if address(frm) == user.lower(): continue                      # our own mail
        ps = plain(subj)
        about = re.search(ABOUT_AN_APPLICATION, f' {ps} ') or re.search(RECRUITING_SENDER, plain(frm))
        if not about or re.search(NOISE, ps):
            skipped.append({'kind': 'skipped', 'from': frm, 'subject': subj})
            continue
        try: date = parsedate_to_datetime(h['Date'])
        except Exception: continue
        text = body_text(email.message_from_bytes(M.fetch(i, '(BODY.PEEK[])')[1][0][1]))
        mails.append({'date': date.isoformat(), 'from': frm, 'subject': subj, 'text': text[:6000],
                      'reply_to': address(dec(h['Reply-To'])) or address(frm),
                      'message_id': (h['Message-ID'] or f'imap-{i.decode()}').strip()})
    M.logout()
    return mails, len(ids), skipped

# ── the tracker ─────────────────────────────────────────────────────────
STOP = {'de', 'des', 'du', 'la', 'le', 'les', 'et', 'en', 'the', 'and', 'for', 'of', 'a', 'h', 'f', 'cdi', 'groupe', 'group', 'france', 'sas', 'sa'}
def norm(s):
    s = unicodedata.normalize('NFD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'\b[hf]\s*/\s*[hf](\s*/\s*[xn])?\b', ' ', s)          # H/F, F/H, H/F/X
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()
def words(s): return {w for w in norm(s).split() if w not in STOP and len(w) > 1}

def tracker_rows():
    rows = []
    for line in open(TRACKER, encoding='utf-8'):
        if not line.startswith('|'): continue
        cells = [c.strip() for c in re.split(r'(?<!\\)\|', line.strip())[1:-1]]
        if len(cells) < 9 or not cells[0].isdigit(): continue
        rows.append({'num': int(cells[0]), 'date': cells[1], 'company': cells[2], 'role': cells[3], 'status': cells[5], 'notes': cells[8]})
    return rows

def names_company(company, mail):
    """The company's name as WHOLE words in the subject or the sender; a longer name may also sit in
    the first lines of the body. Never a substring: "at this time" is not the company "Stime"."""
    a = norm(company)
    if len(a) < 3: return False
    head = f" {norm(mail['subject'] + ' ' + mail['from'])} "
    if f' {a} ' in head: return True
    squashed = a.replace(' ', '')                                      # "Swan.io" / "swanio", "Alice & Bob" / "alicebob"
    if len(squashed) >= 6 and squashed in head.replace(' ', ''): return True
    return (len(a) >= 6 or ' ' in a) and f' {a} ' in f" {norm(mail['text'][:700])} "

def title_score(role, mail):
    rw = words(role)
    return len(rw & words(mail['subject'] + ' ' + mail['text'][:1500])) / max(1, len(rw))

OPEN = {'Applied', 'Responded', 'Interview'}
def match(mail, rows):
    """-> (rows to change, rows to choose from). One of the two is empty."""
    day = mail['date'][:10]
    here = [r for r in rows if r['status'] in OPEN and r['date'] <= day and names_company(r['company'], mail)]
    if len(here) <= 1: return here, []
    scored = sorted(((title_score(r['role'], mail), r) for r in here), key=lambda p: -p[0])
    top = scored[0][0]
    best = [r for s, r in scored if s >= top - 0.01]
    # Several rows at one company: the email must name the job. "Retour sur vos candidatures"
    # lists two jobs and both fit fully; a single-job email fits one row best.
    if top >= 0.6 and len(best) <= 3: return best, []
    return [], [r for _, r in scored[:6]]

# ── run ─────────────────────────────────────────────────────────────────
def apply(which):
    try: props = json.load(open(PROPOSALS, encoding='utf-8'))
    except Exception: sys.exit(f'No proposals at {os.path.relpath(PROPOSALS, ROOT)}: run without --apply first.')
    wanted = props if which == 'all' else [p for p in props if str(p['n']) in {w.strip() for w in which.split(',')}]
    if not wanted: sys.exit('None of those numbers is a proposal from the last run.')
    for p in wanted:
        r = subprocess.run(['node', os.path.join(ROOT, 'set-status.mjs'), '--row', str(p['row']), p['to'], '--note', p['note']],
                           cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
        print(f"{p['n']:>3}  #{p['row']} {p['company']} | {p['role'][:50]}: {p['to']}  {'ok' if r.returncode == 0 else 'FAILED: ' + (r.stderr or r.stdout).strip()[:200]}")

def main():
    if APPLY: return apply(APPLY)
    if FROM_DUMP:
        mails = [m for m in json.load(open(FROM_DUMP, encoding='utf-8')) if m.get('kind') != 'skipped']
        total, skipped = len(mails), []
    else:
        mails, total, skipped = read_inbox()
    rows = tracker_rows()
    counts, contacts, answers = {}, {}, []
    for m in mails:
        m['kind'], m['evidence'] = classify(m['subject'], m['text'], m['from'])
        counts[m['kind']] = counts.get(m['kind'], 0) + 1
        rt = m.get('reply_to') or address(m['from'])
        if answerable(rt):
            c = contacts.setdefault(rt, {'address': rt, 'name': m['from'], 'mails': 0, 'kinds': set(), 'last': m['date'], 'subject': m['subject']})
            c['mails'] += 1; c['kinds'].add(m['kind'])
            if m['date'] >= c['last']: c['last'], c['subject'] = m['date'], m['subject']
        if m['kind'] in ('rejection', 'interview'): answers.append(m)
    if DUMP:
        os.makedirs(os.path.dirname(os.path.abspath(DUMP)), exist_ok=True)
        with open(DUMP, 'w', encoding='utf-8') as fh: json.dump(mails + skipped, fh, ensure_ascii=False, indent=1)

    who = lambda m: re.sub(r'<.*>', '', m['from']).replace('"', '').strip()[:34]
    print(f'Inbox since {since}: {total} emails, {len(mails)} about an application')
    for k in ('rejection', 'interview', 'confirmation', 'other'): print(f'  {k:13} {counts.get(k, 0)}')

    props, choose, norow, seen = [], [], [], set()
    for m in sorted(answers, key=lambda m: m['date']):
        to = 'Rejected' if m['kind'] == 'rejection' else 'Responded'
        hit, among = match(m, rows)
        for r in hit:
            if (r['num'], to) in seen: continue                        # the same answer sent twice
            seen.add((r['num'], to))
            what = 'Rejected by email' if to == 'Rejected' else 'Recruiter wrote, asks to talk'
            props.append({'n': len(props) + 1, 'row': r['num'], 'company': r['company'], 'role': r['role'], 'from': r['status'], 'to': to,
                          'note': f"{what} {m['date'][:10]} ({who(m)}).", 'mail': m['subject'][:90], 'date': m['date'][:10], 'evidence': m['evidence']})
        if among: choose.append((m, to, among))
        if not hit and not among: norow.append((m, to))
    os.makedirs(os.path.dirname(PROPOSALS), exist_ok=True)
    with open(PROPOSALS, 'w', encoding='utf-8') as fh: json.dump(props, fh, ensure_ascii=False, indent=1)

    talk = [m for m in answers if m['kind'] == 'interview']
    if talk:
        print(f'\nA RECRUITER WANTS TO TALK ({len(talk)}): answer these yourself')
        for m in talk: print(f"   {m['date'][:10]}  {who(m)} | {m['subject'][:70]}  <{m.get('reply_to') or address(m['from'])}>")
    print(f'\nPROPOSED CHANGES ({len(props)}): nothing is changed until you run --apply')
    for p in props: print(f"{p['n']:>3}  #{p['row']} {p['company']} | {p['role'][:52]}: {p['from']} -> {p['to']}   [{p['date']}, \"{p['evidence']}\"]")
    if choose:
        print(f'\nWHICH ROW? ({len(choose)}): the company has several open rows and the email does not name one')
        for m, to, among in choose:
            print(f"   {m['date'][:10]}  {who(m)} | {m['subject'][:60]}  -> {to}")
            for r in among: print(f"        #{r['num']} {r['company']} | {r['role'][:60]} ({r['date']})")
    if norow:
        print(f'\nNO ROW IN THE TRACKER ({len(norow)}): nothing to update')
        for m, to in norow: print(f"   {m['date'][:10]}  {who(m)} | {m['subject'][:70]}  ({to})")
    if props: print(f'\nTo apply: python freemotion-night/inbox-replies.py --apply 1,2,…   (or --apply all)')

    if CONTACTS:
        os.makedirs(os.path.dirname(os.path.abspath(CONTACTS)), exist_ok=True)
        with open(CONTACTS, 'w', encoding='utf-8') as fh:
            fh.write('address\tname\tmails\tkinds\tlast\tlast_subject\n')
            for c in sorted(contacts.values(), key=lambda c: c['last'], reverse=True):
                fh.write('\t'.join([c['address'], c['name'].replace('\t', ' '), str(c['mails']), ','.join(sorted(c['kinds'])), c['last'][:10], c['subject'].replace('\t', ' ')]) + '\n')
        print(f'\n{len(contacts)} senders a person can answer -> {os.path.relpath(CONTACTS, ROOT)}')

if __name__ == '__main__':
    main()
