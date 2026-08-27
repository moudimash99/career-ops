"""Keep one browser open across several steps instead of relaunching it.

Driving a wizard one careful step at a time means several separate runs, and
each `build_driver` started a fresh Chrome, signed in again, and threw away the
page the previous step had reached - which is the very thing being examined.

Reattaching needs one thing that is easy to miss: ChromeDriver launched by
Selenium is a child of the Python process and dies with it, so the saved
session is already gone by the time the next step runs (MaxRetryError). So this
starts chromedriver *detached*, on a fixed port, and talks to it over the wire.
It outlives every step until `shutdown()`.

    driver, reused = attach_or_start(emp.profile_dir, emp.profile_name)
    ...                       # do one step, read the page, do NOT quit
    python -m app.live        # when finished, close it

The browser stays open on purpose. Nothing here calls quit() except shutdown().
"""
from __future__ import annotations

import json
import socket
import subprocess
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.selenium_manager import SeleniumManager
from selenium.webdriver.remote.file_detector import UselessFileDetector

from app.driver import chrome_options, clean_stale_locks

STATE = Path(__file__).resolve().parent.parent / "output" / "live_session.json"
PORT = 9515
SERVER = f"http://127.0.0.1:{PORT}"


def _listening(port: int = PORT) -> bool:
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _chromedriver_path() -> str:
    return SeleniumManager().binary_paths(["--browser", "chrome"])["driver_path"]


def _start_server() -> None:
    """Launch chromedriver so it survives this process exiting."""
    if _listening():
        return
    # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: without these it is still a
    # child and Windows tears it down with the parent, which is the whole bug
    # this module exists to avoid.
    flags = 0x00000008 | 0x00000200
    subprocess.Popen(
        [_chromedriver_path(), f"--port={PORT}"],
        creationflags=flags, close_fds=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if _listening():
            print(f"[live] chromedriver listening on {SERVER}")
            return
        time.sleep(0.3)
    raise RuntimeError(f"chromedriver did not come up on {SERVER}")


def _local_files(driver):
    """Send file paths straight through instead of uploading them.

    A webdriver.Remote session treats send_keys on a file input as an upload to
    a remote node and calls se/file, which standalone chromedriver does not
    serve - "unknown command: session/.../se/file". ChromeDriver is on this
    machine and can read the path itself, so the detector is turned off.
    """
    driver.file_detector = UselessFileDetector()
    return driver


def _attach(session_id: str):
    """Reconnect to an already-running session on the standalone server.

    webdriver.Remote opens a new session in its constructor, so start_session
    is neutered for that one call and put straight back.
    """
    original = webdriver.Remote.start_session

    def _noop(self, *args, **kwargs):
        return None

    webdriver.Remote.start_session = _noop
    try:
        driver = webdriver.Remote(command_executor=SERVER,
                                  options=webdriver.ChromeOptions())
    finally:
        webdriver.Remote.start_session = original
    driver.session_id = session_id
    return driver


def attach_or_start(user_data_dir, profile_name) -> tuple[object, bool]:
    """Reuse the open browser if there is one. Returns (driver, reused)."""
    if STATE.exists() and _listening():
        try:
            info = json.loads(STATE.read_text(encoding="utf-8"))
            driver = _attach(info["session_id"])
            # Probe it: a dead session fails here rather than three steps later
            # on something that looks like a page problem.
            here = driver.current_url
            driver.implicitly_wait(0.5)
            print(f"[live] reusing the open browser at {here[:80]}")
            return _local_files(driver), True
        except Exception as e:
            print(f"[live] could not reattach ({type(e).__name__}); "
                  "starting a fresh session")
            forget()

    _start_server()
    clean_stale_locks(Path(user_data_dir), profile_name)
    driver = webdriver.Remote(
        command_executor=SERVER,
        options=chrome_options(Path(user_data_dir), profile_name))
    driver.implicitly_wait(0.5)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({"session_id": driver.session_id,
                                 "server": SERVER}, indent=1), encoding="utf-8")
    print("[live] started a browser and saved its session")
    return _local_files(driver), False


def forget() -> None:
    """Drop the saved handle without touching the browser."""
    try:
        STATE.unlink()
    except FileNotFoundError:
        pass


def shutdown() -> None:
    """Close the browser this module has been keeping open."""
    if not (STATE.exists() and _listening()):
        print("[live] nothing open")
        forget()
        return
    try:
        info = json.loads(STATE.read_text(encoding="utf-8"))
        _attach(info["session_id"]).quit()
        print("[live] browser closed")
    except Exception as e:
        print(f"[live] could not close it ({type(e).__name__}); "
              "it may already be gone")
    finally:
        forget()


if __name__ == "__main__":
    shutdown()
