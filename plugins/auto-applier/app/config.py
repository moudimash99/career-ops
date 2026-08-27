# app/config.py
"""Configuration for the Airbus auto-applier.

Stage 1 targets *normal* (non-student) postings. The internship-specific
contract fields that used to live in CandidateData were removed along with the
trainee questionnaire handling in app/pages.py — see git history if the
internship flow is ever needed again.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from job_scrapper.workday_api import COUNTRY_FRANCE, NON_STUDENT_SUBTYPES


@dataclass(frozen=True)
class SeleniumConfig:
    user_data_dir: Path = Path(r"C:\SeleniumProfiles\SeleniumAirbus")
    profile_name: str = "Default"
    timeout_s: int = 20
    micro_wait_s: float = 1


@dataclass(frozen=True)
class JobSearchConfig:
    """Which slice of the board counts as 'jobs I might apply to'."""
    country: str = COUNTRY_FRANCE          # France
    subtypes: tuple[str, ...] = NON_STUDENT_SUBTYPES  # regular, temporary, vie
    search_text: str = ""
    max_jobs: int | None = None            # None = every match


@dataclass(frozen=True)
class WorkEntry:
    """One job, as Workday's My Experience page wants it.

    Months are 1-12 and years four-digit, matching the dateSectionMonth /
    dateSectionYear inputs directly. `current` ticks "I currently work here",
    which makes Workday ignore the end date.
    """
    title: str
    company: str
    start_month: int
    start_year: int
    end_month: int | None = None
    end_year: int | None = None
    current: bool = False


# Read from the candidate's CV (Mohammad_CV_2_Parts.pdf) on 2026-08-21 and
# confirmed by them: the CV is the source of truth wherever it disagrees with
# what an employer has on file. Accenture's stored profile was three years out
# of date - it ended at Airbus SAS in 2023, had that job's dates wrong by a
# year, and named UrbanSeller as "AIMTOOLS".
#
# Most recent first, which is the order Workday lists them in.
WORK_HISTORY: tuple[WorkEntry, ...] = (
    # Written with an explicit end date rather than current=True. Workday
    # silently DISCARDS a work entry that has "I currently work here" ticked -
    # verified three times on the Accenture tenant on 2026-08-21, with a real
    # click, a JavaScript click, and after scrolling clear of the sticky
    # footer. The entry ticks, the end-date fields correctly disappear, and
    # then the whole row is gone after Save. An end date of "this month" is
    # slightly wrong but survives; a dropped row loses the current job
    # entirely, which is much worse. Bump this as the months pass.
    WorkEntry("Systems & Quality Engineering", "Airbus Electric Center",
              5, 2026, 8, 2026),
    WorkEntry("Cloud & Data Engineer", "Green Praxis", 1, 2025, 8, 2025),
    WorkEntry("Data Engineer", "Airbus SAS", 1, 2023, 6, 2024),
    WorkEntry("Software Architect", "MUREX Systems", 5, 2021, 1, 2022),
    WorkEntry("AI Pipeline Developer", "ZAKA", 10, 2020, 9, 2021),
    WorkEntry("Freelance Full-Stack Developer", "UrbanSeller", 6, 2020, 2, 2021),
)


@dataclass(frozen=True)
class CandidateData:
    """Answers that are stable across applications."""
    # Identity — required on the first wizard page ("My Information").
    # These match what Workday itself prefilled from the previous application
    # (read off the live form 2026-08-19), so an empty-field fill produces the
    # same spelling and phone formatting the candidate used before.
    given_name: str = "Mohammad"
    family_name: str = "Machaka"
    phone_number: str = "07 53 37 78 23"
    address_line1: str = "39 allée d'Ancely"
    city: str = "Toulouse"
    postal_code: str = "31300"

    # Identity — used on the final personal-information page.
    # Workday's date field is labelled MM/DD/YYYY and these digits are typed
    # into it straight, so "06101999" is 10 June 1999 - confirmed live on the
    # Review page, which rendered "current value is 6/10/1999". The old name
    # (birth_ddmmyyyy) claimed the opposite and invited a wrong "fix".
    birth_mmddyyyy: str = "06101999"
    nationality: str = "Lebanon"
    gender: str = "Male"

    # Employment history with Airbus. External applicants leave this False;
    # the employee id is only read when previous_worker is True.
    # Confirmed by the candidate 2026-08-20: yes, and this is the id Workday
    # itself prefills. Prefill still wins - see _answer_previous_worker - these
    # are only the fallback for a posting that does not prefill.
    previous_worker: bool = True
    employee_id: str = "580323"

    # Click "Use My Last Application" when a posting offers it. It prefills from
    # the previous application, attachments included, so every write in
    # app/pages.py replaces what is there rather than adding to it.
    use_last_application: bool = True

    # Education / languages — kept for pages that ask, filled opportunistically
    university: str = "UNIVERSITÉ TOULOUSE III - PAUL SABATIER"
    # Must match a Degree option exactly, and the wording is per tenant:
    # Airbus prefixes by country ("FR- Master (LMD)"), Accenture uses plain
    # "Master's Degree". Tried in order until one is offered, so a new board
    # does not need a code change.
    degree: str = "FR- Master (LMD)"
    degree_candidates: tuple[str, ...] = (
        "FR- Master (LMD)", "Master's Degree", "Master", "Master Degree",
        "Masters Degree",
    )
    course: str = "Master's In Computer Science for Aerospace"
    # Prefill usually carries these, so they are only written when a page
    # arrives with an empty Work Experience section.
    work_history: tuple[WorkEntry, ...] = WORK_HISTORY

    english_level: str = "Negotiation / Fluent"
    french_level: str = "Intermediate"


class MissingAttachmentError(RuntimeError):
    """Raised when a document we are told to upload is not configured/present."""


# Where career-ops writes the generated CVs and letters. Same path as
# tools/apply_capgemini.py, tools/scrape_capgemini.py and tools/run_all.py.
DOCS_ROOT = Path(r"C:\Users\Moudimash99\Documents\Coding\career-ops\output")

# The general-purpose CV, attached to any Workday application that does not
# name its own. Unbranded and two pages, so it suits Airbus and Accenture
# alike; the Capgemini flow picks a tailored family CV per posting instead and
# never consults this.
DEFAULT_CV = DOCS_ROOT / "Mohammad_Machaka_CV.pdf"


@dataclass(frozen=True)
class ApplicationFiles:
    """Documents attached to every application.

    There *is* a default CV, and there did not used to be. The old rule was
    that silently uploading a stale PDF is worse than refusing to run, so
    AIRBUS_CV_PATH had to be exported by hand every session. That is the right
    instinct aimed at the wrong target: it does not prevent a stale upload, it
    only prevents an unattended run - which is the whole point of
    tools/run_all.py, and it left Airbus and Accenture skipped every time.

    What the rule was actually protecting against is *silence*. So the default
    stands and the silence goes: every caller prints the file it is about to
    attach before it attaches it, and tools/run_all.py resolves and logs it in
    the preflight, before a browser opens. AIRBUS_CV_PATH still wins when set.
    """
    cv_path: Path | None = None
    cover_letter_path: Path | None = None

    @classmethod
    def from_env(cls) -> "ApplicationFiles":
        """The configured documents: AIRBUS_CV_PATH, else the default CV.

        The default is only taken when the file is actually there. A missing
        DEFAULT_CV must still raise from resolved() with its real path in the
        message - falling back to None would report "no CV configured", which
        sends whoever reads it looking for a setting rather than a file.
        """
        cv = os.getenv("AIRBUS_CV_PATH")
        cl = os.getenv("AIRBUS_COVER_LETTER_PATH")
        if cv:
            cv_path = Path(cv)
        elif cls.cv_path is not None:
            cv_path = Path(cls.cv_path)
        else:
            cv_path = DEFAULT_CV
        return cls(
            cv_path=cv_path,
            cover_letter_path=Path(cl) if cl else cls.cover_letter_path,
        )

    def resolved(self) -> list[Path]:
        """Validate and return the files to upload, CV first.

        Raises MissingAttachmentError with an actionable message rather than
        letting Selenium fail obscurely on an empty send_keys.
        """
        if self.cv_path is None:
            raise MissingAttachmentError(
                "No CV configured. Set AIRBUS_CV_PATH to your CV PDF, e.g.\n"
                '    $env:AIRBUS_CV_PATH = "C:\\path\\to\\my_cv.pdf"\n'
                "or set cv_path on ApplicationFiles in app/config.py."
            )

        files: list[Path] = []
        for label, p in (("CV", self.cv_path),
                         ("cover letter", self.cover_letter_path)):
            if p is None:
                continue
            p = Path(p).expanduser()
            if not p.is_file():
                raise MissingAttachmentError(f"Configured {label} not found: {p}")
            if p.suffix.lower() != ".pdf":
                raise MissingAttachmentError(
                    f"Configured {label} is not a PDF: {p}"
                )
            files.append(p.resolve())
        return files
