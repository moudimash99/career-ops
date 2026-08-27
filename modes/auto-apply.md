# Mode: auto-apply — Automated Application Pipeline

> Apply `voice-dna.md` (if present) to free-text answers and cover-letter fields — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_writing.md` → Voice DNA.

This mode wraps the automated application tools imported from the `AirBusAutoApplier` project for Airbus, Accenture, and Capgemini.

## Workflow

1. PREPARE   → Ensure virtual environment is ready and dependencies are installed.
2. SHORTLIST → Generate shortlists of target roles or use existing ones in the output folder.
3. RUN       → Execute the auto-applier Python scripts for the targeted employers.

## Supported Employers

- **Airbus** (via Workday)
- **Accenture** (via Workday)
- **Capgemini** (via SmartRecruiters / Capgemini portals)

## How to use

The tools are located in `plugins/auto-applier/tools`. To run them, use `run_command` in the terminal from the `plugins/auto-applier` directory:

1. **To run the full suite for all supported employers:**
   ```bash
   python tools/run_all.py
   ```
   *Optionally pass `--dry-run` to test the forms without submitting, or `--search-only` to generate shortlists without applying.*

2. **To apply for a specific employer (e.g., Capgemini):**
   ```bash
   python tools/run_all.py --employers Capgemini
   ```

3. **To run the Shortlist Applier explicitly (for Workday boards like Airbus and Accenture):**
   ```bash
   python tools/apply_shortlist.py --employer Airbus
   ```

4. **To run the Capgemini Applier directly:**
   ```bash
   python tools/apply_capgemini.py
   ```

## Setup Instructions

Before running for the first time, ensure the python virtual environment is initialized:
```bash
cd plugins/auto-applier
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

## Important Requirements

- **Environment Variables**: Make sure the `.env` file in `plugins/auto-applier` is properly populated with the necessary credentials.
- **Answer Payloads**: Verify that the answers in `plugins/auto-applier/answers` are correct for the user's profile before doing a real run.
- **Shortlist Generation**: For Capgemini, `scrape_capgemini.py` or `run_all.py` will pull the jobs. For Airbus/Accenture, `shortlist.py` generates the candidates.
