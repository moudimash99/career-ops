"""Read-only client for Capgemini's careers board.

careers.capgemini.com is an SAP SuccessFactors "Career Site Builder" site.
There is no public JSON API behind it the way Workday and SmartRecruiters have
one, but /search/ renders its results server-side as an ordinary table, so a
plain GET is enough - no browser, same as job_scrapper/workday_api.py and
app/smartrecruiters.py.

The shape mirrors workday_api.JobPosting field-for-field so app/relevance.py
and the shortlist tooling do not care which board a posting came from.

Two things about the search endpoint, read off the live board on 2026-08-22:

- `locationsearch=` and `optionsFacetsDD_location=` both return **zero rows**
  for "Toulouse". The facet wants the site's own value, not the city name, and
  a wrong one is not an error - it is an empty result set that looks exactly
  like "nothing is open". Locations are therefore filtered here, on the parsed
  `location` column, never by asking the server.
- Paging is `startrow=`, 25 rows a page, with the total in "Results 1 to 25 of
  356". No cursor, no token.
- **`locale=fr_FR` is not cosmetic.** Without it the board answers from the
  en_US index, where "devops in France" is six Lyon postings and Toulouse has
  none - while the same search with the locale returns a full page of Toulouse
  and Blagnac roles. A missing locale does not look like a bug, it looks like
  an empty job market, so it is a default here rather than an option.
"""
from __future__ import annotations

import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Iterable, Iterator, Optional

from bs4 import BeautifulSoup

BOARD = "https://careers.capgemini.com"
SEARCH = BOARD + "/search/"

# The table renders 25 rows a page and ignores a larger request.
PAGE_SIZE = 25

# The French postings are only in the fr_FR index. See the header.
LOCALE = "fr_FR"

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/128.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
}

# "Results 1 to 25 of 356" in en_US, "Résultats 1 à 25 sur 991" in fr_FR. Both,
# because fr_FR is the default locale here: matching only the English wording
# meant total_results returned None on every real scan, iter_postings had
# nothing to stop on but its page cap, and a broad search quietly returned the
# first max_pages*25 postings as if that were all of them.
# The range separator is a word in en_US ("1 to 25") and an en dash in fr_FR
# ("1 – 25"), which is not the "à" the rest of the page would lead you to
# expect - so both spellings and every dash.
_TOTAL = re.compile(
    r"(?:Results|Résultats)\s+[\d\s]+(?:to|à|[-–—])\s*[\d\s]+(?:of|sur)"
    r"\s+([\d\s,]+)",
    re.I)
# "/job/Toulouse-Tech-lead-Devops/1251076601/" - the trailing number is the
# requisition id and the only stable part of the url.
_REQ_ID = re.compile(r"/job/[^/]+/(\d+)/?")


class CapgeminiBoardError(RuntimeError):
    pass


def _get(url: str, retries: int = 3, pause_s: float = 1.0) -> str:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(pause_s * (attempt + 1))
    raise CapgeminiBoardError(f"{url} failed after {retries} tries: {last}")


@dataclass(frozen=True)
class JobPosting:
    """One row of the search table. Field names match workday_api.JobPosting."""
    title: str
    url: str
    external_path: str
    location: str
    posted_on: str          # Workday-style wording, see _posted_wording
    req_id: str
    posted_date: str = ""   # as the board prints it, e.g. "Aug 7, 2026"


def _text(node) -> str:
    return " ".join(node.get_text(" ", strip=True).split()) if node else ""


# The board prints its date in the locale it answered in, and strptime's %b is
# tied to the process locale (C, on this machine), so "7 août 2026" would parse
# as nothing at all. Mapped by hand rather than by setlocale, which is global
# process state and would change every other date in the run.
_FR_MONTHS = {
    "janv": 1, "févr": 2, "mars": 3, "avr": 4, "mai": 5, "juin": 6,
    "juil": 7, "août": 8, "sept": 9, "oct": 10, "nov": 11, "déc": 12,
}
_FR_DATE = re.compile(r"(\d{1,2})\s+([^\s.]+)\.?\s+(\d{4})")


def parse_posted(printed: str) -> Optional["date"]:
    """The board's own date string as a date, in either locale."""
    from datetime import date, datetime
    printed = (printed or "").strip()
    if not printed:
        return None
    for fmt in ("%b %d, %Y", "%d %b %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(printed, fmt).date()
        except ValueError:
            continue
    m = _FR_DATE.search(printed)
    if m:
        month = _FR_MONTHS.get(m.group(2).casefold()[:5].rstrip("."))
        if month is None:
            month = _FR_MONTHS.get(m.group(2).casefold()[:4])
        if month:
            try:
                return date(int(m.group(3)), month, int(m.group(1)))
            except ValueError:
                return None
    return None


def _posted_wording(printed: str) -> str:
    """Render the board's date the way Workday words it.

    app/relevance.days_since_posted already parses "Posted 9 Days Ago", and one
    parser fed by every board beats three that drift apart.
    """
    from datetime import date
    when = parse_posted(printed)
    if when is None:
        return ""
    days = (date.today() - when).days
    if days <= 0:
        return "Posted Today"
    if days == 1:
        return "Posted Yesterday"
    return f"Posted {days} Days Ago"


def parse_results(html: str) -> list[JobPosting]:
    """Every posting on one search page, in the order the board lists them."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[JobPosting] = []
    seen: set[str] = set()
    for row in soup.select("tr.data-row"):
        link = row.select_one("a.jobTitle-link[href]")
        if not link:
            continue
        path = link["href"]
        # Each row prints its title twice, once for phone and once for desktop.
        if path in seen:
            continue
        seen.add(path)
        printed_date = _text(row.select_one("td.colDate .jobDate")
                             or row.select_one(".jobDate"))
        req = _REQ_ID.search(path)
        out.append(JobPosting(
            title=_text(link),
            url=urllib.parse.urljoin(BOARD, path),
            external_path=path,
            location=_text(row.select_one("td.colLocation .jobLocation")
                           or row.select_one(".jobLocation")),
            posted_on=_posted_wording(printed_date),
            req_id=req.group(1) if req else "",
            posted_date=printed_date,
        ))
    return out


def total_results(html: str) -> Optional[int]:
    m = _TOTAL.search(BeautifulSoup(html, "html.parser").get_text(" "))
    if not m:
        return None
    # The French page separates thousands with a non-breaking space.
    return int(re.sub(r"[^0-9]", "", m.group(1)))


# A safety valve, not a limit anyone should hit: the fr_FR index is ~1000
# postings, so 60 pages covers it with room to spare. It used to be 20, which
# silently cut every broad scan off at 500.
MAX_PAGES = 60


def iter_postings(query: str = "",
                  max_jobs: Optional[int] = None,
                  max_pages: int = MAX_PAGES,
                  pause_s: float = 0.3,
                  locale: str = LOCALE) -> Iterator[JobPosting]:
    """Walk the search results for one query, page by page."""
    yielded, start, total = 0, 0, None
    for _ in range(max_pages):
        params = {"q": query, "startrow": start, "locale": locale}
        html = _get(SEARCH + "?" + urllib.parse.urlencode(params))
        if total is None:
            total = total_results(html)
        rows = parse_results(html)
        if not rows:
            return
        for row in rows:
            yield row
            yielded += 1
            if max_jobs is not None and yielded >= max_jobs:
                return
        start += PAGE_SIZE
        if total is not None and start >= total:
            return
        time.sleep(pause_s)


def fetch_description(url: str) -> str:
    """One posting's text, as plain text. No browser.

    career-ops captured these through Playwright against a signed-in session
    (scripts/capture-capgemini-jds.mjs); it does not need to be. The posting
    page is public and server-rendered, and the description sits in a single
    `.jobdescription` container - confirmed on 2026-08-22.

    Returns "" rather than raising when the container is missing: a posting
    that has closed since it was listed should not end a batch.
    """
    soup = BeautifulSoup(_get(url), "html.parser")
    body = soup.select_one(".jobdescription") or soup.select_one(".job")
    if body is None:
        return ""
    # Keep the paragraph breaks: these descriptions are a list of missions,
    # and a single run-on line is materially harder to write a letter from.
    text = body.get_text("\n", strip=True)
    return re.sub(r"\n{3,}", "\n\n", text)


def search(queries: Iterable[str],
           locations: Iterable[str] = (),
           max_per_query: Optional[int] = 200,
           locale: str = LOCALE,
           max_pages: int = MAX_PAGES) -> list[JobPosting]:
    """Postings for several queries, de-duplicated, optionally near a city.

    `locations` is matched case-insensitively as a substring of the board's own
    location column ("Toulouse, FR"), because the server-side location filter
    silently returns nothing - see this module's header.
    """
    wanted = tuple(l.casefold() for l in locations)
    found: dict[str, JobPosting] = {}
    for q in queries:
        for job in iter_postings(q, max_jobs=max_per_query, locale=locale,
                                 max_pages=max_pages):
            if wanted and not any(w in job.location.casefold() for w in wanted):
                continue
            found.setdefault(job.url, job)
    return list(found.values())
