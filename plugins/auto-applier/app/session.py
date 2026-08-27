"""Keeping the Chrome profile signed in to Airbus careers.

Workday sessions expire, and none of the wizard is reachable without one: the
site quietly serves "Create Account / Sign In" in place of the application
form. That page looks perfectly ordinary to a locator that is not looking for
it, so a run that starts signed out does not fail where the session died - it
fails several steps later on a missing field, with a bare TimeoutException and
no hint as to why. Observed live on 2026-08-19.

So every run confirms the session up front instead of discovering the wall
halfway through a form.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from selenium.webdriver.common.by import By

import app.path as loc
from app.ux import UX

REPO = Path(__file__).resolve().parent.parent

CAREERS = "https://ag.wd3.myworkdayjobs.com/en-US/Airbus"
CANDIDATE_HOME = "https://ag.wd3.myworkdayjobs.com/en-US/Airbus/candidateHome"
LOGIN = "https://ag.wd3.myworkdayjobs.com/en-US/Airbus/login"

# Workday's SPA draws these well after the document is ready.
RENDER_WAIT_S = 4


class NotSignedInError(RuntimeError):
    """Workday wants an account before it will show the application form."""


def credentials(prefix: str = "AIRBUS") -> tuple[str, str]:
    """Read <PREFIX>_EMAIL / <PREFIX>_PASSWORD from the environment or .env.

    Keyed by prefix so one .env can hold an account per employer: Airbus and
    Accenture are separate Workday tenants and separate logins, and reusing one
    variable for both would sign into whichever was configured last.

    .env is gitignored. Returns ("", "") when not configured, leaving the
    caller to sign in by hand.
    """
    try:
        from dotenv import load_dotenv
        load_dotenv(REPO / ".env")
    except ImportError:
        pass
    return (os.getenv(f"{prefix}_EMAIL", ""),
            os.getenv(f"{prefix}_PASSWORD", ""))


# The utility bar offers exactly one of these. Note accountSettingsButton is
# the element's *id* - its data-automation-id is the generic utilityMenuButton,
# shared with the language and settings menus, so it cannot be matched on that.
# Getting this wrong reads as "signed out" on a perfectly good session.
SIGNED_OUT_MARKER = "//button[@data-automation-id='utilityButtonSignIn']"
SIGNED_IN_MARKERS = (
    "//button[@id='accountSettingsButton']"
    " | //button[@data-automation-id='utilityButtonAccount']"
    " | //*[@data-automation-id='candidateHome']"
    " | //button[normalize-space()='Sign Out']"
)


def looks_signed_in(driver, wait_s: float = 0) -> bool:
    """Signed in when the utility bar shows an account rather than Sign In.

    Checked without navigating, so it does not interrupt a sign-in in progress.
    The bar is drawn before the page body finishes loading, but not instantly -
    hence wait_s, which polls for whichever marker turns up first. Deciding too
    early sees neither and wrongly reports signed out.
    """
    deadline = time.time() + wait_s
    while True:
        try:
            if driver.find_elements(By.XPATH, SIGNED_OUT_MARKER):
                return False
            if driver.find_elements(By.XPATH, SIGNED_IN_MARKERS):
                return True
        except Exception:
            pass
        if time.time() >= deadline:
            return False
        time.sleep(0.5)


def signed_in_as(driver) -> str:
    """The email Workday shows in the utility bar, or "".

    Needed because a stored session is reused as-is: without checking who it
    belongs to, switching AIRBUS_EMAIL would silently keep the old account and
    file the application under the wrong candidate.
    """
    for el in driver.find_elements(By.XPATH, "//button[@id='accountSettingsButton']"):
        text = " ".join((el.text or "").split())
        if "@" in text:
            return text.strip().casefold()
    return ""


def sign_out(driver) -> None:
    """Drop the current session so a different account can sign in.

    Clearing cookies is more dependable than hunting for a Sign Out control,
    which lives behind an account menu that renders late. No navigation here -
    the caller already knows which page it wants to be on.
    """
    try:
        driver.delete_all_cookies()
    except Exception:
        pass


def at_sign_in_wall(driver) -> bool:
    """Whether the page currently shown is the account wall rather than a form."""
    try:
        return bool(driver.find_elements(By.XPATH, loc.create_account_form)
                    or driver.find_elements(By.XPATH, loc.login_submit))
    except Exception:
        return False


def dismiss_cookie_banner(driver, wait_s: float = 8) -> bool:
    """Clear the consent banner, waiting for it in case it renders late.

    Worth doing properly: the banner is drawn a second or two after the form,
    so a single immediate check misses it, and it then sits over the page while
    the sign-in submit is clicked. That is not a click proxy, so UX.click
    correctly declines to click it and falls back to a synthetic click - which
    the aria-hidden submit button ignores. The result is a sign-in that fills
    in perfectly and then silently does nothing, on some runs but not others.
    """
    ux = UX(driver, timeout=5, micro_wait=0.3)
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if ux.visible(loc.cookie_accept):
            try:
                ux.click(loc.cookie_accept)
            except Exception:
                pass
            # Confirm it actually went away rather than assuming.
            gone = time.time() + 5
            while time.time() < gone:
                if not ux.visible(loc.cookie_accept):
                    print("[session] cookie banner dismissed")
                    return True
                time.sleep(0.3)
            return False
        time.sleep(0.4)
    return False


def sign_in(driver, email: str, password: str,
            login_url: str = LOGIN) -> bool:
    """Fill and submit the sign-in form. Returns whether it was attempted.

    The submit button is aria-hidden behind a click_filter overlay, so this
    goes through UX.click, which clicks the overlay that actually carries the
    handler. A plain click on the button is silently ignored.
    """
    ux = UX(driver, timeout=20, micro_wait=0.4)
    driver.get(login_url)
    time.sleep(RENDER_WAIT_S)

    dismiss_cookie_banner(driver)

    # Accenture's tenant shows social sign-in first and only reveals the email
    # form after this button; Airbus shows the form immediately. Read off the
    # live Accenture login page on 2026-08-21, where the run reported "not
    # signed in" having never found a field to type into.
    if not ux.exists(loc.login_email) and ux.visible(loc.sign_in_with_email):
        print("[session] opening the email sign-in form")
        try:
            ux.click(loc.sign_in_with_email)
            time.sleep(2)
        except Exception:
            pass

    if not ux.exists(loc.login_email):
        return False

    ux.type(loc.login_email, email)
    # secret=True keeps the password out of any error message.
    ux.type(loc.login_password, password, secret=True)

    # The form also carries a honeypot input (loc.honeypot_field) that Workday
    # uses to spot bots filling everything in. Only the two fields above are
    # ever written to.
    for attempt in (1, 2):
        # The banner can still turn up between filling and submitting.
        dismiss_cookie_banner(driver, wait_s=1)
        ux.click(loc.login_submit)
        for _ in range(10):
            time.sleep(1.5)
            if "/login" not in driver.current_url:
                return True
        if attempt == 1:
            print("[session] submit did not take; clearing overlays and retrying")
    return True


def confirm_session(driver, url: str | None = None) -> bool:
    """Check the session on `url` - by default wherever we already are.

    Deliberately NOT candidateHome. That page is broken on at least one real
    account: it renders a permanent spinner and a red "1 Error" and never
    lists anything, so bouncing through it to prove a session costs ten seconds
    and can report a false negative. The utility bar on any page carries the
    same signal.
    """
    try:
        if url:
            driver.get(url)
            time.sleep(RENDER_WAIT_S)
        if "login" in driver.current_url.lower():
            return False
        return looks_signed_in(driver, wait_s=12)
    except Exception:
        return False


def ensure_signed_in(driver, *, required: bool = True,
                     verify_url: str | None = None,
                     employer=None) -> bool:
    """Guarantee the profile has a live Airbus session before the run starts.

    Reuses an existing session when there is one, signs in with the configured
    credentials when there is not. Returns whether we ended up signed in;
    raises NotSignedInError instead when `required` and it could not be done.
    """
    # Defaults keep every existing Airbus caller working unchanged.
    prefix = getattr(employer, "env_prefix", "AIRBUS")
    careers = getattr(employer, "careers_url", CAREERS)
    login_url = getattr(employer, "login_url", LOGIN)
    who = getattr(employer, "name", "Airbus")
    email, password = credentials(prefix)

    if confirm_session(driver, verify_url or careers):
        current = signed_in_as(driver)
        if email and current and current != email.casefold():
            print(f"[session] signed in as {current}, but {email} is "
                  "configured - switching accounts")
            sign_out(driver)
        else:
            print(f"[session] existing session reused"
                  + (f" ({current})" if current else ""))
            return True
    if not (email and password):
        if required:
            raise NotSignedInError(rf"""Not signed in to {who}, and no {prefix}_EMAIL / {prefix}_PASSWORD is set.

Sign in by hand once - the session then persists in this employer's own
Chrome profile, and every later run reuses it:

    .venv\Scripts\python.exe tools/login.py --employer "{who}"

or put {prefix}_EMAIL / {prefix}_PASSWORD in .env (gitignored).""")
        return False

    print(f"[session] signing in as {email}...")
    try:
        sign_in(driver, email, password, login_url)
    except Exception as e:
        if required:
            raise NotSignedInError(
                f"Automatic sign-in failed ({type(e).__name__}: {e})."
            ) from e
        return False

    if confirm_session(driver, verify_url):
        print("[session] signed in")
        return True

    if required:
        raise NotSignedInError(
            "Signed-in state could not be confirmed after submitting the "
            "form. Run tools/login.py to sign in by hand and see what the "
            "page says."
        )
    return False
