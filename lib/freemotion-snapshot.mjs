/**
 * freemotion-snapshot.mjs — parse a Playwright MCP `browser_snapshot`
 * accessibility tree into the flat field list every later Free Motion tier
 * reads.
 *
 * PURE. No browser, no network, no MCP call. `agy` owns the only browser in
 * the system and hands this module the snapshot text it already has (see
 * §1.5/§2.2 of docs/freemotion-implementation-plan.md); nothing here launches
 * or attaches to anything. That is what lets the whole parser be tested
 * against fixture strings with Playwright not installed.
 *
 * THE FORMAT, as actually emitted (verified against the real captures in
 * `.playwright-mcp/page-*.yml` in this checkout, not from the docs):
 *
 *   - generic [active] [ref=e1]:
 *     - textbox "First Name" [ref=f2e20]
 *     - group "Phone" [ref=f2e37]:
 *     - button "Toggle flyout" [ref=f2e52] [cursor=pointer]
 *     - textbox
 *     - link [ref=e433] [cursor=pointer]:
 *       - /url: https://example.com
 *       - text: apply via our internal career page
 *
 * Four properties of that format are load-bearing, and three of them are
 * easy to get wrong from the prose alone:
 *
 *   1. REFS CARRY A FRAME PREFIX. `f2e20`, not `e20`. Playwright MCP prefixes
 *      an element's ref with its frame id whenever the element lives inside an
 *      iframe — and the embedded Greenhouse form in
 *      `page-2026-08-22T12-55-20-058Z.yml` puts EVERY one of its 40+ fields
 *      behind `f2`. A ref pattern of `e\d+` therefore returns zero fields on
 *      precisely the sites Free Motion exists to fill (Greenhouse embeds,
 *      SuccessFactors, Workday), while still passing any fixture written by
 *      hand from the documentation. So the ref is matched as an opaque token
 *      and never parsed for structure.
 *   2. A LINE CAN DECLARE A ROLE AND NO REF. The bare `- textbox` above is
 *      real (it is the flyout's filter input, which MCP does not expose as an
 *      actionable element). Without a ref there is nothing `agy` could click
 *      or type into, so such a line is not a field and is dropped.
 *   3. A TRAILING COLON MEANS "HAS CHILDREN", NOT A DIFFERENT KIND OF NODE.
 *      `group "Phone" [ref=f2e37]:` and `button "Attach" [ref=f2e69]` are the
 *      same shape; the colon is YAML nesting punctuation and carries no
 *      meaning here.
 *   4. METADATA LINES (`- /url: …`, `- text: …`) share the leading `- ` with
 *      element lines but are not elements. `/url` fails the role pattern
 *      outright; `text` parses as a role and is dropped for not being fillable
 *      and having no ref.
 *
 * NEVER THROWS ON INPUT. A garbled, truncated, or empty snapshot returns `[]`
 * and a malformed line is skipped, because the caller is a long-running
 * autonomous applier: a parse error on one posting's odd page must cost that
 * posting, not the run. Every failure here is silent-by-design in exactly one
 * direction — fields can be MISSED (they then fall to Tier 2's model pass,
 * which is the designed escape hatch), never INVENTED.
 */

/**
 * Roles that can hold or receive a value, and are therefore worth handing to
 * the classifier.
 *
 * `button` is on the list even though it holds no value: the apply entry
 * point, "Attach", "Add another", and Submit itself are all buttons, and Tier
 * 1 needs to see them to build a fill plan that can advance the form.
 *
 * `generic`, `heading`, `paragraph`, `list`, `listitem`, `link` and `group`
 * are deliberately absent. They are containers — matching them would hand the
 * classifier the whole page instead of its form.
 */
export const FILLABLE_ROLES = [
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'button',
  'listbox', 'option', 'switch', 'spinbutton',
];

/**
 * One line of the tree, split into its parts.
 *
 * @typedef {Object} SnapshotField
 * @property {string} ref - MCP element ref, e.g. `"e84"` or `"f2e20"` when the
 *   element is inside a frame. Opaque; never empty (a line without one is not
 *   a field). Pass it back to MCP verbatim.
 * @property {string} role - Accessibility role, lowercased, e.g. `"textbox"`.
 * @property {string} name - Accessible name, `''` when the element has none.
 *   Quote escapes (`\"`) are unescaped.
 * @property {string[]} attrs - The other bracket attributes on the line, minus
 *   `ref=…`, in source order, e.g. `["cursor=pointer", "checked"]`.
 * @property {number} depth - 0-based indentation depth (2 spaces per level).
 *   Tier 1 uses this to find the container a set of fields shares.
 */

/**
 * One element line. Applied to the line with leading whitespace already
 * stripped, so `^` here means "after the indent".
 *
 * Groups: 1 role, 2 quoted name (may be absent), 3 the bracket run.
 *
 * The name alternation is `(?:[^"\\]|\\.)*` rather than `[^"]*` so a name
 * containing an escaped quote does not terminate the match early and drag the
 * rest of the line — including `[ref=…]` — into the name. Real accessible
 * names on these forms are whole sentences with apostrophes, colons and
 * question marks in them (see the Datadog capture's certification checkbox),
 * so this is not a theoretical case.
 */
const ELEMENT_LINE = /^-\s+([a-z][a-z0-9 ]*?)(?:\s+"((?:[^"\\]|\\.)*)")?\s*((?:\[[^\]]*\]\s*)*):?\s*$/;

/** One `[key=value]` or `[flag]` attribute. */
const ATTR = /\[([^\]]*)\]/g;

/**
 * Parse a `browser_snapshot` accessibility tree into its fillable fields.
 *
 * @param {string} snapshotText - Raw `browser_snapshot` output. Anything that
 *   is not a non-empty string yields `[]`.
 * @returns {SnapshotField[]} Every line that BOTH declares a `[ref=…]` AND has
 *   a role in {@link FILLABLE_ROLES}, in document order. Containers, metadata
 *   lines, ref-less elements and unparseable lines are dropped.
 */
export function parseAccessibilitySnapshot(snapshotText) {
  if (typeof snapshotText !== 'string' || snapshotText === '') return [];

  const fields = [];
  // Split on either line ending: these captures are written on Windows in this
  // checkout, and a stray \r would otherwise land inside the last attribute
  // and make every ref on every line unusable.
  for (const rawLine of snapshotText.split(/\r?\n/)) {
    // Tabs would make the /2 depth arithmetic meaningless. MCP emits spaces;
    // normalize anyway so a hand-written fixture cannot silently skew depth.
    const line = rawLine.replace(/\t/g, '  ');
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    if (body === '') continue;

    // YAML quotes a whole node when its text would otherwise be ambiguous —
    // in practice whenever the accessible name contains ": ". The MCP then
    // emits `- 'textbox "Email (Example: a@b.com)*" [ref=e1]':` and the
    // unquoted pattern below misses it ENTIRELY, so the field is dropped
    // rather than mis-parsed. Found live on VISEO's application form (#594
    // follow-up), where the silently-dropped field was the REQUIRED email:
    // a dropped field is never filled, never reported to Tier 2, and never
    // shows up as a validation failure until the employer sees the blank.
    let nodeBody = body;
    const quoted = /^-\s+'(.*)'\s*:?\s*$/.exec(body);
    if (quoted) nodeBody = `- ${quoted[1].replace(/''/g, "'")}`;

    const m = ELEMENT_LINE.exec(nodeBody);
    if (!m) continue;

    const role = m[1].trim().split(/\s+/)[0].toLowerCase();
    if (!FILLABLE_ROLES.includes(role)) continue;

    const bracketRun = m[3] || '';
    let ref = '';
    const attrs = [];
    ATTR.lastIndex = 0;
    let attr;
    while ((attr = ATTR.exec(bracketRun)) !== null) {
      const text = attr[1].trim();
      if (text === '') continue;
      if (text.startsWith('ref=')) {
        // First ref wins. A second one on the same line is malformed output;
        // taking the first keeps the behaviour deterministic either way.
        if (ref === '') ref = text.slice(4).trim();
        continue;
      }
      attrs.push(text);
    }

    // No ref, no field: there is nothing agy could address. See header note 2.
    if (ref === '') continue;

    fields.push({
      ref,
      role,
      name: m[2] === undefined ? '' : m[2].replace(/\\(.)/g, '$1'),
      attrs,
      depth: Math.floor(indent / 2),
    });
  }

  return fields;
}

export default parseAccessibilitySnapshot;
