"""Read-only client for the public SmartRecruiters postings API.

Sopra Steria's board (careers.soprasteria.com) is a front end over
SmartRecruiters, whose posting search is public and needs no key. As with
job_scrapper/workday_api.py for Airbus and Accenture, listings come from the
API and Selenium is only needed to actually apply.

The shape deliberately mirrors workday_api.JobPosting so app/relevance.py and
the shortlist tooling work against either board without caring which.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator, Optional

API = "https://api.smartrecruiters.com/v1/companies"
APPLY = "https://jobs.smartrecruiters.com"

# The posting page links out to SmartRecruiters' "OneClick" application app,
# keyed by the posting's `uuid` (not its id, and not its jobAdId - checked
# against the live API on 2026-08-21). Building the url from the API saves
# loading the posting page just to read the link off it.
ONECLICK = APPLY + "/oneclick-ui/company/{company}/publication/{uuid}"

# The API rejects limit > 100.
PAGE_SIZE = 100

HEADERS = {"Accept": "application/json", "User-Agent": "Mozilla/5.0"}


class SmartRecruitersError(RuntimeError):
    pass


def _request(url: str, retries: int = 3, pause_s: float = 1.0) -> dict:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            # Transient by default: the board is behind a CDN that occasionally
            # 502s, and giving up on the first one loses the whole scan.
            time.sleep(pause_s * (attempt + 1))
    raise SmartRecruitersError(f"{url} failed after {retries} tries: {last}")


@dataclass(frozen=True)
class JobPosting:
    """One posting. Field names match workday_api.JobPosting on purpose."""
    title: str
    url: str
    external_path: str
    location: str
    posted_on: str          # kept as Workday-style wording, see _posted_wording
    req_id: str
    experience_level: str = ""
    employment_type: str = ""
    # Where a human actually applies. Note this app does not render reliably
    # under ChromeDriver while the public listing always does, so this is a
    # link to open, not a form to drive - see tools/assist_apply.py.
    apply_url: str = ""

    @classmethod
    def from_api(cls, raw: dict, company: str) -> "JobPosting":
        loc = raw.get("location") or {}
        job_id = str(raw.get("id", ""))
        return cls(
            title=raw.get("name", ""),
            url=f"{APPLY}/{company}/{job_id}",
            external_path=f"/{company}/{job_id}",
            location=loc.get("fullLocation") or loc.get("city", ""),
            posted_on=_posted_wording(raw.get("releasedDate", "")),
            req_id=raw.get("refNumber", "") or job_id,
            experience_level=((raw.get("experienceLevel") or {}).get("label", "")),
            employment_type=((raw.get("typeOfEmployment") or {}).get("label", "")),
            apply_url=(ONECLICK.format(company=company, uuid=raw["uuid"])
                       + f"?dcr_ci={company}") if raw.get("uuid") else "",
        )


def _posted_wording(iso: str) -> str:
    """Render an ISO timestamp the way Workday words it.

    app/relevance.days_since_posted already parses "Posted 9 Days Ago", and one
    parser that both boards feed is better than two that drift apart.
    """
    if not iso:
        return ""
    try:
        when = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return ""
    days = (datetime.now(timezone.utc) - when).days
    if days <= 0:
        return "Posted Today"
    if days == 1:
        return "Posted Yesterday"
    return f"Posted {days} Days Ago"


def iter_postings(company: str = "SopraSteria1",
                  country: Optional[str] = "fr",
                  search_text: str = "",
                  max_jobs: Optional[int] = None,
                  pause_s: float = 0.2) -> Iterator[JobPosting]:
    """Walk every matching posting, page by page."""
    offset, yielded, total = 0, 0, None
    while True:
        params = {"limit": PAGE_SIZE, "offset": offset}
        if country:
            params["country"] = country
        if search_text:
            params["q"] = search_text
        url = f"{API}/{company}/postings?{urllib.parse.urlencode(params)}"
        data = _request(url)

        if total is None:
            total = int(data.get("totalFound", 0))
        rows = data.get("content") or []
        if not rows:
            return

        for raw in rows:
            yield JobPosting.from_api(raw, company)
            yielded += 1
            if max_jobs is not None and yielded >= max_jobs:
                return

        offset += len(rows)
        if offset >= total:
            return
        time.sleep(pause_s)


def count_postings(company: str = "SopraSteria1",
                   country: Optional[str] = "fr") -> int:
    params = {"limit": 1}
    if country:
        params["country"] = country
    url = f"{API}/{company}/postings?{urllib.parse.urlencode(params)}"
    return int(_request(url).get("totalFound", 0))
