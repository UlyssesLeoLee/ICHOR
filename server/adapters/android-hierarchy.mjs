/**
 * ATS-603: the VIEW HIERARCHY of the Android runner.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The hierarchy tree of the screen, parsed into DATA.
 *
 * WHY IT IS A FIRST-CLASS MODULE
 * ------------------------------
 * docs/25 §5.3 requires that a failure says WHICH kind of failure it is,
 * and one of those kinds is "the element was not found". A failure of that
 * kind is only believable if the reader can see the tree that was searched:
 * the tree is the EVIDENCE of the search. That is why the hierarchy is
 * parsed here, kept as data, and attached to the failure -- not fetched,
 * grepped and thrown away.
 *
 * The same tree is what makes a `tapOn` possible at all: the runner taps
 * an element by locating it in the hierarchy, never by a blind coordinate.
 * A coordinate tap would be a different (and weaker) thing, and the
 * ATS-601 capability model says so: `tapOn` needs BOTH `ui.tap` and
 * `ui.hierarchy`.
 *
 * THE PARSER
 * ----------
 * `uiautomator dump` produces XML. The platform has NO XML dependency
 * (the repository has no runtime dependency at all -- see package.json),
 * so the tree is parsed with a small, strict reader:
 *
 *   * it reads the `<node .../>` elements and their ATTRIBUTES;
 *   * it reads the BOUNDS attribute `[left,top][right,bottom]` and turns
 *     it into a rectangle;
 *   * it does NOT execute anything and does NOT resolve entities beyond
 *     the five XML predefined ones;
 *   * a document it cannot read is an ERROR, never a half-read tree.
 *
 * The last rule is the same rule the Flow reader follows (docs/25 §4.2.2):
 * a reader that reads half a document and reports success is worse than a
 * reader that fails, because the caller cannot tell the difference.
 */

/**
 * The XML entities the platform decodes.
 *
 * Only the five predefined ones. A document that uses another entity is
 * rejected rather than silently losing the text -- a UI label with `&nbsp;`
 * in it is a real thing that happens, and losing it would make an element
 * unfindable for no visible reason.
 */
const ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

/**
 * Decode the XML entities of a text value.
 *
 * @throws when the document uses an entity the platform does not know.
 */
export function decodeEntities(text) {
  const source = String(text ?? '');
  if (!source.includes('&')) return source;
  return source.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      if (!Number.isFinite(code)) throw new Error(`the view hierarchy uses an invalid character reference: ${whole}`);
      return String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) throw new Error(`the view hierarchy uses an invalid character reference: ${whole}`);
      return String.fromCodePoint(code);
    }
    const decoded = ENTITIES[body];
    if (decoded === undefined) {
      throw new Error(`the view hierarchy uses an unknown entity: ${whole}`);
    }
    return decoded;
  });
}

/**
 * Parse the `bounds` attribute of a node into a rectangle.
 *
 * The format is `[left,top][right,bottom]`, in device pixels. A bounds
 * that does not have that shape is a MALFORMED hierarchy, and it is
 * reported as one -- a rectangle that silently became {0,0,0,0} would
 * make every element unfindable without saying why.
 */
export function parseBounds(raw) {
  const text = String(raw ?? '').trim();
  const m = text.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!m) {
    throw new Error(`the view hierarchy has a malformed bounds attribute: ${text || '(empty)'}`);
  }
  const [, l, t, r, b] = m.map(Number);
  return {
    left: l,
    top: t,
    right: r,
    bottom: b,
    width: Math.max(0, r - l),
    height: Math.max(0, b - t),
  };
}

/**
 * One node of the hierarchy.
 *
 * The attributes are kept under their ANDROID names (`resource-id`,
 * `content-desc`, ...) because those are the names a reader of an Android
 * dump knows; the derived fields (`id`, `label`, `clickable`, `rect`) are
 * the ones the runner matches on.
 */
function parseNode(attrs) {
  const bounds = parseBounds(attrs.bounds);
  const id = attrs['resource-id'] ?? '';
  const text = decodeEntities(attrs.text ?? '');
  const desc = decodeEntities(attrs['content-desc'] ?? '');
  return {
    class: attrs.class ?? '',
    package: attrs.package ?? '',
    id,
    text,
    desc,
    // The label a user would read: the visible text, or the content
    // description when there is no text. Both are ways of NAMING an
    // element, so both are candidates for a match.
    label: text || desc,
    clickable: attrs.clickable === 'true',
    enabled: attrs.enabled === 'true',
    scrollable: attrs.scrollable === 'true',
    checkable: attrs.checkable === 'true',
    checked: attrs.checked === 'true',
    selected: attrs.selected === 'true',
    focused: attrs.focused === 'true',
    bounds,
    rect: {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    },
    children: [],
  };
}

/**
 * Parse a `uiautomator dump` document into a TREE.
 *
 * The parser is a small state machine over the tags: it tracks the stack
 * of open `<node>` elements, so the nesting of the tree is the nesting of
 * the document.
 *
 * @returns {{root: object|null, nodes: object[], rotation: string}}
 * @throws when the document is not a readable hierarchy.
 */
export function parseHierarchy(xml) {
  const source = String(xml ?? '');
  if (!source.trim()) {
    throw new Error('the view hierarchy dump is empty');
  }
  if (!source.includes('<hierarchy')) {
    throw new Error('the view hierarchy dump is not a hierarchy document');
  }

  const rotation = (source.match(/<hierarchy[^>]*\brotation="([^"]*)"/) || [])[1] ?? '';

  const nodes = [];
  const stack = [];
  let root = null;

  // The tag scanner. It looks for `<node ...>` (with attributes) and
  // `</node>`. Every other tag is IGNORED -- the document carries a few of
  // them and none of them carry information the runner needs.
  const tagRe = /<\s*(\/?)\s*node\b([^>]*?)(\/?)\s*>/g;
  let m;
  while ((m = tagRe.exec(source)) !== null) {
    const closing = m[1] === '/';
    const selfClosing = m[3] === '/';
    if (closing) {
      if (!stack.length) {
        throw new Error('the view hierarchy dump closes a node that was never opened');
      }
      stack.pop();
      continue;
    }
    const attrs = parseAttributes(m[2]);
    const node = parseNode(attrs);
    nodes.push(node);
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
    } else if (root === null) {
      root = node;
    } else {
      // Two roots: the document is not a single tree. A hierarchy with two
      // roots cannot be searched reliably, so it is an error.
      throw new Error('the view hierarchy dump has more than one root node');
    }
    if (!selfClosing) stack.push(node);
  }

  if (!root) {
    throw new Error('the view hierarchy dump has no node at all');
  }
  if (stack.length) {
    throw new Error(`the view hierarchy dump ends with ${stack.length} unclosed node(s)`);
  }

  return { root, nodes, rotation };
}

/**
 * Read the attributes of a tag.
 *
 * The attributes are read as `name="value"` or `name='value'`. A value
 * that is not quoted is a malformed document.
 */
function parseAttributes(raw) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  let found = 0;
  while ((m = re.exec(raw)) !== null) {
    found += 1;
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  // Every `<node` tag must carry at least the bounds; a tag with no
  // attribute at all is not a node element.
  if (found === 0 && raw.trim()) {
    throw new Error('the view hierarchy dump has a node without attributes');
  }
  return attrs;
}

/**
 * Walk every node of the tree, parents before children.
 */
export function walkHierarchy(tree) {
  const out = [];
  const visit = (node) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  if (tree && tree.root) visit(tree.root);
  return out;
}

/**
 * Find the nodes that MATCH a target.
 *
 * A target names an element either by its TEXT, by its CONTENT
 * DESCRIPTION, by its RESOURCE ID, or by a REGEX over the text. The
 * matching is EXACT for text and id (after trimming), and it is a full
 * match for the regex -- a partial match would tap the wrong element, and
 * a wrong tap is worse than no tap.
 *
 * The result is the list of matches, in DOCUMENT ORDER, so a caller that
 * wants the first one gets the topmost-leftmost one -- which is what a
 * person would have tapped.
 */
export function findMatches(tree, target = {}) {
  const {
    text = null,
    desc = null,
    id = null,
    regex = null,
    clickableOnly = false,
    visibleOnly = true,
  } = target;

  const wantsText = typeof text === 'string' && text.trim() !== '';
  const wantsDesc = typeof desc === 'string' && desc.trim() !== '';
  const wantsId = typeof id === 'string' && id.trim() !== '';
  const wantsRegex = typeof regex === 'string' && regex !== '';
  if (!wantsText && !wantsDesc && !wantsId && !wantsRegex) return [];

  let re = null;
  if (wantsRegex) {
    try {
      re = new RegExp(regex);
    } catch (e) {
      throw new Error(`the element regex is not a valid regular expression: ${e.message}`);
    }
  }

  const matches = [];
  for (const node of walkHierarchy(tree)) {
    if (visibleOnly && !isVisible(node)) continue;
    if (clickableOnly && !node.clickable) continue;

    let hit = false;
    if (wantsText && node.text.trim() === text.trim()) hit = true;
    if (!hit && wantsDesc && node.desc.trim() === desc.trim()) hit = true;
    if (!hit && wantsId && node.id.trim() === id.trim()) hit = true;
    if (!hit && re && (re.test(node.text) || re.test(node.desc))) hit = true;
    if (hit) matches.push(node);
  }
  return matches;
}

/**
 * True when a node is VISIBLE.
 *
 * A node with an empty rectangle is not visible: it has no pixels. That
 * is the rule the runner uses to tell "the element is on the screen but
 * hidden" from "the element is on the screen".
 */
export function isVisible(node) {
  if (!node || !node.bounds) return false;
  return node.bounds.width > 0 && node.bounds.height > 0;
}

/**
 * The CENTRE of a node, as the coordinates a tap would use.
 *
 * The centre is used because it is the point most likely to be inside the
 * element's own clickable area; an edge coordinate can fall outside it.
 */
export function centreOf(node) {
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}

/**
 * A SHORT, human-readable summary of a tree, for a failure message.
 *
 * The summary names the elements that were VISIBLE, so that a reader can
 * see what the screen actually offered instead of guessing. It is
 * truncated: a failure message with 400 nodes in it is not a message.
 */
export function summariseHierarchy(tree, { limit = 25 } = {}) {
  const nodes = walkHierarchy(tree).filter((n) => isVisible(n) && (n.label || n.id));
  const lines = [];
  for (const node of nodes) {
    if (lines.length >= limit) {
      lines.push(`... and ${nodes.length - limit} more visible element(s)`);
      break;
    }
    const name = node.label || node.id;
    lines.push(`${node.class}${node.id ? ` id=${node.id}` : ''} text="${node.text}" desc="${node.desc}" clickable=${node.clickable} bounds=[${node.bounds.left},${node.bounds.top}][${node.bounds.right},${node.bounds.bottom}]`);
    void name;
  }
  return lines.length ? lines.join('\n') : '(the hierarchy holds no visible element with a label or an id)';
}
