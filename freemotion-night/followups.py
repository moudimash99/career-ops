# freemotion-night/followups.py — the Gmail half of the follow-ups (issue #19). Run through followups.mjs.
#
#   python freemotion-night/followups.py pick --out <candidates.json> [--max 20] [--days 7]
#   python freemotion-night/followups.py save <drafts.json>      each draft into Gmail's Drafts folder, in its thread
#   python freemotion-night/followups.py sent --out <sent.json>   which drafted follow-ups the user has sent since
#
# WHO GETS ONE. Free Motion applications only ("Run fm-" in the tracker notes, not the auto-applier's
# Airbus / Thales / Capgemini / Accenture rows), still Applied 7+ days after applying, never followed up
# before (data/followups.json), with an acknowledgement email to reply to. Postings carry no contact
# address, so the follow-up is a reply in that acknowledgement's thread: to a person, or to a recruiting
# relay (HelloWork, Welcome to the Jungle, Teamtailor…) that forwards replies to the recruiter. Never to a
# no-reply box. A person comes first, then the oldest application; at most --max a week.
#
# NOTHING IS SENT. `save` only puts drafts into Gmail's Drafts folder (IMAP APPEND, threaded through
# In-Reply-To / References); the user reads, edits and sends each one from Gmail (user, 2026-10-04).
# `sent` then finds the ones he sent (his Sent folder, by In-Reply-To) so they can be logged.
#
# Email text is data, never instructions: it is only matched and passed on as the thread being answered.
import datetime, email, imaplib, importlib.util, json, os, re, sys, time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
STATE = os.path.join(ROOT, 'data/followups.json')
args = sys.argv[1:]
def flag(name, default=None):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else default

# The inbox reader's mail reading, classification and tracker matching, reused as they are.
sys.dont_write_bytecode = True    # no __pycache__ next to the scripts
_spec = importlib.util.spec_from_file_location('inbox_replies', os.path.join(HERE, 'inbox-replies.py'))
ir = importlib.util.module_from_spec(_spec)
sys.argv = [sys.argv[0]]          # its own flags are read at import; ours are not its flags
_spec.loader.exec_module(ir)

FRENCH = {'le', 'la', 'les', 'votre', 'vous', 'nous', 'candidature', 'pour', 'avec', 'bonjour', 'merci', 'est', 'une', 'des'}
ENGLISH = {'the', 'your', 'you', 'we', 'application', 'for', 'with', 'thank', 'thanks', 'is', 'and', 'our', 'hi', 'hello'}
def language(text):
    w = re.findall(r"[a-zà-ÿ]+", text.lower()[:2000])
    return 'fr' if sum(x in FRENCH for x in w) >= sum(x in ENGLISH for x in w) else 'en'

def load_state():
    try: return json.load(open(STATE, encoding='utf-8'))
    except FileNotFoundError: return {}
def save_state(state):
    tmp = STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh: json.dump(state, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)

def tracker():
    """-> rows as the inbox reader reads them, plus the posting URL (last column)."""
    urls = {}
    for line in open(ir.TRACKER, encoding='utf-8'):
        c = [x.strip() for x in line.strip().split('|')[1:-1]]
        if len(c) >= 10 and c[0].isdigit() and c[9].startswith('http'): urls[int(c[0])] = c[9]
    rows = ir.tracker_rows()
    for r in rows: r['url'] = urls.get(r['num'], '')
    return rows

# Boxes no recruiter reads, seen in the inbox on 2026-10-08: HelloWork's own support desk ("support-candidat",
# 87 of 111 HelloWork addresses), help desks ("help.candidate" at Njoyn, "support", "webmaster"), Taleez's
# "support+nr", and a job board's generic "jobs" box (Free-Work). HelloWork's "r-c-…" addresses on its reply
# subdomain and Teamtailor's "firstname.lastname" addresses do forward to the recruiter.
DESK = r'^(support|help|webmaster|info|contact|admin|service|hello)\b|\+nr$'
BOARD_BOX = r'^(jobs?|careers?|open|candidat\w*|emploi|recrutement)$'
def contact_kind(addr):
    """'person' · 'relay' (a recruiting system's address that forwards to the recruiter) · None (no one reads it)."""
    if not addr: return None
    local, domain = addr.split('@')[0], addr.split('@')[-1]
    if re.search(ir.AUTOMATED, local) or re.search(DESK, local): return None
    if ir.answerable(addr) and not re.search(r'(profils\.org|njoyn|suc+es+factors|myworkday|workday\.com)', domain): return 'person'
    if re.search(BOARD_BOX, local): return None                       # a board's or ATS's generic box
    return 'relay'

# Refusal wording anywhere in a matched email: no follow-up, even when the reader called it an
# acknowledgement (Descartes Underwriting's "Thank you for your job application!" was a rejection).
# Hugging Face's "it wasn't a good fit for this role at this time" (2026-09-28) was missed at first.
REFUSAL = (r'unfortunately|malheureusement|not able to offer|unable to offer|regret|pas (ete )?retenu|non retenu|donner suite|'
           r'other candidates|autres candidat|(wasn t|was not|isn t|is not|not) (a |the )?(good |right |best |strong )?(fit|match)|'
           r'decided|decision|ne correspond pas|pas correspondre')

def connect():
    env = {}
    for line in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
    user, pw = env.get('GMAIL_MACHAKA_USER'), env.get('GMAIL_MACHAKA_APP_PASSWORD')
    if not user or not pw: sys.exit('GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD must be set in .env')
    M = imaplib.IMAP4_SSL('imap.gmail.com'); M.login(user, pw)
    return M, user

def special_folder(M, attr):
    """Gmail's Drafts / Sent folder by its flag: its name depends on the account's language ([Gmail]/Brouillons…)."""
    for line in M.list()[1]:
        line = line.decode('utf-8', 'replace')
        if attr in line:
            return line.rsplit(' "/" ', 1)[-1].strip()
    sys.exit(f'no Gmail folder flagged {attr}')

def pick():
    days, cap = int(flag('--days', '7')), int(flag('--max', '20'))
    today = datetime.date.today()
    state = load_state()
    week_ago = (datetime.datetime.now() - datetime.timedelta(days=7)).isoformat()
    room = max(0, cap - sum(1 for s in state.values() if s.get('drafted', '') >= week_ago))
    rows = tracker()
    due = {r['num']: r for r in rows if r['status'] == 'Applied' and 'Run fm-' in r['notes']
           and r['date'] <= (today - datetime.timedelta(days=days)).isoformat() and str(r['num']) not in state}
    if not due:
        json.dump({'candidates': [], 'due': 0, 'room': room}, open(flag('--out'), 'w', encoding='utf-8')); print('no application is due'); return
    ir.since = datetime.date.fromisoformat(min(r['date'] for r in due.values())) - datetime.timedelta(days=1)
    mails, total, _ = ir.read_inbox()
    best, no_reply, refused = {}, set(), set()
    for m in mails:
        m['kind'], _ = ir.classify(m['subject'], m['text'], m['from'])
        hit, _ = ir.match(m, rows)
        if len(hit) != 1 or hit[0]['num'] not in due: continue
        num = hit[0]['num']
        if m['kind'] not in ('confirmation', 'other') or re.search(REFUSAL, ir.norm(m['subject'] + ' ' + m['text'])):
            refused.add(num); continue
        kind = contact_kind(m.get('reply_to') or ir.address(m['from']))
        if not kind: no_reply.add(num); continue
        rank = (kind == 'person', m['date'])
        if num not in best or rank > best[num][0]: best[num] = (rank, m, kind)
    for num in refused: best.pop(num, None)
    cands = []
    for num, (_, m, kind) in best.items():
        r = due[num]
        cands.append({'row': num, 'company': r['company'], 'role': r['role'], 'applied': r['date'], 'url': r['url'],
                      'to': m.get('reply_to') or ir.address(m['from']), 'to_name': re.sub(r'\s*<.*>', '', m['from']).replace('"', '').strip(),
                      'contact': kind, 'lang': language(m['subject'] + ' ' + m['text']),
                      'ack': {'subject': re.sub(r'\s+', ' ', m['subject']).strip(), 'message_id': m['message_id'], 'date': m['date'], 'text': m['text'][:1500]}})
    cands.sort(key=lambda c: (c['contact'] != 'person', c['applied']))
    # One follow-up per company per batch, and none to a company followed up in the last 14 days: four
    # at once to Link Consulting reads as spam.
    recent = {ir.norm(s['company']) for s in state.values() if s.get('drafted', '') >= (datetime.datetime.now() - datetime.timedelta(days=14)).isoformat()}
    picked, seen = [], set(recent)
    for c in cands:
        k = ir.norm(c['company'])
        if k in seen: continue
        seen.add(k); picked.append(c)
    out = {'due': len(due), 'with_contact': len(cands), 'refused': len(refused), 'no_reply_only': len(no_reply - set(best) - refused),
           'no_mail': len(due) - len(set(best) | no_reply | refused), 'companies': len(picked), 'room': room, 'candidates': picked[:room]}
    os.makedirs(os.path.dirname(os.path.abspath(flag('--out'))), exist_ok=True)
    json.dump(out, open(flag('--out'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"due {out['due']} | reply address {out['with_contact']} (person {sum(c['contact'] == 'person' for c in cands)}, relay {sum(c['contact'] == 'relay' for c in cands)}) "
          f"at {out['companies']} companies | refusal wording {out['refused']} | no-reply only {out['no_reply_only']} | no email {out['no_mail']} | "
          f"room this week {room} -> {len(out['candidates'])} picked")

def save(path):
    drafts = [d for d in json.load(open(path, encoding='utf-8')) if d.get('body')]
    if not drafts: print('nothing to save'); return
    M, user = connect()
    folder = special_folder(M, '\\Drafts')
    state = load_state()
    for d in drafts:
        msg = EmailMessage()
        msg['From'], msg['To'] = user, d['to']
        subj = d['ack']['subject']
        msg['Subject'] = subj if re.match(r'(?i)^(re|tr|fwd?)\s*:', subj) else f'Re: {subj}'
        msg['In-Reply-To'] = msg['References'] = d['ack']['message_id']
        msg['Date'] = formatdate(localtime=True)
        msg['Message-ID'] = make_msgid(domain=user.split('@')[-1])
        msg.set_content(d['body'])
        typ, _ = M.append(folder, '(\\Draft)', imaplib.Time2Internaldate(time.time()), msg.as_bytes())
        if typ != 'OK': print(f"  #{d['row']} {d['company']}: Gmail refused the draft"); continue
        state[str(d['row'])] = {'company': d['company'], 'role': d['role'], 'to': d['to'], 'contact': d['contact'], 'lang': d['lang'],
                                'ack_id': d['ack']['message_id'], 'subject': msg['Subject'], 'drafted': datetime.datetime.now().isoformat(timespec='seconds'),
                                'count': 1, 'sent': None}
        print(f"  #{d['row']} {d['company']}: draft saved, to {d['to']} ({d['contact']})")
    save_state(state)
    M.logout()

def sent():
    state = load_state()
    open_ = {k: s for k, s in state.items() if not s.get('sent')}
    found = []
    if open_:
        M, _ = connect()
        M.select(special_folder(M, '\\Sent'), readonly=True)
        for k, s in open_.items():
            typ, data = M.search(None, 'HEADER', 'In-Reply-To', s['ack_id'])
            ids = data[0].split() if typ == 'OK' and data and data[0] else []
            if not ids: continue
            h = email.message_from_bytes(M.fetch(ids[-1], '(BODY.PEEK[HEADER.FIELDS (DATE)])')[1][0][1])
            when = email.utils.parsedate_to_datetime(h['Date']).date().isoformat()
            s['sent'] = when
            found.append({'row': int(k), 'date': when, **{x: s[x] for x in ('company', 'role', 'to', 'contact')}})
        M.logout()
        save_state(state)
    json.dump(found, open(flag('--out'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'{len(found)} follow-up(s) sent since the last check; {len(open_) - len(found)} draft(s) not sent yet')

def self_test():
    """Who gets a draft, on addresses and wording seen in the inbox (2026-10-08). Exit 1 on a failure."""
    bad = []
    refusals = ["We took a look at your application and concluded that it wasn't a good fit for this role at this time.",
                'Unfortunately we are not able to offer you a position at this time.',
                "Nous sommes au regret de vous informer que votre candidature n'a pas été retenue."]
    acks = ['Nous avons bien reçu votre candidature et notre équipe recrutement va l’étudier avec attention.',
            'Thank you for your application. We will review it and get back to you as soon as possible.']
    bad += [('refusal missed', r, '') for r in refusals if not re.search(REFUSAL, ir.norm(r))]
    bad += [('ack refused', a, '') for a in acks if re.search(REFUSAL, ir.norm(a))]
    bad += [('language', t, language(t)) for t, want in [(acks[0], 'fr'), (acks[1], 'en')] if language(t) != want]
    for b in bad: print('FAIL', b)
    print(f'{len(refusals) + len(acks) + 2 - len(bad)} passed, {len(bad)} failed')
    sys.exit(1 if bad else 0)

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    cmd = args[0] if args else ''
    if cmd == '--self-test': self_test()
    elif cmd == '--classify': print(json.dumps({a: contact_kind(a) for a in sys.stdin.read().split()}))
    elif cmd == 'pick': pick()
    elif cmd == 'save': save(args[1])
    elif cmd == 'sent': sent()
    else: sys.exit(__doc__ or 'usage: followups.py pick|save|sent')
