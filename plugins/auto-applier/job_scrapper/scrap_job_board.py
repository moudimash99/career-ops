from typing import Callable, List, Optional
from urllib.parse import urljoin, urlparse
from pathlib import Path
import json

from selenium.webdriver.remote.webdriver import WebDriver
from selenium.webdriver.remote.webelement import WebElement
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, ElementClickInterceptedException
# ---- Config ----
DEFAULT_URL = (
    "https://ag.wd3.myworkdayjobs.com/en-US/Airbus/jobs"
    "?locationCountry=54c5b6971ffb4bf0b116fe7651ec789a"
    "&workerSubType=f5811cef9cb50193723ed01d470a6e15"
)
BASE = "https://ag.wd3.myworkdayjobs.com"


# -------------------------------
# Locators
# -------------------------------

RESULTS_SECTION = (By.CSS_SELECTOR, "section[data-automation-id='jobResults']")
JOB_ANCHORS     = (By.CSS_SELECTOR, "a[data-automation-id='jobTitle']")

NEXT_LOCATORS = [
    # Primary Workday control
    (By.CSS_SELECTOR, "button[data-uxi-widget-type='stepToNextButton']"),
    # ARIA label fallback
    (By.CSS_SELECTOR, "button[aria-label='next']"),
    # Your provided SVG → climb to button
    (By.XPATH, "(//*[name()='svg'][contains(@class,'wd-icon-chevron-right-small')]/ancestor::button)[1]"),
]


# -------------------------------
# Waiting / finding primitives
# -------------------------------

def wait_for_results_section(driver: WebDriver, timeout: int = 15) -> WebElement:
    """Wait until the results section is present and return it."""
    return WebDriverWait(driver, timeout).until(
        EC.presence_of_element_located(RESULTS_SECTION)
    )

def wait_for_job_anchors(driver: WebDriver, timeout: int = 15) -> List[WebElement]:
    """Wait until at least one job anchor is present and return all anchors."""
    WebDriverWait(driver, timeout).until(
        EC.presence_of_element_located(JOB_ANCHORS)
    )
    return driver.find_elements(*JOB_ANCHORS)

def get_first_anchor_href(driver: WebDriver) -> Optional[str]:
    """Return the first job anchor href or None if not present."""
    anchors = driver.find_elements(*JOB_ANCHORS)
    if not anchors:
        return None
    return anchors[0].get_attribute("href") or None

def find_next_button(driver: WebDriver) -> Optional[WebElement]:
    """Try several locators to find a visible, enabled Next button."""
    for by, sel in NEXT_LOCATORS:
        try:
            btn = WebDriverWait(driver, 3).until(
                EC.presence_of_element_located((by, sel))
            )
        except TimeoutException:
            continue
        if btn.is_displayed() and btn.is_enabled():
            return btn
    return None


# -------------------------------
# Href normalization / filtering
# -------------------------------

def normalize_url(href: str, base_url: str) -> str:
    """Make an absolute URL from possibly relative href."""
    return urljoin(base_url, href)

def is_valid_job_href(href: str, base_url: str) -> bool:
    """
    Accept: same-host absolute URLs whose path contains '/job/'.
    Reject: empty, fragments, javascript:, mailto:, cross-host.
    """
    if not href or href.startswith(("#", "javascript:", "mailto:")):
        return False
    absu = urljoin(base_url, href)
    u_abs = urlparse(absu)
    u_base = urlparse(base_url)
    if not (u_abs.scheme and u_abs.netloc and u_abs.path):
        return False
    if u_abs.netloc != u_base.netloc:
        return False
    return "/job/" in u_abs.path


# -------------------------------
# Page actions
# -------------------------------

def collect_links_on_current_page(
    driver: WebDriver,
    href_filter: Callable[[str, str], bool] = is_valid_job_href
) -> List[str]:
    """Grab absolute, filtered job URLs from the current results page."""
    wait_for_results_section(driver)
    anchors = wait_for_job_anchors(driver)
    base = driver.current_url
    urls: List[str] = []
    for a in anchors:
        href = a.get_attribute("href") or ""
        if href_filter(href, base):
            urls.append(normalize_url(href, base))
    return urls

def js_click(driver: WebDriver, el: WebElement) -> None:
    """Click via JS (more reliable on complex UIs)."""
    driver.execute_script("arguments[0].click();", el)

def go_to_next_page(driver: WebDriver, timeout: int = 12) -> bool:
    """
    Click Next and wait for the job list to change.
    Returns True if navigation likely happened, else False.
    """
    btn = find_next_button(driver)
    if not btn:
        return False

    # Sentinel: first job href before clicking
    before_first = get_first_anchor_href(driver)

    # Click Next (JS preferred; fall back to normal click)
    try:
        js_click(driver, btn)
    except Exception:
        try:
            btn.click()
        except ElementClickInterceptedException:
            js_click(driver, btn)

    # Wait for the first-anchor href to change or anchors to refresh
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: (first := get_first_anchor_href(d)) is not None and first != before_first  # noqa: E731
        )
        return True
    except TimeoutException:
        # As a fallback, just ensure job anchors are present; if still same, treat as no-nav
        try:
            anchors = wait_for_job_anchors(driver, timeout=3)
            if anchors and (anchors[0].get_attribute("href") or None) != before_first:
                return True
        except TimeoutException:
            pass
        return False

from urllib.parse import urlparse, urlunparse

def _norm(u: str) -> str:
    if not u:
        return ""
    p = urlparse(u)
    # drop query + fragment; trim trailing slash
    s = urlunparse(p._replace(query="", fragment=""))
    return s[:-1] if s.endswith("/") else s

def _load_seen_from_successes(suc_dir: Path) -> set:
    """
    Build a set of normalized URLs that we have already saved in successes/*.json.
    First-run safe: returns empty set if nothing exists yet.
    """
    seen = set()
    if not suc_dir.exists():
        return seen
    for p in suc_dir.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            for item in data:
                u = _norm(item.get("url", ""))
                if u:
                    seen.add(u)
        except Exception:
            # ignore malformed files
            continue
    return seen

# -------------------------------
# Orchestration
# -------------------------------

def collect_all_job_links(
    driver: WebDriver,
    max_pages: Optional[int] = None,
    href_filter: Callable[[str, str], bool] = is_valid_job_href,
    seen: Optional[set] = None,
) -> List[str]:
    """
    From page 1, collect job links on each page and paginate with Next until
    the last page (or until max_pages reached). Duplicates are removed.
    """
    out =  []
    page_count = 0
    # avoid mutable default arg
    if seen is None:
        seen = set()

    driver.get(DEFAULT_URL)
    import time;time.sleep(1)
    while True:
        # add a sleep of 0.5s to allow page to stabilize
        time.sleep(0.5)
        # Collect current page
        urls = collect_links_on_current_page(driver, href_filter=href_filter)
        if len(urls) != 20:
            import logging
            logging.warning(f"Expected 20 job links on page {page_count+1}, got {len(urls)}")
        for url in urls:
            norm_url = _norm(url)
            if norm_url not in seen:
                seen.add(url)
                out.append(url)

        page_count += 1
        if max_pages is not None and page_count >= max_pages:
            break

        # Move to next; stop if not possible
        if not go_to_next_page(driver):
            break

    return out

def _load_links_from_misses(mis_dir: Path) -> List[str]:
    """
    Load all job links from misses/*.json files.
    """
    links: List[str] = []
    if not mis_dir.exists():
        return links
    for p in mis_dir.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            for item in data:
                u = item.get("url", "")
                if u:
                    links.append(u)
        except Exception:
            # ignore malformed files
            continue
    return links

# -------------------------------
# Optional: stricter filter examples
# -------------------------------

def only_airbus_en_us(href: str, base: str) -> bool:
    absu = urljoin(base, href)
    return urlparse(absu).path.startswith("/en-US/Airbus/job/")


# -------------------------------
# Example usage (driver already on page 1)
# -------------------------------

# links = collect_all_job_links(driver)                      # all pages
# links = collect_all_job_links(driver, href_filter=only_airbus_en_us)
# print(f"Collected {len(links)} job links")

from app.config import SeleniumConfig, CandidateData
from app.driver import build_driver
# ---- Optional: quick example of how you'd call it when a driver is ready ----
def main_get_links():
    CFG = SeleniumConfig()
    ME  = CandidateData()

    driver = build_driver(CFG.user_data_dir, CFG.profile_name)
    links = collect_all_job_links(driver, max_pages=3)         # first 3 pages

    # This block expects you already created `driver` elsewhere and imported it here.
    # Example (uncomment and adapt if you want a standalone run):
    #
    # from selenium import webdriver
    # driver = webdriver.Chrome()
    #
    # try:
    #     path = scrape_airbus_jobs(driver, max_pages=3)
    #     print(f"Scraped {len(path)} job links")
    # except Exception as e:
    #     import traceback; traceback.print_exc()
    #     print(f"Error: {e}")
    # finally:
    #     driver.quit()
