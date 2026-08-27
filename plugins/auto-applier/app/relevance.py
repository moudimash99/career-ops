"""Which postings are worth applying to, and how recently they went up.

Stage 2 of the roadmap is an LLM scorer. This is not that: it is a small,
explicit keyword model over the job title, chosen because every decision it
makes can be read off the reason string and argued with. A real application
goes out under the candidate's name, so "why did it pick this one" has to have
an answer better than "the model said so".

The profile it encodes: Master's in Computer Science for Aerospace - software,
AI/data, cyber/IT, systems and space-ground roles. Explicitly not buying,
logistics, production, quality or back-office roles, which is most of what the
Airbus France board actually carries.

Titles come in French and English on the same board, so both are listed.
"""
from __future__ import annotations

import re
import unicodedata

# --- how old is it -------------------------------------------------------

_DAYS = re.compile(r"posted\s+(\d+)\+?\s*days?\s+ago")


def days_since_posted(posted_on: str) -> int | None:
    """Turn Workday's relative wording into a number of days.

    "Posted Today" -> 0, "Posted 9 Days Ago" -> 9, "Posted 30+ Days Ago" -> 30.
    Returns None when it cannot be read, which callers must treat as unknown
    rather than as recent.
    """
    text = " ".join((posted_on or "").split()).casefold()
    if not text:
        return None
    if "today" in text or "just posted" in text:
        return 0
    if "yesterday" in text:
        return 1
    m = _DAYS.search(text)
    return int(m.group(1)) if m else None


def is_lower_bound(posted_on: str) -> bool:
    """Whether Workday only told us a floor, as in "Posted 30+ Days Ago".

    231 of the 436 Airbus postings on 2026-08-21 were "30+", which says at
    least 30 days and nothing about the ceiling - one of them could be a year
    old. Reading that as exactly 30 let every one of them through a
    "last 30 days" filter.
    """
    return "+" in (posted_on or "")


def posted_within(posted_on: str, days: int) -> bool:
    """Whether the posting is *known* to be at most `days` old.

    Conservative on purpose. An unreadable age is excluded, and so is a lower
    bound that has already reached the window - "30+ Days Ago" cannot be shown
    to be within 30 days, so it is not treated as if it were.
    """
    age = days_since_posted(posted_on)
    if age is None:
        return False
    if is_lower_bound(posted_on):
        # "N+" means at least N. It only fits a window strictly wider than N.
        return age < days
    return age <= days


# --- is it interesting ---------------------------------------------------

# Weighted so a strong signal ("software developer") outranks a weak one
# ("engineer"), and a disqualifier outranks anything.
STRONG = (
    "software", "logiciel", "developer", "développeur", "developpeur",
    "data scien", "data engineer", "données", "machine learning",
    "artificial intelligence", "ai", "ia", "deep learning",
    "cyber", "cybersecurity", "cybersécurité", "informatique", "computing",
    "computer", "devops", "cloud", "digital", "numérique", "numerique",
    "algorithm", "algorithme", "embedded", "embarqué", "embarque",
    "full stack", "backend", "back-end", "frontend", "front-end",
    "python", "java", "c++", "matlab",
    # Space-ground and avionics work is software work on this board, and a
    # single such term is enough on its own - "Ground Segment Engineer" was
    # scoring the same as "Acoustic Test Engineer", which is not the same job.
    "ground segment", "segment sol", "avionic", "avionique", "toolchain",
    "analytics", "analytique",
)
MEDIUM = (
    "system", "système", "systeme", "simulation", "model", "modélisation",
    "architect", "architecte", "ground segment", "segment sol", "avionic",
    "avionique", "automation", "automatisation", "toolchain", "platform",
    "plateforme", "network", "réseau", "reseau", "it", "sap",
    "test engineer", "validation", "verification", "vérification",
    "analytics", "analyst", "analyste", "r&d", "research", "recherche",
)
# Any of these and we do not apply, whatever else the title says.
DISQUALIFY = (
    "buyer", "acheteur", "achats", "procurement", "purchas", "sourcing",
    "supply", "approvisionn", "logistic", "logistique", "magasin",
    "warehouse", "transport",
    "quality inspect", "qualiticien", "contrôleur", "controleur",
    "production", "manufacturing", "fabrication", "assembly", "montage",
    "chaudronn", "usinage", "machine outil", "peintre", "painter",
    # "numerique" is a strong digital signal in French *except* here:
    # "commande numerique" is CNC machining, which shortlisted a programmer of
    # milling machines as a digital role.
    "commande numerique", "commandes numeriques",
    "operator", "opérateur", "operateur", "technicien de maintenance",
    "mechanic", "mécanicien", "mecanicien", "electrician", "électricien",
    "human resources", "ressources humaines", "hr", "recruit",
    "finance", "comptab", "accounting", "controlling", "juridique", "legal",
    "sales", "commercial", "marketing", "communication",
    # Adjacent to the profile but not it: bid/tender work is sales-side,
    # patent attorney needs a law qualification, and instructor roles teach
    # the systems rather than build them.
    "bid manager", "bid &", "bid and", "tender", "business developer",
    "patent", "attorney", "instructeur", "instructor",
    "facility", "immobilier", "hse", "santé", "safety officer",
    "apprenti", "apprentice", "stage", "internship", "alternance",
)

STRONG_W, MEDIUM_W, THRESHOLD = 3, 1, 3


def _flat(text: str) -> str:
    """Casefolded and accent-stripped, so the French and English lists agree."""
    norm = unicodedata.normalize("NFKD", text or "")
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    return " ".join(norm.casefold().split())


# Terms must begin at a word boundary, or "ai" matches Airbus and Ajusteur and
# "ia" matches industrialisation - which is how a first pass shortlisted 40
# assembly, maintenance and non-destructive-testing jobs as AI roles.
#
# Short terms have to end on one too ("ai" is a prefix of "airbus"). Longer
# ones deliberately do not, so "logistic" catches "logistique" and
# "approvisionn" catches "approvisionnement".
_WHOLE_WORD_MAX = 3


def _matcher(term: str) -> re.Pattern:
    body = re.escape(_flat(term))
    tail = r"(?![a-z0-9])" if len(_flat(term)) <= _WHOLE_WORD_MAX else ""
    return re.compile(rf"(?<![a-z0-9]){body}{tail}")


_CACHE: dict[str, re.Pattern] = {}


def _hits(term: str, text: str) -> bool:
    pattern = _CACHE.get(term)
    if pattern is None:
        pattern = _CACHE[term] = _matcher(term)
    return bool(pattern.search(text))


def score_title(title: str) -> tuple[int, str]:
    """Score a job title. Returns (score, reason).

    Negative score means disqualified; the reason names the term, so a wrong
    pick can be traced to the word that caused it rather than guessed at.
    """
    flat = _flat(title)

    for term in DISQUALIFY:
        if _hits(term, flat):
            return -1, f"disqualified by {term.strip()!r}"

    # One word in the title must score once. Two things would otherwise
    # double-count it: the lists carry both spellings of the accented words
    # and _flat strips accents, and shorter terms are substrings of longer
    # ones ("system" inside "systeme"). Longest match in an overlapping group
    # wins, so a French title cannot outrank an equivalent English one.
    matched = []
    for terms, weight in ((STRONG, STRONG_W), (MEDIUM, MEDIUM_W)):
        for term in terms:
            if _hits(term, flat):
                matched.append((_flat(term), weight))

    hits, score, kept = [], 0, []
    for key, weight in sorted(matched, key=lambda kw: -len(kw[0])):
        if any(key in longer for longer in kept):
            continue
        kept.append(key)
        hits.append(key)
        score += weight

    if not hits:
        return 0, "no matching term"
    return score, "matched " + ", ".join(dict.fromkeys(hits))


def is_interesting(title: str) -> bool:
    return score_title(title)[0] >= THRESHOLD
