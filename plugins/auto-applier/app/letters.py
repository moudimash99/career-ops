"""Render a per-role cover letter to PDF, through career-ops' renderer.

Not reimplemented here on purpose. career-ops already renders these letters
(`generate-cover-letter.mjs`: payload JSON -> HTML template -> PDF via
Playwright), and the nine letters already sitting in its output directory came
out of it. Calling it means a new letter is indistinguishable from those, and
that the fact check in `verify-cv-facts.mjs` runs over every one - it blocks a
letter that claims a metric or a fact the CV does not evidence, which is the
guarantee worth keeping.

What lives here is the part that is this repo's business: turning a Role plus
its authored content into that payload, and failing loudly when the renderer
is not there. A cover letter that silently fails to build is how the first five
applications went out with none.

The content itself is `data/capgemini-letters.json`, keyed by requisition id.
Keyed by id and not by title because these letters print their own reference
number in the body: reusing one on another posting quotes the wrong reference.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parent.parent
LETTER_CONTENT = REPO / "data" / "capgemini-letters.json"

# career-ops is a sibling checkout, not a dependency of this repo. The apply
# tool already resolves documents against its output directory; this is the
# same coupling, named in one place.
CAREER_OPS = Path(r"C:\Users\Moudimash99\Documents\Coding\career-ops")
RENDERER = "generate-cover-letter.mjs"

# generate-cover-letter.mjs resolves its output against `output` in the current
# working directory, so it has to run from the career-ops root.
OUTPUT_SUBDIR = "output"

CANDIDATE = {
    "name": "Mohammad Machaka",
    # The account the applications are sent from. career-ops' own copy of this
    # block still says machaka.mohammad@gmail.com, which would put a different
    # address on the letter than the one Capgemini has on file.
    "email": "moudimash99@gmail.com",
    "phone": "+33 7 53 37 78 23",
    "location": "Toulouse, France",
    "linkedin": "https://linkedin.com/in/mohammad-machaka-a63685172",
    "credentials": [
        "MS Ingénierie des Systèmes, ISAE-SUPAERO",
        "ASEP (INCOSE)",
        "AWS Solutions Architect – Associate",
    ],
}

GREETING = "Madame, Monsieur,"
CLOSING = ("Je vous prie d'agréer, Madame, Monsieur, l'expression de mes "
           "salutations distinguées.")
# Availability is immediate, stated without a qualifier. The earlier wording
# named the end of the Airbus internship, which reads as "not actually
# available until November" whatever the sentence in front of it says.
AVAILABILITY = (
    "Je suis installé à Toulouse et disponible immédiatement. Je serais "
    "heureux d'échanger sur vos projets et de vous exposer ma démarche plus "
    "en détail.")


class LetterError(RuntimeError):
    pass


@dataclass(frozen=True)
class Letter:
    req_id: str
    slug: str
    filename: str
    path: Path


def load_content(path: Path = LETTER_CONTENT) -> dict:
    """The authored per-role content, minus the file's own comment key."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def payload_for(req_id: str, content: dict) -> dict:
    """The payload generate-cover-letter.mjs expects for one posting."""
    entry = content[req_id]
    filename = f"lettre-motivation-capgemini-{entry['slug']}.pdf"
    return {
        "candidate": CANDIDATE,
        "letter": {
            "role_title": entry["role_title"],
            "company": "Capgemini",
            "city": entry.get("city", "Toulouse"),
            "date": date.today().isoformat(),
            "greeting": GREETING,
            "opening": entry["opening"],
            "profile_intro": entry["profile_intro"],
            "achievements": entry.get("achievements", []),
            "problems_section": entry.get("problems_section"),
            "closing": f"{AVAILABILITY} {CLOSING}",
        },
        "output_path": f"{OUTPUT_SUBDIR}/{filename}",
    }


def build(req_id: str, scratch: Path, content: Optional[dict] = None,
          career_ops: Path = CAREER_OPS) -> Letter:
    """Render one letter and return where it landed.

    Raises rather than returning None for a missing renderer or a failed
    render: the caller's next step is to attach this file to a real
    application, and "no letter" has to be a decision, never an accident.
    """
    content = load_content() if content is None else content
    if req_id not in content:
        raise LetterError(
            f"no letter written for requisition {req_id}. Add it to "
            f"{LETTER_CONTENT.name} - a letter from another posting cannot be "
            "reused, it prints its own reference number.")

    renderer = career_ops / RENDERER
    if not renderer.is_file():
        raise LetterError(f"renderer not found: {renderer}")
    node = shutil.which("node")
    if not node:
        raise LetterError("node is not on PATH; the letter renderer needs it")

    data = payload_for(req_id, content)
    # Absolute: the renderer runs with cwd=career_ops, so a relative payload
    # path would be resolved against THAT directory and reported missing.
    scratch = Path(scratch).resolve()
    scratch.mkdir(parents=True, exist_ok=True)
    payload_path = scratch / f"cover-capgemini-{content[req_id]['slug']}.json"
    payload_path.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                            encoding="utf-8")

    proc = subprocess.run(
        [node, RENDERER, "--payload", str(payload_path), "--format", "a4"],
        cwd=career_ops, capture_output=True, text=True, encoding="utf-8",
        errors="replace")
    if proc.returncode != 0:
        detail = (proc.stdout or "") + (proc.stderr or "")
        raise LetterError(f"render failed for {req_id}:\n{detail.strip()}")

    out = career_ops / data["output_path"]
    if not out.is_file():
        raise LetterError(f"renderer reported success but {out} is missing")
    return Letter(req_id=req_id, slug=content[req_id]["slug"],
                  filename=out.name, path=out)
