r"""One-time sign-in, so every later run reuses the session.

The applier drives a dedicated Chrome profile (SeleniumConfig.user_data_dir).
When that profile has no Airbus session, Workday shows Create Account / Sign In
and the wizard is unreachable - the application form is not served to
signed-out visitors at all.

Run this once:

    .venv\Scripts\python.exe tools/login.py

With AIRBUS_EMAIL / AIRBUS_PASSWORD set in .env (gitignored) it signs in on its
own. Without them, a normal Chrome window opens and you sign in by hand; the
script watches for the session, then shuts the browser down cleanly so the
cookies are flushed to the profile directory.

main.py no longer depends on this having been run - it calls the same
ensure_signed_in() itself - but this remains the way to set the profile up
interactively, or to see what the page says when automatic sign-in fails.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

SIGN_IN_PAGES = {
    "Sopra Steria": "https://jobs.smartrecruiters.com/SopraSteria1",
}

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from app.config import SeleniumConfig
from app.driver import build_driver
from app import employers
from app.session import (CAREERS, confirm_session, credentials,
                         ensure_signed_in, looks_signed_in)

WAIT_MINUTES = 15
POLL_SECONDS = 5


def wait_for_manual_sign_in(driver, profile: Path) -> int:
    """Watch the browser until a human has signed in, or time out."""
    print()
    print("=" * 70)
    print("  A Chrome window is open. Sign in to Airbus careers in it,")
    print("  using the 'Sign In' button at the top right.")
    print()
    print("  Let Chrome save the password when it offers - it is stored in")
    print("  this profile, so future runs stay signed in.")
    print(f"  Waiting up to {WAIT_MINUTES} minutes...")
    print("=" * 70)
    print()

    deadline = time.time() + WAIT_MINUTES * 60
    announced = False
    while time.time() < deadline:
        if looks_signed_in(driver):
            if not announced:
                print("Session detected, confirming...")
                announced = True
            if confirm_session(driver):
                print("\nSigned in. Session saved to:")
                print(f"  {profile}")
                print(r"Next:  .venv\Scripts\python.exe main.py --dry-run --limit 1")
                return 0
            announced = False
        remaining = int(deadline - time.time())
        if remaining % 60 < POLL_SECONDS:
            print(f"  ...still waiting ({remaining // 60} min left)")
        time.sleep(POLL_SECONDS)

    print("\nTimed out without seeing a session.")
    print("Re-run when you have a moment to sign in.")
    return 1


def main() -> int:
    cfg = SeleniumConfig()
    profile = cfg.user_data_dir / cfg.profile_name
    print(f"Chrome profile: {profile}")
    if not cfg.user_data_dir.exists():
        print("  (creating it now)")

    email, _ = credentials()
    driver = build_driver(cfg.user_data_dir, cfg.profile_name)
    try:
        # required=False: falling back to a human is the whole point of this
        # script, so a failed automatic attempt is not fatal here.
        if ensure_signed_in(driver, required=False):
            print(f"\nSigned in as {email or 'the saved account'}. Saved to:")
            print(f"  {profile}")
            return 0

        print("Automatic sign-in did not take; finish it in the browser window.")
        driver.get(CAREERS)
        time.sleep(3)
        return wait_for_manual_sign_in(driver, profile)
    finally:
        # Clean shutdown matters: Chrome flushes cookies to disk on quit.
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
