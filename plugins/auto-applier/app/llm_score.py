"""Score a posting against the CV with a local model, or say why it could not.

Stage 2 of the roadmap. `app/relevance.score_title` ranks on words in the
title, which is defensible and fast but cannot tell "Tech Lead Cloud AWS" from
"Consultant SAP Analytics" once both contain a word on the list - and it never
reads the posting body at all.

The model runs locally through Ollama. No key, no per-call cost, and the
posting text never leaves the machine, which matters because these are real
applications for a real person.

Two properties are deliberate:

- **It degrades, it does not fail.** With no Ollama running, `score` returns
  the keyword score and says so in `source`. The tool stays usable on a
  machine that has not installed it, and a scan never dies half way through a
  board because a daemon was down.
- **Every score carries its reason.** Same rule as `score_title`: a pick has
  to be explainable, otherwise there is no way to tell a good shortlist from a
  plausible-looking one.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

from app import relevance

# Ollama's default local endpoint. Not configurable by accident: if this ever
# points somewhere remote, the CV and the postings go with it.
HOST = "http://localhost:11434"
GENERATE = HOST + "/api/generate"
TAGS = HOST + "/api/tags"

# Chosen for French comprehension at a size that runs on a laptop. Override
# per call; `available_models` reports what is actually pulled.
DEFAULT_MODEL = "qwen2.5:14b"

TIMEOUT_S = 180

# The keyword score tops out well below 100, so the two scales are not
# comparable. Say which produced a number rather than pretending they match.
KEYWORD = "keyword"
MODEL = "model"

PROMPT = """Tu évalues si une offre d'emploi correspond au CV d'un candidat.

<CV>
{cv}
</CV>

<OFFRE titre="{title}">
{jd}
</OFFRE>

Note la correspondance de 1 à 100, où:
  1-30   le candidat ne remplit pas les critères essentiels
  31-60  correspondance partielle, des manques importants
  61-85  bonne correspondance, quelques manques secondaires
  86-100 correspondance forte sur les critères essentiels

Sois sévère sur les technologies exigées que le CV ne montre pas, et sur les
années d'expérience demandées. Ne récompense pas les mots-clés communs.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour:
{{"score": <entier>, "reason": "<une phrase, en français>", "gaps": ["<manque>", ...]}}"""


@dataclass
class Score:
    score: int
    reason: str
    gaps: list = field(default_factory=list)
    source: str = MODEL
    model: str = ""

    @property
    def explained(self) -> str:
        gaps = ("; manques: " + ", ".join(self.gaps)) if self.gaps else ""
        return f"{self.reason}{gaps}"


class OllamaUnavailable(RuntimeError):
    pass


def _post(url: str, body: dict, timeout: int = TIMEOUT_S) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise OllamaUnavailable(f"{url}: {e}") from e


def available_models() -> list:
    """Which models are pulled, or [] when Ollama is not running."""
    try:
        req = urllib.request.Request(TAGS)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []
    return [m.get("name", "") for m in data.get("models", [])]


def is_available(model: Optional[str] = None) -> bool:
    names = available_models()
    if not names:
        return False
    if model is None:
        return True
    # Ollama reports "qwen2.5:14b"; accept a bare family name too.
    return any(n == model or n.split(":")[0] == model.split(":")[0]
               for n in names)


def parse_response(text: str) -> Optional[dict]:
    """The JSON object out of a model reply, or None.

    Small models wrap JSON in prose or a ```json fence however firmly they are
    told not to. That is a miss to be handled, not a crash: the caller falls
    back rather than losing the whole scan.
    """
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1)
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _coerce(data: dict, model: str) -> Optional[Score]:
    raw = data.get("score")
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return None
    gaps = data.get("gaps") or []
    if isinstance(gaps, str):
        gaps = [gaps]
    return Score(
        score=max(1, min(100, value)),
        reason=str(data.get("reason") or "").strip() or "no reason given",
        gaps=[str(g) for g in gaps][:5],
        source=MODEL,
        model=model,
    )


def keyword_score(title: str) -> Score:
    """The Stage 1 model, wearing the same shape."""
    value, reason = relevance.score_title(title)
    return Score(score=max(1, value), reason=reason, source=KEYWORD)


def score(title: str, jd: str, cv: str, model: str = DEFAULT_MODEL,
          timeout_s: int = TIMEOUT_S) -> Score:
    """Score one posting, falling back to the keyword model when it must.

    A posting with no description text is not sent to the model at all: there
    is nothing to reason over, and a model asked to score an empty offer
    answers confidently anyway.
    """
    if not jd.strip():
        out = keyword_score(title)
        out.reason += " (no description text; not scored by the model)"
        return out

    try:
        data = _post(GENERATE, {
            "model": model,
            "prompt": PROMPT.format(cv=cv, title=title, jd=jd),
            "stream": False,
            "format": "json",
            "options": {"temperature": 0},
        }, timeout=timeout_s)
    except OllamaUnavailable:
        # Deliberately terse. The caller reports the reason once, up front;
        # repeating a WinError on all twenty rows buries the actual scores.
        out = keyword_score(title)
        out.reason += " (Ollama unavailable)"
        return out

    parsed = parse_response(data.get("response", ""))
    result = _coerce(parsed, model) if parsed else None
    if result is None:
        out = keyword_score(title)
        out.reason += " (model reply was not usable JSON)"
        return out
    return result
