"""Employers this repo can apply to, as data rather than as separate code.

Airbus and Accenture both run Workday, so they differ only in three strings
(host, tenant, site), which account the session belongs to, and which Chrome
profile holds that session. Sopra Steria runs SmartRecruiters and needs its own
client - it is listed here so the roster is honest about what exists, with
`workday` set to None. Capgemini is the same story on SAP SuccessFactors,
driven by app/capgemini.py.

Each employer gets its own Chrome profile. Sharing one would mean a single
cookie jar for two Workday tenants, and `ensure_signed_in` would keep deciding
the session belongs to the wrong company.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from job_scrapper.workday_api import ACCENTURE, AIRBUS, Tenant

PROFILE_ROOT = Path(r"C:\SeleniumProfiles")


@dataclass(frozen=True)
class Employer:
    name: str
    # None for employers not on Workday; those need their own client.
    workday: Optional[Tenant]
    # Credentials are read from <ENV_PREFIX>_EMAIL / <ENV_PREFIX>_PASSWORD, so
    # one .env can hold an account per employer without them colliding.
    env_prefix: str
    profile_dir: Path
    profile_name: str = "Default"
    # How to answer "How Did You Hear About Us?", as a prompt path. Accenture
    # nests it (a category, then a leaf); Airbus offers one flat list. Chosen
    # to be truthful: the postings are found on the employer's own board, and
    # nothing under Accenture's "Job Boards" describes that, so "Other ->
    # Not Listed" is the accurate answer rather than a plausible-looking one.
    source_answer: tuple[str, ...] = ()
    # Where the applications record for this employer lives.
    output_dir: Path = Path("output")

    @property
    def careers_url(self) -> str:
        if not self.workday:
            raise NotImplementedError(
                f"{self.name} is not on Workday; use its own client.")
        return self.workday.site_url

    @property
    def login_url(self) -> str:
        return self.careers_url + "/login"


REPO = Path(__file__).resolve().parent.parent

AIRBUS_EMPLOYER = Employer(
    name="Airbus",
    workday=AIRBUS,
    env_prefix="AIRBUS",
    source_answer=("Airbus Careers Website",),
    profile_dir=PROFILE_ROOT / "SeleniumAirbus",
    output_dir=REPO / "output",
)

ACCENTURE_EMPLOYER = Employer(
    name="Accenture",
    workday=ACCENTURE,
    env_prefix="ACCENTURE",
    source_answer=("Other", "Not Listed"),
    profile_dir=PROFILE_ROOT / "SeleniumAccenture",
    output_dir=REPO / "output" / "accenture",
)

SOPRA_STERIA_EMPLOYER = Employer(
    name="Sopra Steria",
    workday=None,                     # SmartRecruiters - see app/smartrecruiters.py
    env_prefix="SOPRA",
    profile_dir=PROFILE_ROOT / "SeleniumSopra",
    output_dir=REPO / "output" / "sopra_steria",
)

CAPGEMINI_EMPLOYER = Employer(
    name="Capgemini",
    workday=None,                     # SAP SuccessFactors - see app/capgemini.py
    env_prefix="CAPGEMINI",
    profile_dir=PROFILE_ROOT / "SeleniumCapgemini",
    output_dir=REPO / "output" / "capgemini",
)

EMPLOYERS = {e.name.casefold(): e for e in
             (AIRBUS_EMPLOYER, ACCENTURE_EMPLOYER, SOPRA_STERIA_EMPLOYER,
              CAPGEMINI_EMPLOYER)}


def get(name: str) -> Employer:
    """Look an employer up by name, rejecting typos loudly."""
    key = " ".join((name or "").split()).casefold()
    if key not in EMPLOYERS:
        raise KeyError(f"Unknown employer {name!r}. "
                       f"Known: {', '.join(sorted(EMPLOYERS))}")
    return EMPLOYERS[key]
