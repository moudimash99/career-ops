from pathlib import Path
from time import sleep
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import StaleElementReferenceException

def _abs(p): return str(Path(p).expanduser().resolve())

def upload_files_example(driver, files, timeout=10):
    wait = WebDriverWait(driver, timeout)

    # 1) Prefer the Application attachments group, but do not require it: the
    #    "Autofill with Resume" step has its own uploader and no such group,
    #    and scoping to it there fails with a bare TimeoutException.
    group = None
    try:
        group = WebDriverWait(driver, 3).until(EC.presence_of_element_located((
            By.CSS_SELECTOR,
            'div[role="group"][aria-labelledby="Application-attachments-section"]'
        )))
    except Exception:
        pass

    # 1b) If the page distinguishes a CV area from per-certification areas,
    #     use the CV one. Accenture lists the certification inputs first, so
    #     "the first file input" quietly attached the CV to a certification and
    #     left the required Resume upload empty.
    resume_input = None
    for el in driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]'):
        node = el
        for _ in range(10):
            if node is None or (node.tag_name or "").lower() == "html":
                node = None
                break
            try:
                node = node.find_element(By.XPATH, "..")
            except Exception:
                node = None
                break
            btns = node.find_elements(
                By.CSS_SELECTOR, 'button[data-automation-id="select-files"]')
            if btns:
                if (btns[0].get_attribute("id") or "").startswith("resumeAttachments"):
                    resume_input = el
                break
        if resume_input is not None:
            break

    # 2) Grab the real file input (don’t click the button)
    scope = group if group is not None else driver
    file_input = resume_input if resume_input is not None else wait.until(lambda _: scope.find_elements(
        By.CSS_SELECTOR, 'input[data-automation-id="file-upload-input-ref"]'
    ) and scope.find_element(
        By.CSS_SELECTOR, 'input[data-automation-id="file-upload-input-ref"]'
    ))

    # 3) Force-show it in case it’s CSS-hidden (so send_keys works)
    try:
        driver.execute_script("""
            arguments[0].style.display='block';
            arguments[0].style.visibility='visible';
            arguments[0].style.opacity=1;
            arguments[0].removeAttribute('hidden');
        """, file_input)
    except Exception:
        pass

    # 4) Send absolute paths (newline-separated if multiple is allowed)
    paths = "\n".join(_abs(p) for p in files)
    try:
        file_input.send_keys(paths)
    except StaleElementReferenceException:
        # React re-rendered; re-find and try once more
        sleep(0.2)
        file_input = scope.find_element(By.CSS_SELECTOR, 'input[data-automation-id="file-upload-input-ref"]')
        file_input.send_keys(paths)

    # 5) (Optional) wait for an uploaded item to appear / progress complete
    try:
        wait.until(EC.presence_of_element_located((
            By.CSS_SELECTOR, '[data-automation-id="attachments-FileUpload"] [role="listitem"], .css-10klw3m'
        )))
    except Exception:
        pass
