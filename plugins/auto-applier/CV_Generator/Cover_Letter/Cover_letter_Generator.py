#!/usr/bin/env python3
"""
cvgen_simple.py — Minimal CV LaTeX generator (Approach A)
--------------------------------------------------------
• No minification, no token counting, no streaming complexity.
• Just fill the file paths & model variables below and run:
    python cvgen_simple.py
• Requires:  `pip install openai python-dotenv` (dotenv optional).
"""
import os, re, sys
from pathlib import Path
from openai import OpenAI
from dotenv import load_dotenv

# ------------------------------------------------------------------
# >>> USER‑CONFIGURABLE VARIABLES (edit here, keep it simple) <<<
# ------------------------------------------------------------------
MODEL          = "gpt-5"   # e.g. "gpt-5-mini" for cheaper drafts
TEMPERATURE    = 0.2
MAX_TOKENS_OUT = 3500       # fits a 1‑page LaTeX CV

BASE_DIR = Path("CV_Generator")  # <— all files live here
COVER_LETTER_DIR = BASE_DIR / "Cover_Letter"
EXTENDED_CV_FILE = BASE_DIR / "extended_cv_structured.json"

JOB_FILE         = BASE_DIR / "job.txt"

TEMPLATE_FILE    = COVER_LETTER_DIR / "Cover_letter.tex"
RULES_FILE       = COVER_LETTER_DIR / "PROMPT.md"
OUTPUT_FILE      = COVER_LETTER_DIR / "output.tex"
RAW_OUTPUT_FILE  = COVER_LETTER_DIR / "raw_response.tex"
# ------------------------------------------------------------------

SYSTEM_MSG = r"""You write cover letters that sound like a real person. Output a single, compile-ready LaTeX document that begins with \documentclass and ends with \end{document}. No explanations, code fences or extra text."""

USER_TMPL = """<EXTENDED_CV>
{extended}
</EXTENDED_CV>

<TEMPLATE_TEX>
{template}
</TEMPLATE_TEX>

<RULES>
{rules}
</RULES>

<JOB_DESCRIPTION>
{job}
</JOB_DESCRIPTION>

Return ONLY the final LaTeX file, nothing else.
Don’t forget \\vspace{{\\topsep}} before the bulletin points of the first job (Green Praxis), you always forget that for some reason"""

# ------------------------------------------------------------------

def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def extract_latex(text: str) -> str:
    r"""Keep only from first \\documentclass to last \\end{document}."""
    m1 = re.search(r"\\documentclass", text)
    m2 = re.search(r"\\end{document}", text)
    return text[m1.start():m2.end()] if m1 and m2 else ""


def create_latex_cover_letter(job_description: str) -> None:
    load_dotenv()
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        sys.exit("OPENAI_API_KEY not set (use .env or env var)")

    # Read files (no minification, keep simple)
    extended = read(EXTENDED_CV_FILE)
    template = read(TEMPLATE_FILE)
    rules    = read(RULES_FILE)

    user_payload = USER_TMPL.format(extended=extended, template=template, rules=rules, job=job_description)

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_MSG},
            {"role": "user", "content": user_payload},
        ],
    )

    full_text = resp.choices[0].message.content or ""
    RAW_OUTPUT_FILE.write_text(full_text, encoding="utf-8")
    print(f"[OK] Wrote raw model output to {RAW_OUTPUT_FILE}")

    latex = extract_latex(full_text)
    if not latex:
        sys.exit("Model did not return valid LaTeX—check the prompt or raise max tokens.")

    OUTPUT_FILE.write_text(latex, encoding="utf-8")
    print(f"[OK] Wrote {OUTPUT_FILE}")
    return OUTPUT_FILE

if __name__ == "__main__":
    job_description      = read(JOB_FILE)
    create_latex_cover_letter(job_description)