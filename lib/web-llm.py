"""lib/web-llm.py — one prompt to the Gemini or ChatGPT website, signed in with the user's own accounts (#59).

The writers in lib/doc-writers.mjs call it when the other writers' allowances run out:

    python lib/web-llm.py ask gemini  < prompt.txt   # the answer on stdout
    python lib/web-llm.py ask chatgpt < prompt.txt
    python lib/web-llm.py signin                     # visible window: sign in to both sites once, close it
    python lib/web-llm.py check                      # is each site still signed in?

Both sites use one saved Camoufox profile in tmp/web-llm/profile (git-ignored; WEB_LLM_DIR moves it).
Signing in once is enough: the profile keeps both sessions.
  gemini   gemini-webapi with the profile's two Google cookies (the library renews the short-lived one
           and keeps it in tmp/web-llm/gemini-cookies). If Google refuses them, the cookies are read
           again from the profile, once, before giving up.
  chatgpt  the profile opened hidden on chatgpt.com, in a temporary chat (no history, no memory):
           the prompt goes in the box, the answer is read off the page once ChatGPT stops writing.
Exit codes: 0 answered, 2 signed out (run `signin`), 3 limit reached, 1 anything else.
"""
import asyncio, json, os, pathlib, re, sys, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIR = pathlib.Path(os.environ.get('WEB_LLM_DIR') or ROOT / 'tmp' / 'web-llm')
PROFILE = DIR / 'profile'
COOKIES = DIR / 'cookies.json'
# Empty: the site's default model. gemini-pro answers this account with an error card (2026-10-15).
GEMINI_MODEL = os.environ.get('WEB_LLM_GEMINI_MODEL') or None
ANSWER_TIMEOUT_S = int(os.environ.get('WEB_LLM_TIMEOUT', '480'))

SIGNED_OUT, LIMIT = 2, 3


class Fail(Exception):
    def __init__(self, msg, code=1):
        super().__init__(msg)
        self.code = code


def browser(headless=True):
    from camoufox.sync_api import Camoufox
    PROFILE.mkdir(parents=True, exist_ok=True)
    return Camoufox(headless=headless, persistent_context=True, user_data_dir=str(PROFILE))


def save_cookies(ctx):
    keep = [c for c in ctx.cookies() if any(d in c['domain'] for d in ('google', 'chatgpt', 'openai'))]
    COOKIES.write_text(json.dumps(keep))
    return keep


def signed_in(cookies):
    names = {c['name'] for c in cookies}
    return {
        'gemini': {'__Secure-1PSID', '__Secure-1PSIDTS'} <= names,
        'chatgpt': any(n.startswith('__Secure-next-auth.session-token') for n in names),
    }


# ---------- gemini ----------

def google_cookies():
    try:
        c = {x['name']: x['value'] for x in json.loads(COOKIES.read_text()) if x['domain'] == '.google.com'}
        return c['__Secure-1PSID'], c['__Secure-1PSIDTS']
    except (OSError, KeyError, ValueError):
        return None


def reread_google_cookies():
    """Open the profile hidden on gemini.google.com so the browser renews its cookies, then save them."""
    with browser() as ctx:
        p = ctx.pages[0] if ctx.pages else ctx.new_page()
        p.goto('https://gemini.google.com/app', wait_until='domcontentloaded')
        p.wait_for_timeout(5000)
        save_cookies(ctx)


ERROR_CARD = re.compile(r"(encounter(ed|ing) an error|something went wrong|please try (your request )?again|can i try something else)", re.I)


def is_error_card(text):
    return len(text) < 300 and bool(ERROR_CARD.search(text))


async def gemini_once(prompt):
    from gemini_webapi import GeminiClient, set_log_level
    set_log_level('ERROR')
    from gemini_webapi.exceptions import AuthError, UsageLimitExceededError, TemporarilyBlockedError
    pair = google_cookies()
    if not pair:
        raise Fail('gemini: no Google cookies saved', SIGNED_OUT)
    os.environ.setdefault('GEMINI_COOKIE_PATH', str(DIR / 'gemini-cookies'))
    client = GeminiClient(*pair)
    try:
        await client.init(timeout=ANSWER_TIMEOUT_S, auto_close=False, auto_refresh=True, impersonate='firefox', verbose=False)
        r = await client.generate_content(prompt, model=GEMINI_MODEL, temporary=True)
        text = (r.text or '').strip()
        if not text:
            raise Fail('gemini: empty answer')
        # A refused or failed turn comes back as an ordinary answer (the library's issue #364).
        if is_error_card(text):
            raise Fail(f'gemini: error answer ({text[:120]})')
        return text
    except AuthError as e:
        raise Fail(f'gemini: signed out ({e})', SIGNED_OUT)
    except (UsageLimitExceededError, TemporarilyBlockedError) as e:
        raise Fail(f'gemini: limit ({e})', LIMIT)
    finally:
        await client.close()


def ask_gemini(prompt):
    try:
        return asyncio.run(gemini_once(prompt))
    except Fail as e:
        if e.code != SIGNED_OUT:
            raise
    reread_google_cookies()
    return asyncio.run(gemini_once(prompt))


# ---------- chatgpt ----------

ASSISTANT = '[data-chatgpt-search-unit-key$=":assistant"]'


def started(p, before, seconds):
    """Has ChatGPT begun answering (a new answer or a Stop button) within `seconds`?"""
    for _ in range(seconds * 2):
        if p.locator(ASSISTANT).count() > before or p.get_by_role('button', name='Stop').count():
            return True
        p.wait_for_timeout(500)
    return False


def ask_chatgpt(prompt):
    with browser() as ctx:
        # Signed out, the page never shows the box: that was a 60 s timeout per call, reported as an error
        # (so never marked out) for 665 calls in a row on 2026-10-24/25.
        if not signed_in(ctx.cookies())['chatgpt']:
            raise Fail('chatgpt: signed out (no session cookie)', SIGNED_OUT)
        p = ctx.pages[0] if ctx.pages else ctx.new_page()
        p.goto('https://chatgpt.com/?temporary-chat=true', wait_until='domcontentloaded')
        box = p.locator('[contenteditable="true"]').first
        try:
            box.wait_for(timeout=60000)
        except Exception:
            if p.get_by_role('button', name='Log in').count() or not signed_in(ctx.cookies())['chatgpt']:
                raise Fail('chatgpt: signed out', SIGNED_OUT)
            raise
        p.wait_for_timeout(1500)
        if p.get_by_role('button', name='Log in').count():
            raise Fail('chatgpt: signed out', SIGNED_OUT)
        before = p.locator(ASSISTANT).count()
        box.click()
        p.keyboard.insert_text(prompt)
        p.wait_for_timeout(2000)  # a long prompt needs a moment before Enter sends it
        p.keyboard.press('Enter')
        # Enter is sometimes lost while the page is still loading: then the Send button, then give up.
        if not started(p, before, 20):
            p.get_by_role('button', name='Send', exact=True).click()
            if not started(p, before, 20):
                raise Fail('chatgpt: the prompt was not sent')
        deadline = time.time() + ANSWER_TIMEOUT_S
        # Written once a new answer exists, the Stop button is gone and the text stayed the same for a poll.
        text, same = '', 0
        while time.time() < deadline:
            p.wait_for_timeout(1500)
            if p.locator(ASSISTANT).count() <= before:
                continue
            now = p.locator(ASSISTANT).last.inner_text().strip()
            if now.startswith('ChatGPT said:'):
                now = now[len('ChatGPT said:'):].strip()
            writing = p.get_by_role('button', name='Stop').count() > 0
            same = same + 1 if (now and now == text and not writing) else 0
            text = now
            if same >= 2:
                break
        else:
            n = p.locator(ASSISTANT).count()
            raise Fail(f'chatgpt: no finished answer within {ANSWER_TIMEOUT_S}s (answers {before}->{n}, '
                       f'writing={p.get_by_role("button", name="Stop").count() > 0}, text={len(text)} chars)')
        low = text.lower()
        if is_error_card(text):
            raise Fail(f'chatgpt: error answer ({text[:120]})')
        if len(text) < 400 and ("you've reached" in low or 'usage limit' in low or 'limit for' in low):
            raise Fail(f'chatgpt: limit ({text[:160]})', LIMIT)
        save_cookies(ctx)
        return text


# ---------- commands ----------

def signin():
    with browser(headless=False) as ctx:
        p = ctx.pages[0] if ctx.pages else ctx.new_page()
        p.goto('https://gemini.google.com/app')
        ctx.new_page().goto('https://chatgpt.com/')
        print('Sign in to Gemini and ChatGPT in the window, then close it.', flush=True)
        cookies = []
        try:
            while ctx.pages:
                ctx.pages[0].wait_for_timeout(2000)
                cookies = save_cookies(ctx)
        except Exception:
            pass
    return cookies


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'ask' and len(argv) > 2 and argv[2] in ('gemini', 'chatgpt'):
        prompt = sys.stdin.buffer.read().decode('utf-8')
        if not prompt.strip():
            print('web-llm: empty prompt', file=sys.stderr)
            return 1
        try:
            text = (ask_gemini if argv[2] == 'gemini' else ask_chatgpt)(prompt)
        except Fail as e:
            print(f'web-llm: {e}', file=sys.stderr)
            return e.code
        except Exception as e:
            print(f'web-llm: {argv[2]}: {type(e).__name__}: {str(e).splitlines()[0] if str(e) else ""}', file=sys.stderr)
            return 1
        sys.stdout.buffer.write(text.encode('utf-8'))
        return 0
    if cmd in ('signin', 'check'):
        if cmd == 'signin':
            cookies = signin()
        else:
            try:
                cookies = json.loads(COOKIES.read_text())
            except (OSError, ValueError):
                cookies = []
        state = signed_in(cookies)
        for site, ok in state.items():
            print(f'{site}: {"signed in" if ok else "NOT signed in"}')
        return 0 if all(state.values()) else SIGNED_OUT
    print(__doc__.strip().split('\n\n')[1], file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
