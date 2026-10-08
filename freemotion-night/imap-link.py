# freemotion-night/imap-link.py "<subject or sender pattern>" "<expected link host pattern>"
# freemotion-night/imap-link.py "<subject or sender pattern>" --code 8
# Finds the newest matching email from the last 3 days (read-only IMAP) and prints its
# links on the expected host. The one verification-mail reader (the Gmail-API one was removed 2026-10-06).
# --code N instead prints "CODE: <N digits>" from the newest matching email of the last 15 minutes
# (France Travail's sign-in check sends 8 digits, sometimes spaced out); it waits up to 2 minutes for it,
# and never returns an older code.
# Login comes from .env: GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD (a Gmail app password).
import imaplib, email, sys, re, os, datetime, time
from email.header import decode_header
from email.utils import parsedate_to_datetime
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
env = {}
for line in open(os.path.join(root, '.env'), encoding='utf-8'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
user, pw = env.get('GMAIL_MACHAKA_USER'), env.get('GMAIL_MACHAKA_APP_PASSWORD')
if not user or not pw:
    sys.exit('GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD must be set in .env')
def all_mail(M):
    """Gmail's All Mail folder (name depends on the account's language): archived and filtered mail too.
    Reading the Inbox alone missed 109 of 501 application emails since 2026-10-01. Not spam, not bin."""
    for line in M.list()[1]:
        line = line.decode('utf-8', 'replace')
        if '\\All' in line: return line.rsplit(' "/" ', 1)[-1].strip()
    return 'INBOX'

def dec(s):
    return ''.join(p.decode(e or 'utf-8', 'replace') if isinstance(p, bytes) else p for p, e in decode_header(s or ''))
since = (datetime.date.today() - datetime.timedelta(days=3)).strftime('%d-%b-%Y')

if '--code' in sys.argv:
    digits = int(sys.argv[sys.argv.index('--code') + 1])
    subj_pat = re.compile(sys.argv[1], re.I)
    code_re = re.compile(r'(?<!\d)(\d(?:[  -]?\d){%d})(?!\d)' % (digits - 1))
    fresh = time.time() - 15 * 60
    for attempt in range(12):
        M = imaplib.IMAP4_SSL('imap.gmail.com'); M.login(user, pw); M.select(all_mail(M), readonly=True)
        for i in reversed(M.search(None, f'(SINCE "{since}")')[1][0].split()[-25:]):
            msg = email.message_from_bytes(M.fetch(i, '(RFC822)')[1][0][1])
            subj, frm = dec(msg['Subject']), dec(msg['From'])
            if not (subj_pat.search(subj) or subj_pat.search(frm)): continue
            try:
                if parsedate_to_datetime(msg['Date']).timestamp() < fresh: continue
            except Exception: continue
            body = ''
            for part in msg.walk():
                if part.get_content_type() in ('text/plain', 'text/html'):
                    try: body += part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', 'replace')
                    except Exception: pass
            m = code_re.search(re.sub(r'<[^>]+>', ' ', body))
            if m:
                print('FROM:', frm[:60]); print('DATE:', dec(msg['Date'])[:30]); print('CODE:', re.sub(r'\D', '', m.group(1)))
                M.logout(); sys.exit(0)
        M.logout()
        time.sleep(10)
    sys.exit(f'no {digits}-digit code from a matching email in the last 15 minutes')

subj_pat, host_pat = re.compile(sys.argv[1], re.I), re.compile(sys.argv[2], re.I)
M = imaplib.IMAP4_SSL('imap.gmail.com'); M.login(user, pw); M.select(all_mail(M), readonly=True)
ids = M.search(None, f'(SINCE "{since}")')[1][0].split()[-25:]
for i in reversed(ids):
    msg = email.message_from_bytes(M.fetch(i, '(RFC822)')[1][0][1])
    subj, frm, to = dec(msg['Subject']), dec(msg['From']), dec(msg['To'])
    if not (subj_pat.search(subj) or subj_pat.search(frm)): continue
    if user.lower() not in to.lower(): print('SKIP not addressed to candidate:', subj[:60]); continue
    body = ''
    for part in msg.walk():
        if part.get_content_type() in ('text/plain', 'text/html'):
            try: body += part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', 'replace')
            except Exception: pass
    links = [u for u in re.findall(r'https?://[^\s"\'<>]+', body) if host_pat.search(u)]
    print('FROM:', frm[:60]); print('SUBJECT:', subj[:80]); print('DATE:', dec(msg['Date'])[:30])
    for u in dict.fromkeys(links): print("LINK:", u)
    break
M.logout()
