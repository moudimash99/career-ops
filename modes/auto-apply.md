# Mode: auto-apply — Automated Application Pipeline

> Apply `voice-dna.md` (if present) to free-text answers and cover-letter fields — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_writing.md` → Voice DNA.

This mode drives the `AirBusAutoApplier` project for Airbus, Accenture, and Capgemini. It is its own repo (github.com/moudimash99/AirBusAutoApplier), cloned **outside** career-ops — on this machine at `C:\Users\Moudimash99\Documents\GitHub\AirBusAutoApplier` (below: `<applier>`). It finds career-ops through `CAREER_OPS_DIR` in its `.env`, defaulting to the live copy `Documents\Coding\career-ops`.

## Workflow

1. PREPARE   → Ensure virtual environment is ready and dependencies are installed.
2. SHORTLIST → Generate shortlists of target roles or use existing ones in the output folder.
3. RUN       → Execute the auto-applier Python scripts for the targeted employers.

## Supported Employers

- **Airbus** (via Workday)
- **Accenture** (via Workday)
- **Capgemini** (via SmartRecruiters / Capgemini portals)

## How to use

The tools are in `<applier>/tools`. Run them from the `<applier>` folder with its virtual environment (`.venv\Scripts\python.exe`):

1. **To run the full suite for all supported employers:**
   ```bash
   .venv\Scripts\python.exe tools/run_all.py
   ```
   *Optionally pass `--dry-run` to test the forms without submitting, or `--search-only` to generate shortlists without applying.*

2. **To apply for a specific employer (e.g., Capgemini):**
   ```bash
   .venv\Scripts\python.exe tools/run_all.py --employers Capgemini
   ```

3. **To run the Shortlist Applier explicitly (for Workday boards like Airbus and Accenture):**
   ```bash
   .venv\Scripts\python.exe tools/apply_shortlist.py --employer Airbus
   ```

4. **To run the Capgemini Applier directly:**
   ```bash
   .venv\Scripts\python.exe tools/apply_capgemini.py
   ```

## Setup Instructions

Before running for the first time, ensure the python virtual environment is initialized:
```bash
cd <applier>
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

## Important Requirements

- **Environment Variables**: Make sure the `.env` file in `<applier>` is properly populated with the necessary credentials.
- **Answer Payloads**: Verify that the answers in `<applier>/answers` are correct for the user's profile before doing a real run.
- **Shortlist Generation**: For Capgemini, `scrape_capgemini.py` or `run_all.py` will pull the jobs. For Airbus/Accenture, `shortlist.py` generates the candidates.
- **CVs**: every posting gets its own one-page CV from career-ops — agy writes it through `cv-write.mjs` (the CV rules in `modes/_custom.md` + `cv.md` + the posting) and `generate-cv-typst.mjs` renders it (`<applier>/app/tailored_docs.py`). `CV_ARM` in `<applier>/.env` picks `loose` (default) or `strict`. On any failure the posting falls back to the generic CV rather than not being sent.
