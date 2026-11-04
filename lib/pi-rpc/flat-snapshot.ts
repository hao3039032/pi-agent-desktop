/** Decode the child's own tree topology, never infer branches from file order or
 * parentId. Used only when native get_tree cannot serialize a deep tree.
 */
export function decodeFlatSnapshot(value: unknown): { entries: unknown[]; tree: unknown[]; leafId: string | null } {
  const fail = (): never => { throw new Error('Invalid flat snapshot from the CLI process'); };
  if (!value || typeof value !== 'object') return fail();
  const { entries, leafId, nodes, roots } = value as Record<string, unknown>;
  if (!Array.isArray(entries) || !Array.isArray(nodes) || !Array.isArray(roots)
    || (leafId !== null && typeof leafId !== 'string')) return fail();
  const byId = new Map<string, unknown>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || byId.has(entry.id)) return fail();
    byId.set(entry.id, entry);
  }
  if (leafId !== null && !byId.has(leafId)) return fail();
  if (nodes.length !== entries.length) return fail();
  type Node = { entry: unknown; children: Node[]; label?: string; labelTimestamp?: string };
  const ids = new Set<string>();
  const decoded: Node[] = nodes.map(node => {
    if (!node || typeof node.entryId !== 'string' || !byId.has(node.entryId) || ids.has(node.entryId)
      || !Array.isArray(node.children)) return fail();
    ids.add(node.entryId);
    return { entry: byId.get(node.entryId), children: [],
      ...(typeof node.label === 'string' ? { label: node.label } : {}),
      ...(typeof node.labelTimestamp === 'string' ? { labelTimestamp: node.labelTimestamp } : {}),
    };
  });
  const seen = new Set<number>();
  const tree: Node[] = [];
  const pending = roots.map(index => ({ index, into: tree })).reverse();
  while (pending.length) {
    const { index, into } = pending.pop()!;
    if (!Number.isInteger(index) || index < 0 || index >= nodes.length || seen.has(index)) return fail();
    seen.add(index);
    const node = decoded[index];
    into.push(node);
    const children = nodes[index].children;
    for (let i = children.length - 1; i >= 0; i--) pending.push({ index: children[i], into: node.children });
  }
  if (seen.size !== nodes.length) return fail();
  return { entries, tree, leafId: leafId as string | null };
}
