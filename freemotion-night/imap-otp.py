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
subj_pat = re.compile("hellowork", re.I)
since = (datetime.date.today() - datetime.timedelta(days=3)).strftime('%d-%b-%Y')
M = imaplib.IMAP4_SSL('imap.gmail.com'); M.login(user, pw); M.select('INBOX', readonly=True)
ids = M.search(None, f'(SINCE "{since}")')[1][0].split()[-25:]
def dec(s):
    return ''.join(p.decode(e or 'utf-8', 'replace') if isinstance(p, bytes) else p for p, e in decode_header(s or ''))
for i in reversed(ids):
    msg = email.message_from_bytes(M.fetch(i, '(RFC822)')[1][0][1])
    subj, frm, to = dec(msg['Subject']), dec(msg['From']), dec(msg['To'])
    if not (subj_pat.search(subj) or subj_pat.search(frm)): continue
    if user.lower() not in to.lower(): continue
    body = ''
    for part in msg.walk():
        if part.get_content_type() in ('text/plain', 'text/html'):
            try: body += part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8', 'replace')
            except Exception: pass
    print('FROM:', frm[:60]); print('SUBJECT:', subj[:120]); print('DATE:', dec(msg['Date'])[:30])
    print('BODY:', body)
    break
M.logout()
