"""
Wizard inspector: dump every form control on the current Workday page.

Stage 1 problem: regular postings use different questionnaires than the trainee
one the old code hardcoded (sampling France/regular shows ~3 variants plus a
no-questionnaire path). We cannot write correct handlers for forms we have
never seen, and the questions are only visible behind a logged-in session.

So: record first. This walks the live DOM and writes a JSON snapshot of every
field — id, label, type, options, current value — which is exactly what is
needed to write real handlers afterwards.

Nothing here clicks, types, or submits. It only reads.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

# Gathered in one execute_script call: hundreds of Selenium round-trips for a
# busy Workday page is painfully slow, one JS pass is instant.
_COLLECT_JS = r"""
const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;

function textOf(node) {
  if (!node) return '';
  return (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
}

function labelText(el) {
  if (el.id) {
    const l = document.querySelector('label[for="' + esc(el.id) + '"]');
    const t = textOf(l);
    if (t) return t;
  }
  const ariaBy = el.getAttribute('aria-labelledby');
  if (ariaBy) {
    const parts = ariaBy.split(/\s+/)
      .map(id => textOf(document.getElementById(id)))
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();

  // Climb to the enclosing Workday form field and take its label element.
  // Prefix match: the real wrappers are formField-school, formField-degree,
  // formField-language ... an exact "formField" match never hits any of them.
  const group = el.closest('[data-automation-id^="formField"], [role="group"], fieldset');
  if (group) {
    const lab = group.querySelector('label, legend, [data-automation-id="formLabel"]');
    const t = textOf(lab);
    if (t) return t;
  }
  return '';
}

function optionsOf(el) {
  if (el.tagName === 'SELECT') {
    return Array.from(el.options).map(o => o.textContent.trim()).filter(Boolean);
  }
  // Workday dropdowns are buttons that open a listbox elsewhere in the DOM;
  // options are only in the DOM once opened, so we cannot list them here.
  return [];
}

const SEL = [
  'input', 'select', 'textarea',
  'button[aria-haspopup]',
  '[role="listbox"]', '[role="radiogroup"]', '[role="combobox"]'
].join(', ');

const seen = new Set();
const fields = [];

document.querySelectorAll(SEL).forEach(el => {
  if (seen.has(el)) return;
  seen.add(el);

  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'hidden') return;

  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const visible = !!(rect.width || rect.height) &&
                  style.visibility !== 'hidden' && style.display !== 'none';

  // File inputs are deliberately hidden by Workday but we still drive them.
  const isFile = type === 'file';
  if (!visible && !isFile) return;

  // Workday plants a hidden "for robots only" input to catch bots that fill
  // in everything. Flag it so nothing ever writes to it.
  const autoId = el.getAttribute('data-automation-id') || '';
  const isHoneypot = autoId === 'beecatcher' ||
    /robots only/i.test(labelText(el));

  fields.push({
    honeypot: isHoneypot,
    tag: el.tagName.toLowerCase(),
    type: type || null,
    id: el.id || null,
    name: el.getAttribute('name') || null,
    automation_id: el.getAttribute('data-automation-id') || null,
    role: el.getAttribute('role') || null,
    label: labelText(el),
    value: (el.value !== undefined && type !== 'file') ? String(el.value).slice(0, 200) : null,
    checked: (type === 'radio' || type === 'checkbox') ? el.checked : null,
    required: el.required || el.getAttribute('aria-required') === 'true',
    button_text: el.tagName === 'BUTTON' ? textOf(el) : null,
    options: optionsOf(el),
    // e.g. "multiselect" - School or University looks like a text input but is
    // a lookup that only accepts values chosen from its own results.
    widget_type: el.closest('[data-uxi-widget-type]')
      ? el.closest('[data-uxi-widget-type]').getAttribute('data-uxi-widget-type')
      : null,
    visible: visible
  });
});

// Clickable controls, so we know what advances the wizard. Plain <a> counts:
// Workday renders Apply and Continue Application as bare anchors, so a
// 'button, a[role=button]' selector misses exactly the ones we care about.
const actions = Array.from(document.querySelectorAll('button, a, [role="button"]'))
  .filter(b => {
    const r = b.getBoundingClientRect();
    return (r.width || r.height);
  })
  .map(b => ({
    tag: b.tagName.toLowerCase(),
    text: textOf(b).slice(0, 80),
    href: b.getAttribute('href') || null,
    automation_id: b.getAttribute('data-automation-id') || null,
    disabled: b.disabled === true
  }))
  .filter(a => a.text);

// Attachments: which files the page already lists, plus the raw text of the
// group, so the real markup is visible even when every guessed selector misses.
const ATTACH_NAME_SELECTORS = [
  '[data-automation-id="file-preview-name"]',
  '[data-automation-id="filePreview"] [data-automation-id="promptOption"]',
  '[data-automation-id="attachments-FileUpload"] [role="listitem"]'
];
const attachGroup = document.querySelector(
  'div[role="group"][aria-labelledby="Application-attachments-section"]'
) || document.querySelector('[data-automation-id="attachments-FileUpload"]');

const attachments = {
  group_found: !!attachGroup,
  delete_buttons: document.querySelectorAll(
    'button[data-automation-id="delete-file"]').length,
  by_selector: {},
  group_text: attachGroup ? textOf(attachGroup).slice(0, 600) : null
};
ATTACH_NAME_SELECTORS.forEach(sel => {
  attachments.by_selector[sel] =
    Array.from(document.querySelectorAll(sel)).map(e => textOf(e)).filter(Boolean);
});

// What actually receives a click aimed at each control. Workday hides some
// buttons behind a transparent <div data-automation-id="click_filter"> that
// carries the real handler; a click on the button underneath is swallowed with
// no error at all. That cost hours to find by hand - recorded here it is
// obvious on sight.
const obstructions = [];
document.querySelectorAll('button, a, [role="button"], input, select, textarea')
  .forEach(el => {
    const r = el.getBoundingClientRect();
    if (!(r.width || r.height)) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return;
    obstructions.push({
      target: el.getAttribute('data-automation-id') || el.id || textOf(el).slice(0, 40),
      target_tag: el.tagName.toLowerCase(),
      target_aria_hidden: el.getAttribute('aria-hidden') === 'true',
      blocker: hit.getAttribute('data-automation-id') || hit.id
               || (typeof hit.className === 'string' ? hit.className : ''),
      blocker_tag: hit.tagName.toLowerCase(),
      blocker_role: hit.getAttribute('role') || null
    });
  });

const heading = textOf(document.querySelector('h1, h2, [data-automation-id="pageHeader"]'));

// Progress bar steps, if Workday rendered one.
const steps = Array.from(
  document.querySelectorAll('[data-automation-id="progressBar"] li, [role="navigation"] li')
).map(li => textOf(li)).filter(Boolean);

return {
  url: window.location.href,
  title: document.title,
  heading: heading,
  steps: steps,
  fields: fields,
  actions: actions,
  attachments: attachments,
  obstructions: obstructions
};
"""


def snapshot_page(driver) -> dict[str, Any]:
    """Read every form control on whatever page the driver is currently on."""
    data = driver.execute_script(_COLLECT_JS)
    data["captured_at"] = datetime.now().isoformat(timespec="seconds")
    data["questionnaire_ids"] = sorted(_questionnaire_ids(data.get("fields", [])))
    return data


def _questionnaire_ids(fields: list[dict]) -> set[str]:
    """Pull the Workday questionnaire uuid out of element ids.

    Workday names questionnaire controls `primaryQuestionnaire--<uuid>`. The
    uuid's leading 16 hex chars identify the questionnaire itself, which is how
    we know the old hardcoded ids belonged to the trainee form.
    """
    out: set[str] = set()
    for f in fields:
        fid = f.get("id") or ""
        if "Questionnaire--" in fid:
            suffix = fid.split("Questionnaire--", 1)[1]
            if len(suffix) >= 16:
                out.add(suffix[:16])
    return out


def describe(snap: dict[str, Any]) -> str:
    """Human-readable summary, printed while a run is in progress."""
    lines = [
        f"  page:  {snap.get('heading') or snap.get('title')}",
        f"  url:   {snap.get('url')}",
    ]
    if snap.get("questionnaire_ids"):
        lines.append(f"  questionnaire: {', '.join(snap['questionnaire_ids'])}")
    att = snap.get("attachments") or {}
    if att.get("group_found"):
        names = []
        for found in (att.get("by_selector") or {}).values():
            names.extend(found)
        lines.append(f"  attachments: {att.get('delete_buttons', 0)} delete button(s)"
                     + (f", names: {', '.join(names)}" if names else ", no names read"))
    fields = snap.get("fields", [])
    lines.append(f"  {len(fields)} field(s):")
    for f in fields:
        bits = [f.get("tag")]
        if f.get("type"):
            bits.append(f["type"])
        ident = f.get("automation_id") or f.get("id") or f.get("name") or "?"
        label = f.get("label") or f.get("button_text") or ""
        flag = " *required" if f.get("required") else ""
        if f.get("honeypot"):
            flag += " !!HONEYPOT - never fill"
        lines.append(f"    - [{'/'.join(b for b in bits if b)}] {ident}"
                     f"{(' — ' + label) if label else ''}{flag}")
    return "\n".join(lines)


def save_page_html(driver, out_dir: Path, tag: str = "") -> dict[str, Path]:
    """Write the raw page source and a screenshot beside the JSON snapshot.

    The JSON is a summary, and summaries hide exactly the things that go wrong:
    the click_filter overlay, the multiselect wrapper around what looks like a
    text input, an id that is not the automation id. Every real defect found on
    2026-08-19 came out of raw markup, so keep it.

    Returns the paths written; failures are reported, never raised - capturing
    diagnostics must not be able to break a run.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"{stamp}_{tag}" if tag else stamp
    written: dict[str, Path] = {}

    html_path = out_dir / f"{base}.html"
    try:
        html_path.write_text(driver.page_source, encoding="utf-8")
        written["html"] = html_path
    except Exception as e:
        print(f"[inspect] could not save HTML: {type(e).__name__}")

    png_path = out_dir / f"{base}.png"
    try:
        driver.save_screenshot(str(png_path))
        written["png"] = png_path
    except Exception as e:
        print(f"[inspect] could not save screenshot: {type(e).__name__}")

    return written


def describe_obstructions(snap: dict[str, Any]) -> str:
    """Report controls whose clicks would land on something else."""
    obs = snap.get("obstructions") or []
    if not obs:
        return ""
    lines = [f"  {len(obs)} obstructed control(s):"]
    for o in obs[:12]:
        hidden = " aria-hidden" if o.get("target_aria_hidden") else ""
        lines.append(f"    - {o.get('target')}{hidden} "
                     f"-> click lands on {o.get('blocker_tag')} "
                     f"'{o.get('blocker')}'")
    return "\n".join(lines)


def save_snapshots(snaps: list[dict], out_dir: Path, tag: str = "") -> Path:
    """Write a run's snapshots to a timestamped JSON file."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = f"{stamp}_{tag}.json" if tag else f"{stamp}.json"
    path = out_dir / name
    path.write_text(json.dumps(snaps, indent=2, ensure_ascii=False), encoding="utf-8")
    return path
