/** LF-only JSONL framing. Never rescan/copy the entire accumulated response for
 * each pipe chunk: get_entries/get_tree can contain megabytes of tool output.
 * UTF-8 decoding belongs to the stream's setEncoding('utf8'); U+2028/2029 are data.
 */
export class RpcLineBuffer {
  private parts: string[] = [];

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = chunk.indexOf("\n", start);
      if (end < 0) break;
      const part = chunk.slice(start, end);
      let line: string;
      if (this.parts.length) {
        this.parts.push(part);
        line = this.parts.join("");
        this.parts = [];
      } else line = part;
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      start = end + 1;
    }
    if (start < chunk.length) this.parts.push(chunk.slice(start));
    return lines;
  }

  clear(): void { this.parts = []; }
}
