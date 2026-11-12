/** A bounded body window over the CLI's active branch. Older entries retain only
 * navigation/usage metadata and a short preview, so host-side statistics and
 * pagination keep their existing semantics without transferring old tool output,
 * system prompts, thinking or base64 images. No session entries are mutated.
 */
export function sessionWindowEntries(entries, leafId, tail = 50, wholeTurns = false) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const visible = entry => entry.type === 'compaction' || (entry.type === 'branch_summary' && !!entry.summary)
    || (entry.type === 'message' && ['user', 'assistant'].includes(entry.message?.role));
  const startsTurn = entry => entry.type === 'compaction' || (entry.type === 'branch_summary' && !!entry.summary)
    || (entry.type === 'message' && entry.message?.role === 'user')
    || (entry.type === 'custom_message' && ['subagent-notify', 'subagent-notification', 'pi-web:subagent-notification'].includes(entry.customType));
  const keep = new Set();
  let current = leafId === null ? undefined : byId.get(leafId);
  let count = 0;
  while (current && !keep.has(current.id)) {
    keep.add(current.id);
    if (visible(current)) count++;
    if (count >= tail || keep.size >= Math.max(200, tail * 6)) break;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  if (wholeTurns && current && !startsTurn(current)) {
    const extra = [];
    let cursor = byId.get(current.parentId);
    while (cursor && extra.length < 1500 && !keep.has(cursor.id)) {
      extra.push(cursor);
      if (startsTurn(cursor)) { for (const entry of extra) keep.add(entry.id); break; }
      cursor = byId.get(cursor.parentId);
    }
  }
  return entries.map(entry => {
    if (keep.has(entry.id)) return entry;
    if (entry.type === 'message') {
      const message = entry.message;
      let content;
      if (typeof message.content === 'string') content = message.content.slice(0, 160);
      else content = (message.content ?? []).flatMap(block => {
        if (block.type === 'toolCall') return [{ type: 'toolCall', id: block.id, name: block.name }];
        if (block.type === 'text') return [{ type: 'text', text: block.text.slice(0, 160) }];
        if (block.type === 'image') return [{ type: 'image' }];
        return [];
      });
      // Only the fields used by cumulative usage, model selection and tree
      // previews survive. In particular drop system sections, tool details,
      // attachment bytes, thinking signatures and tool arguments.
      return { id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp,
        message: { role: message.role, content, usage: message.usage, provider: message.provider, model: message.model, responseModel: message.responseModel, timestamp: message.timestamp } };
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      return { id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp,
        summary: typeof entry.summary === 'string' ? entry.summary.slice(0, 160) : '', usage: entry.usage, provider: entry.provider, model: entry.model };
    }
    if (entry.type === 'custom_message') {
      return { id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp, customType: entry.customType, display: false, content: '' };
    }
    return entry;
  });
}
