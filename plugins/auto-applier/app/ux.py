# app/ux.py
import time
import unicodedata

from selenium.common.exceptions import (ElementClickInterceptedException,
                                        StaleElementReferenceException,
                                        TimeoutException)
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait as W

import app.path as loc


# Words that begin half the institutions in France, so useless as a search on
# their own.
_GENERIC_NAME_WORDS = frozenset((
    "universite", "university", "ecole", "institut", "school", "college",
    "centre", "center", "national", "nationale", "superieur", "superieure",
    "des", "les", "sciences", "technologies", "technologie",
))


def search_queries(wanted: str) -> list:
    """What to type into a searchable multiselect, most specific first.

    Boards word the same institution differently, so the full string often
    finds nothing and the query has to be shortened. Leading-word prefixes
    alone are not enough: "UNIVERSITE TOULOUSE III - PAUL SABATIER" shortens to
    "universite", which is both useless and, on Accenture's school box,
    answered with an empty list. The distinctive words live at the END of the
    name, so they are also tried individually, longest first.
    """
    words = [w for w in _fold(wanted).split() if len(w) > 2]
    queries = [str(wanted)]
    for size in (3, 2, 1):
        if len(words) >= size:
            queries.append(" ".join(words[:size]))
    queries.extend(sorted(
        (w for w in words if len(w) > 3 and w not in _GENERIC_NAME_WORDS),
        key=len, reverse=True))

    seen, tries = set(), []
    for q in queries:
        if q.casefold() not in seen:
            seen.add(q.casefold())
            tries.append(q)
    return tries


def _fold(text: str) -> str:
    """Casefolded and accent-stripped, for comparing option labels.

    Boards word the same institution differently - Airbus offers "UNIVERSITE
    TOULOUSE III - PAUL SABATIER", Accenture "Universite Toulouse 3 Paul
    Sabatier". Comparing raw text matched neither (2026-08-22).
    """
    norm = unicodedata.normalize("NFKD", text or "")
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    return " ".join(norm.casefold().replace("-", " ").split())


class FieldWriteError(RuntimeError):
    """A field could not be set to the intended value."""


# React keeps its own copy of an input's state and re-applies it after a naive
# clear(), so the old text survives and send_keys appends to it. Setting the
# value through the *native* prototype setter and then firing an input event is
# the documented way to make React notice the change.
_REACT_CLEAR_JS = """
const el = arguments[0];
const proto = el instanceof window.HTMLTextAreaElement
  ? window.HTMLTextAreaElement.prototype
  : window.HTMLInputElement.prototype;
const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
setter.call(el, '');
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
"""


def _norm(s: str) -> str:
    return " ".join((s or "").split())


class UX:
    def __init__(self, driver, timeout: int, micro_wait: float):
        self.d = driver
        self.timeout = timeout
        self.micro = micro_wait

    # -- lookups -----------------------------------------------------------

    def find(self, xpath: str):
        return W(self.d, self.timeout).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        )

    def find_all(self, xpath: str) -> list:
        """Every match, or [] straight away.

        Unlike find(), this never waits out the timeout, so it is safe for
        asking "is this on the page?" rather than "wait for this to appear".
        """
        try:
            return self.d.find_elements(By.XPATH, xpath)
        except Exception:
            return []

    def exists(self, xpath: str) -> bool:
        return bool(self.find_all(xpath))

    def visible(self, xpath: str) -> bool:
        """Whether any match is actually on screen.

        exists() is not enough: find_elements() happily returns display:none
        elements, and Workday leaves a dropdown's options in the DOM while the
        list is shut. Waiting for one of those to become clickable burns the
        whole timeout on a list nobody ever opened.
        """
        for el in self.find_all(xpath):
            try:
                if el.is_displayed():
                    return True
            except Exception:
                continue
        return False

    def wait_visible(self, xpath: str, timeout: float | None = None) -> bool:
        """Whether a match becomes visible within `timeout`. Never raises.

        visible() is an instantaneous check, not a wait, so asking it about a
        control the page has not drawn yet always answers no. SuccessFactors
        re-renders the whole form after every upload, which makes "is it there
        yet" the wrong question and "is it there within N seconds" the right
        one. Mirrors Playwright's waitFor({state:'visible'}), which is what the
        Capgemini flow was written against.
        """
        deadline = time.time() + (self.timeout if timeout is None else timeout)
        while True:
            if self.visible(xpath):
                return True
            if time.time() >= deadline:
                return False
            time.sleep(0.2)

    def click_if_present(self, xpath: str) -> bool:
        """Click only when already on the page. Returns whether it clicked."""
        els = self.find_all(xpath)
        if not els:
            return False
        try:
            self.click(xpath)
            return True
        except Exception:
            return False

    # -- interaction -------------------------------------------------------

    # Workday renders some buttons - the sign-in submit among them - as an
    # aria-hidden element sitting *behind* a transparent overlay div
    # (data-automation-id="click_filter", role="button"). The overlay carries
    # the real handler, so a click on the button underneath is swallowed: the
    # page reports no error and simply does nothing. Clicking whatever actually
    # sits at the button's centre point is what makes those buttons work.
    # Not every intercepting element is a stand-in for the one underneath. A
    # sticky page footer also intercepts, but clicking *it* does nothing useful
    # - that case wants a scroll and a retry instead. So only report a blocker
    # that genuinely proxies for the target: Workday's click_filter, or an
    # element covering exactly the same box.
    _ELEMENT_AT_CENTRE_JS = """
const el = arguments[0];
const r = el.getBoundingClientRect();
const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
const h = hit.getBoundingClientRect();
const sameBox = Math.abs(h.left - r.left) < 4 && Math.abs(h.top - r.top) < 4
             && Math.abs(h.width - r.width) < 4 && Math.abs(h.height - r.height) < 4;
if (hit.getAttribute('data-automation-id') === 'click_filter') return hit;
return sameBox ? hit : null;
"""

    def _blocker_over(self, el):
        """The element standing in for `el` in the click, or None.

        None means "something is in the way but it is not a proxy" - the caller
        should scroll and retry rather than click the obstruction.
        """
        try:
            return self.d.execute_script(self._ELEMENT_AT_CENTRE_JS, el)
        except Exception:
            return None

    def click(self, xpath: str):
        el = W(self.d, self.timeout).until(
            EC.element_to_be_clickable((By.XPATH, xpath))
        )
        self.d.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        time.sleep(self.micro)
        for attempt in (1, 2):
            try:
                el.click()
                time.sleep(self.micro)
                return el
            except StaleElementReferenceException:
                el = self.find(xpath)
                self.d.execute_script(
                    "arguments[0].scrollIntoView({block:'center'});", el)
                time.sleep(self.micro)
            except ElementClickInterceptedException:
                blocker = self._blocker_over(el)
                if blocker is not None:
                    blocker.click()
                    time.sleep(self.micro)
                    return el
                if attempt == 2:
                    # Last resort. A synthetic click reaches only handlers bound
                    # to the element itself, so it is a no-op against the
                    # overlay pattern above - hence trying the overlay first.
                    self.d.execute_script("arguments[0].click();", el)
                    time.sleep(self.micro)
                    return el

    def choose_option(self, button_xpath: str, option_xpath: str,
                      attempts: int = 3, settle_s: float = 5.0):
        """Open a Workday dropdown and pick one of its options.

        Opening is not reliable on the first try: the click is ignored when it
        lands before React has attached its handler, and the run then waits out
        the full timeout on an option that never appears. Verified live on
        2026-08-19, where the same posting worked on one run and timed out on
        the next.

        Reopening is harmless, so retry - but only when the list is actually
        shut. Clicking the button while the list is open closes it again.
        """
        for attempt in range(1, attempts + 1):
            if self.visible(option_xpath):
                break
            self.click(button_xpath)
            deadline = time.time() + settle_s
            while time.time() < deadline and not self.visible(option_xpath):
                time.sleep(0.3)
            if self.visible(option_xpath):
                break
            if attempt < attempts:
                print(f"[ux] dropdown did not open (attempt {attempt}); retrying")
        return self.click(option_xpath)

    def search_and_pick(self, input_xpath: str, wanted: str,
                        settle_s: float = 6.0) -> str:
        """Type into a searchable multiselect and pick the matching option.

        Typing alone leaves the box empty: the visible input is only a search
        field, and Workday records nothing until an option is clicked. That
        looked like success - the value went in and the code moved on - and
        then the page refused with "The field School or University is required
        and must have a value" (Accenture, 2026-08-21).
        """
        # Search with progressively shorter queries. The full string finds
        # nothing on some boards - typing "UNIVERSITE TOULOUSE III - PAUL
        # SABATIER" into Accenture's school box returned an empty list, because
        # their entry is worded differently - while "Toulouse" finds it.
        tries = search_queries(wanted)

        options = []
        for query in tries:
            self.type(input_xpath, query)
            time.sleep(1.0)
            deadline = time.time() + settle_s
            while time.time() < deadline:
                options = [e for e in self.find_all(loc.dropdown_options_any)
                           if self._displayed(e)]
                if options:
                    break
                time.sleep(0.4)
            if options:
                break
            print(f"[search] {query!r} offered nothing; trying a shorter query")

        texts = [" ".join((e.text or "").split()) for e in options]
        folded = _fold(wanted)
        # Match on the distinctive words rather than the whole string: the
        # same university is written "III" on one board and "3" on another.
        keywords = [w for w in folded.split() if len(w) > 3][:3]

        def scores(text):
            f = _fold(text)
            return (f == folded,
                    f.startswith(folded[:20]),
                    bool(keywords) and all(k in f for k in keywords))

        for rank in range(3):
            for el, text in zip(options, texts):
                if scores(text)[rank]:
                    el.click()
                    time.sleep(self.micro)
                    return text
        raise FieldWriteError(
            f"Typed {wanted!r} but no option matched. Offered: {texts[:8]}")

    def choose_option_by_text(self, button_xpath: str, wanted: str,
                              option_xpath: str = loc.dropdown_options_any,
                              attempts: int = 3, settle_s: float = 5.0):
        """Open a dropdown and pick the option matching `wanted`.

        Exact-text matching is too brittle for real questionnaires: the answer
        "No" is offered as "No, I am not a beneficiary of the OETH", so an
        exact locator waits out the whole timeout on an option that does not
        exist. Prefer an exact hit, fall back to a prefix match, and if neither
        lands, say what was actually on offer instead of raising a bare
        TimeoutException.
        """
        options = []
        for attempt in range(1, attempts + 1):
            options = [e for e in self.find_all(option_xpath)
                       if self._displayed(e)]
            if len(options) > 1:
                break
            self.click(button_xpath)
            deadline = time.time() + settle_s
            while time.time() < deadline:
                options = [e for e in self.find_all(option_xpath)
                           if self._displayed(e)]
                if len(options) > 1:
                    break
                time.sleep(0.3)
            if len(options) > 1:
                break

        texts = [" ".join((e.text or "").split()) for e in options]
        want = " ".join(str(wanted).split()).casefold()

        for el, text in zip(options, texts):
            if text.casefold() == want:
                el.click()
                time.sleep(self.micro)
                return text
        # Prefix, but only when it picks out one option. Accenture's AI-consent
        # answers both start "I understand and I'm ready to continue with...",
        # so taking the first prefix hit recorded the opposite of the
        # candidate's consent - the ambiguity has to fail, not resolve itself.
        prefixed = [(el, text) for el, text in zip(options, texts)
                    if text.casefold().startswith(want)]
        if len(prefixed) == 1:
            el, text = prefixed[0]
            el.click()
            time.sleep(self.micro)
            return text
        if len(prefixed) > 1:
            raise FieldWriteError(
                f"{wanted!r} matches {len(prefixed)} options, so it is "
                f"ambiguous: {[t for _, t in prefixed]}")

        # Last resort: a substring, but only when exactly one option contains
        # it. Accenture's AI-consent answers are "...continue with my
        # application involving artificial intelligence" and "...continue
        # without my application...", which share a long prefix - a prefix
        # match would silently pick whichever came first, and picking the wrong
        # one records the opposite of the candidate's consent. Requiring a
        # unique hit makes the ambiguous case fail loudly instead.
        contains = [(el, text) for el, text in zip(options, texts)
                    if want in text.casefold()]
        if len(contains) == 1:
            el, text = contains[0]
            el.click()
            time.sleep(self.micro)
            return text
        if len(contains) > 1:
            raise FieldWriteError(
                f"{wanted!r} matches {len(contains)} options, so it is "
                f"ambiguous: {[t for _, t in contains]}")

        raise FieldWriteError(
            f"No option matching {wanted!r}. The dropdown offered: {texts}")

    def _displayed(self, el) -> bool:
        try:
            return el.is_displayed()
        except Exception:
            return False

    def value_of(self, el) -> str:
        """Current text of a field, for inputs, textareas and editable divs."""
        try:
            v = el.get_attribute("value")
            if v is not None:
                return v
        except Exception:
            pass
        try:
            return el.get_attribute("textContent") or ""
        except Exception:
            return ""

    def _clear(self, el, strategy: int) -> None:
        if strategy == 0:
            el.clear()
        elif strategy == 1:
            # Real key events: React sees these even when it ignores clear().
            el.send_keys(Keys.CONTROL, "a")
            el.send_keys(Keys.DELETE)
        else:
            self.d.execute_script(_REACT_CLEAR_JS, el)

    def type(self, xpath: str, text: str, verify: bool = True,
             secret: bool = False):
        """Set a field to `text`, replacing whatever is there.

        Never appends. With "Use My Last Application" turned on these fields
        arrive prefilled, and a clear() that silently no-ops would leave the old
        value with the new text stuck onto the end.

        Pass secret=True for passwords: the value is then kept out of the error
        message, which would otherwise print the credential on failure.
        """
        el = self.find(xpath)
        self.d.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        time.sleep(self.micro)

        last_seen = None
        # Clearing strategies, hardest last. The final repeat is a retry slot:
        # React can re-render the field mid-write and invalidate the element,
        # which is not a failure - it just means starting the pass again.
        for strategy in (0, 1, 2, 2):
            el = self.find(xpath)
            try:
                self._clear(el, strategy)
                el.send_keys(text)
            except StaleElementReferenceException:
                continue
            except Exception:
                continue

            time.sleep(self.micro)

            if not verify:
                return el

            last_seen = self.value_of(el)
            if _norm(last_seen) == _norm(text):
                return el
            # Wrong content: fall through and clear harder on the next pass.

        wanted = "<hidden>" if secret else repr(text)
        got = "<hidden>" if secret else repr(last_seen)
        raise FieldWriteError(
            f"Could not set field {xpath} to {wanted}; it reads {got}. "
            "Refusing to continue rather than submit doubled-up text."
        )
