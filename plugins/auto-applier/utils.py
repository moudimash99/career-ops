import threading
import time

class HumanResumeTimeoutError(Exception):
    """Raised when no human input is received before timeout."""
    pass
#allow boolean to raise an error or not if not pressed in time
def pause_for_human_resume(timeout=300, raise_on_timeout=True):
    """
    Pause execution until the user presses Enter or the timeout elapses.
    If the timeout elapses with no input, raise HumanResumeTimeoutError.

    Messages here are plain ASCII on purpose: this runs on a cp1252 console,
    where printing emoji raises UnicodeEncodeError. That fired *inside* the
    handler for another failure and masked the real error entirely.
    """
    resume_event = threading.Event()

    def wait_for_input():
        input("[paused] press [Enter] to resume early...\n")
        resume_event.set()

    # Start a background thread waiting for user input
    threading.Thread(target=wait_for_input, daemon=True).start()
    print(f"(Auto-cancel in {timeout//60} min if no input)\n")

    if not resume_event.wait(timeout) and raise_on_timeout:
        # Timed out without human action
        raise HumanResumeTimeoutError(
            f"No input received after {timeout} seconds; aborting."
        )

    print("[resuming] script continuing...")
