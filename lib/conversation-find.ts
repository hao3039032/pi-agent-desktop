/** Whether the owning conversation can currently receive find shortcuts. */
export function isConversationFindActive(root: HTMLElement | null): root is HTMLElement {
  return Boolean(root && !root.closest('[inert], [hidden], [aria-hidden="true"]')
    && root.getClientRects().length && getComputedStyle(root).visibility !== "hidden");
}

/** Literal ranges in document order. Inline formatting is transparent; blocks,
 * line breaks and excluded controls are hard boundaries, not deleted text. */
export function findConversationRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, "giu");
  const ranges: Range[] = [];
  let nodes: Text[] = [];
  const flush = () => {
    // One contiguous inline run may span links, emphasis and syntax tokens.
    // Search original text with /iu rather than lowercasing: Unicode case
    // conversion can change string length and invalidate DOM offsets.
    const text = nodes.map((node) => node.data).join("");
    const offsets: number[] = [];
    let length = 0;
    for (const node of nodes) { offsets.push(length); length += node.length; }
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      // Translate the logical run's offsets back to the original text nodes;
      // no wrapping, innerHTML replacement or user-selection mutation is needed.
      const range = document.createRange();
      for (let i = 0; i < nodes.length; i++) {
        const offset = offsets[i];
        const next = offset + nodes[i].length;
        if (start >= offset && start < next) range.setStart(nodes[i], start - offset);
        if (end > offset && end <= next) { range.setEnd(nodes[i], end - offset); break; }
      }
      ranges.push(range);
    }
    nodes = [];
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { nodes.push(node as Text); return; }
    if (!(node instanceof HTMLElement)) { flush(); return; }
    // Excluded content is a boundary, not an empty string: otherwise text
    // before/after a control or <br> would create a match not visible on screen.
    if (node.matches('button, input, textarea, select, script, style, [aria-hidden="true"], [hidden], [data-conversation-find-exclude], br, hr')) { flush(); return; }
    // Folded code stays in the DOM for layout, but is outside the expanded-text
    // search scope until the user opens it. Do not advertise clipped matches.
    const style = getComputedStyle(node);
    if (!node.getClientRects().length || style.visibility === "hidden") { flush(); return; }
    // Flush both sides of each block during depth-first traversal. Grouping
    // nodes by their closest paragraph/list item would reorder nested lists and
    // incorrectly concatenate a parent's text around its child block.
    const boundary = !["inline", "contents"].includes(style.display);
    if (boundary) flush();
    for (const child of node.childNodes) visit(child);
    if (boundary) flush();
  };
  visit(root);
  flush();
  return ranges;
}
