from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    TimeoutException,
    ElementClickInterceptedException,
    ElementNotInteractableException,
    StaleElementReferenceException,
)
import re
from typing import Tuple

def extract_job_description(driver, link: str, timeout: int = 15, expand_show_more: bool = True
                           ) -> Tuple[str, str]:
    """
    Load the job page, optionally expand 'show more', and return:
        (job_name, job_description_text, job_description_html)
    Raises:
        TimeoutException if header/description aren't visible within `timeout`.
    """
    driver.get(link)

    if expand_show_more:
        # Simpler, more reliable XPath for button label matching
        buttons = driver.find_elements(
            By.XPATH,
            '//button[contains(., "Show more") or contains(., "Voir plus") or contains(., "Read more") or contains(., "Afficher plus")]'
        )
        for b in buttons:
            try:
                b.click()
            except (ElementClickInterceptedException, ElementNotInteractableException, StaleElementReferenceException):
                try:
                    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", b)
                    b.click()
                except Exception:
                    pass  # ignore buttons that cannot be clicked

    # Header/title
    header_el = WebDriverWait(driver, timeout).until(
        EC.visibility_of_element_located((By.CSS_SELECTOR, '[data-automation-id="jobPostingHeader"]'))
    )
    # Normalize whitespace incl. non-breaking spaces
    job_name = header_el.text.replace('\xa0', ' ').strip()
    job_name = re.sub(r'\s+', ' ', job_name)

    # Description
    desc_el = WebDriverWait(driver, timeout).until(
        EC.visibility_of_element_located((By.CSS_SELECTOR, '[data-automation-id="jobPostingDescription"]'))
    )
    job_description_text = re.sub(r'\n{3,}', '\n\n', (desc_el.text or '')).strip()

    return job_name, job_description_text
