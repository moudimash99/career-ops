# freemotion-night/imap-link.py "<subject or sender pattern>" "<expected link host pattern>"
# Finds the newest matching email from the last 3 days (read-only IMAP) and prints its
# links on the expected host. Stands in for lib/freemotion-inbox.mjs while Gmail OAuth is broken.
# Login comes from .env: GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD (a Gmail app password).
import imaplib, email, sys, re, os, datetime
from email.header import decode_header
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
env = {}
for line in open(os.path.join(root, '.env'), encoding='utf-8'):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
user, pw = env.get('GMAIL_MACHAKA_USER'), env.get('GMAIL_MACHAKA_APP_PASSWORD')
if not user or not pw:
    sys.exit('GMAIL_MACHAKA_USER and GMAIL_MACHAKA_APP_PASSWORD must be set in .env')
subj_pat, host_pat = re.compile(sys.argv[1], re.I), re.compile(sys.argv[2], re.I)
since = (datetime.date.today() - datetime.timedelta(days=3)).strftime('%d-%b-%Y')
M = imaplib.IMAP4_SSL('imap.gmail.com'); M.login(user, pw); M.select('INBOX', readonly=True)
ids = M.search(None, f'(SINCE "{since}")')[1][0].split()[-25:]
def dec(s):
    return ''.join(p.decode(e or 'utf-8', 'replace') if isinstance(p, bytes) else p for p, e in decode_header(s or ''))
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
