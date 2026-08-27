"""
Read-only client for the public Workday CXS API behind the Airbus job board.

The board at https://ag.wd3.myworkdayjobs.com/en-US/Airbus is a React front end
over a JSON API. Talking to that API directly gives us listings *and* full job
descriptions with no browser at all, which is both much faster and far less
brittle than paginating the DOM with Selenium.

Selenium is still required for actually applying — that needs a logged-in
session and a real form to drive.

Facet ids below were read from the live `facets` block of a /jobs response.
Workday does change them occasionally; run `python -m job_scrapper.workday_api`
to re-dump the current taxonomy if a filter ever starts returning nothing.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterator, Optional, Sequence

from bs4 import BeautifulSoup

@dataclass(frozen=True)
class Tenant:
    """One employer's Workday board.

    Every Workday careers site is the same API behind a different three-part
    address - host, tenant, site - so an employer is data, not a code path.
    Accenture runs on Workday too (accenture.wd103.myworkdayjobs.com), which is
    why this was pulled out of the module constants it used to be.
    """
    name: str
    host: str
    tenant: str
    site: str

    @property
    def cxs(self) -> str:
        return f"{self.host}/wday/cxs/{self.tenant}/{self.site}"

    @property
    def site_url(self) -> str:
        return f"{self.host}/en-US/{self.site}"


AIRBUS = Tenant("Airbus", "https://ag.wd3.myworkdayjobs.com", "ag", "Airbus")
ACCENTURE = Tenant("Accenture", "https://accenture.wd103.myworkdayjobs.com",
                   "accenture", "AccentureCareers")
TENANTS = {t.name.casefold(): t for t in (AIRBUS, ACCENTURE)}

# Kept so existing Airbus callers and any saved urls keep working unchanged.
HOST = AIRBUS.host
CXS = AIRBUS.cxs
SITE = AIRBUS.site_url

# The API answers HTTP 400 for limit > 20.
PAGE_SIZE = 20

COUNTRY_FRANCE = "54c5b6971ffb4bf0b116fe7651ec789a"

WORKER_SUBTYPE = {
    "regular": "f5811cef9cb501a69768a71d470a6d15",
    "temporary": "f5811cef9cb5012aaf57ecb1470a8318",
    "vie": "f5811cef9cb5016cb7041bb2470a8418",
    "apprentice": "f5811cef9cb501e1db34d41d470a6f15",
    "trainee": "f5811cef9cb50193723ed01d470a6e15",
    "client": "f5811cef9cb501fe419222b2470a8618",
}

# What "normal jobs" means: everything that is not a student/intern contract.
NON_STUDENT_SUBTYPES = ("regular", "temporary", "vie")
STUDENT_SUBTYPES = ("trainee", "apprentice")


def subtype_ids(names: Sequence[str]) -> list[str]:
    """Map friendly subtype names to Workday facet ids, rejecting typos loudly."""
    ids = []
    for n in names:
        key = n.strip().lower()
        if key not in WORKER_SUBTYPE:
            raise KeyError(
                f"Unknown worker subtype {n!r}. Known: {', '.join(sorted(WORKER_SUBTYPE))}"
            )
        ids.append(WORKER_SUBTYPE[key])
    return ids


# -------------------------------------------------------------------------
# Transport
# -------------------------------------------------------------------------

class WorkdayAPIError(RuntimeError):
    pass


def _request(url: str, payload: Optional[dict] = None, *, retries: int = 3,
             timeout: int = 30) -> dict:
    """GET (or POST when `payload` is given) and decode JSON, with backoff."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": "Mozilla/5.0"}
    if data is not None:
        headers["Content-Type"] = "application/json"

    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 4xx other than 429 is our bug, not a blip — fail immediately.
            if e.code != 429 and e.code < 500:
                raise WorkdayAPIError(f"HTTP {e.code} for {url}") from e
            last = e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
        if attempt < retries - 1:
            time.sleep(1.5 * (attempt + 1))
    raise WorkdayAPIError(f"Request to {url} failed after {retries} attempts: {last}")


# -------------------------------------------------------------------------
# Models
# -------------------------------------------------------------------------

@dataclass(frozen=True)
class JobPosting:
    """One row from the search results."""
    title: str
    url: str
    external_path: str
    location: str
    posted_on: str
    req_id: str

    @classmethod
    def from_api(cls, raw: dict, tenant: "Tenant" = None) -> "JobPosting":
        path = raw.get("externalPath", "")
        bullets = raw.get("bulletFields") or []
        # Airbus fills locationsText; Accenture leaves it null and puts the
        # location in the last bulletField instead ("Paris", or "Location
        # Negotiable" for roles open anywhere). Without this fallback every
        # Accenture posting looked location-less and ranked as "not near home".
        location = raw.get("locationsText") or ""
        if not location and len(bullets) > 1:
            location = bullets[-1]
        return cls(
            title=raw.get("title", ""),
            url=(tenant or AIRBUS).site_url + path,
            external_path=path,
            location=location,
            posted_on=raw.get("postedOn", ""),
            req_id=bullets[0] if bullets else "",
        )


@dataclass(frozen=True)
class JobDetail:
    """A full posting, including the description text we feed to the scorer."""
    title: str
    url: str
    external_path: str
    req_id: str
    location: str
    country: str
    time_type: str
    posted_on: str
    end_date: str
    description: str
    questionnaire_id: Optional[str]
    can_apply: bool
    hiring_company: str

    def as_dict(self) -> dict:
        return {
            "title": self.title,
            "url": self.url,
            "req_id": self.req_id,
            "location": self.location,
            "country": self.country,
            "time_type": self.time_type,
            "posted_on": self.posted_on,
            "end_date": self.end_date,
            "questionnaire_id": self.questionnaire_id,
            "can_apply": self.can_apply,
            "hiring_company": self.hiring_company,
            "description": self.description,
        }


# Tags that should start a new line. Everything else (span, b, a, em ...) is
# inline: Workday wraps half its sentences in spans, so splitting on those
# shreds the prose into fragments.
_BLOCK_TAGS = ("p", "div", "li", "ul", "ol", "br", "tr", "table",
               "h1", "h2", "h3", "h4", "h5", "h6", "section", "header")


def html_to_text(raw_html: str) -> str:
    """Flatten Workday's description HTML into readable plain text."""
    if not raw_html:
        return ""
    soup = BeautifulSoup(raw_html, "html.parser")

    for tag in soup.find_all(_BLOCK_TAGS):
        tag.insert_before("\n")
        tag.insert_after("\n")

    text = soup.get_text("").replace("\xa0", " ")

    out: list[str] = []
    for line in text.splitlines():
        line = re.sub(r"[ \t]+", " ", line).strip()
        if not line and out and not out[-1]:
            continue  # collapse runs of blank lines
        out.append(line)
    return "\n".join(out).strip()


# -------------------------------------------------------------------------
# Queries
# -------------------------------------------------------------------------

def fetch_facets() -> dict[str, list[tuple[str, str, int]]]:
    """Return {facetParameter: [(id, label, count), ...]} for the whole board."""
    data = _request(f"{CXS}/jobs", {"appliedFacets": {}, "limit": 1,
                                    "offset": 0, "searchText": ""})
    out: dict[str, list[tuple[str, str, int]]] = {}
    for facet in data.get("facets", []):
        param = facet.get("facetParameter")
        if not param:
            continue
        out[param] = [
            (v.get("id"), v.get("descriptor"), v.get("count"))
            for v in facet.get("values", [])
        ]
    return out


def _applied_facets(country: Optional[str],
                    subtypes: Optional[Sequence[str]]) -> dict:
    facets: dict[str, list[str]] = {}
    if country:
        facets["locationCountry"] = [country]
    if subtypes:
        facets["workerSubType"] = subtype_ids(subtypes)
    return facets


def count_jobs(country: Optional[str] = COUNTRY_FRANCE,
               subtypes: Optional[Sequence[str]] = NON_STUDENT_SUBTYPES,
               search_text: str = "", tenant: Tenant = AIRBUS) -> int:
    """How many postings match, without pulling them all down."""
    data = _request(f"{tenant.cxs}/jobs", {
        "appliedFacets": _applied_facets(country, subtypes),
        "limit": 1, "offset": 0, "searchText": search_text,
    })
    return int(data.get("total", 0))


def iter_postings(country: Optional[str] = COUNTRY_FRANCE,
                  subtypes: Optional[Sequence[str]] = NON_STUDENT_SUBTYPES,
                  search_text: str = "",
                  max_jobs: Optional[int] = None,
                  pause_s: float = 0.2,
                  tenant: Tenant = AIRBUS) -> Iterator[JobPosting]:
    """Walk every matching posting, page by page."""
    offset = 0
    yielded = 0
    total = None
    facets = _applied_facets(country, subtypes)

    while True:
        data = _request(f"{tenant.cxs}/jobs", {
            "appliedFacets": facets,
            "limit": PAGE_SIZE,
            "offset": offset,
            "searchText": search_text,
        })
        if total is None:
            total = int(data.get("total", 0))
        rows = data.get("jobPostings") or []
        if not rows:
            return

        for raw in rows:
            yield JobPosting.from_api(raw, tenant)
            yielded += 1
            if max_jobs is not None and yielded >= max_jobs:
                return

        offset += len(rows)
        if offset >= total:
            return
        time.sleep(pause_s)


def fetch_detail(external_path: str) -> JobDetail:
    """Pull one posting's full record, description included."""
    data = _request(CXS + external_path)
    info = data.get("jobPostingInfo") or {}
    org = data.get("hiringOrganization") or {}
    loc = info.get("jobRequisitionLocation") or {}
    country = (info.get("country") or {}).get("descriptor", "")

    return JobDetail(
        title=info.get("title", ""),
        url=SITE + external_path,
        external_path=external_path,
        req_id=info.get("jobReqId", ""),
        location=loc.get("descriptor") or info.get("location", ""),
        country=country,
        time_type=info.get("timeType", ""),
        posted_on=info.get("postedOn", ""),
        end_date=info.get("jobPostingEndDateAsText", ""),
        description=html_to_text(info.get("jobDescription", "")),
        questionnaire_id=info.get("questionnaireId"),
        can_apply=bool(info.get("canApply", False)),
        hiring_company=org.get("name", ""),
    )


if __name__ == "__main__":
    # Re-dump the live facet taxonomy, so stale ids are easy to spot.
    for param, values in fetch_facets().items():
        print(f"\n== {param}")
        for fid, label, count in values[:30]:
            print(f"   {fid}  {label}  ({count})")
