# main.py
import traceback
from pathlib import Path
from app.config import SeleniumConfig, CandidateData
from app.driver import build_driver
from app.ux import UX
from app.pages import JobPage, ApplicationWizard
import app.link_getter
from job_scrapper.description_getter import extract_job_description
CFG = SeleniumConfig()
ME  = CandidateData()

def main():
    # succ, miss = get_output_files()
    d = build_driver(CFG.user_data_dir, CFG.profile_name)
    d.get("https://www.google.com")
if __name__ == "__main__":
    main()
