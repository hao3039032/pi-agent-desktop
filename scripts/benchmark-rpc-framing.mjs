// Synthetic RPC responses only: never reads sessions or calls a model.
// node --experimental-strip-types scripts/benchmark-rpc-framing.mjs [4 16 64]
import { performance } from 'node:perf_hooks';
import { RpcLineBuffer } from '../lib/pi-rpc/line-buffer.ts';
const sizes = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [4, 16];
for (const mb of sizes) {
  if (!Number.isInteger(mb) || mb < 1 || mb > 64) throw new Error('Sizes must be integer MiB from 1 to 64');
  const line = JSON.stringify({ type: 'response', data: { text: 'x'.repeat(mb * 1024 * 1024) } }) + '\n';
  const chunks = [];
  for (let i = 0; i < line.length; i += 16384) chunks.push(line.slice(i, i + 16384));
  let buffer = '', start = performance.now();
  // Previous implementation: appending flattens the growing string and scans
  // it again on every chunk, even if none of the previous bytes contained LF.
  for (const chunk of chunks) {
    buffer += chunk;
    const index = buffer.indexOf('\n');
    if (index >= 0) { JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
  }
  const oldMs = performance.now() - start;
  const current = new RpcLineBuffer(); start = performance.now();
  for (const chunk of chunks) for (const record of current.push(chunk)) JSON.parse(record);
  console.log(JSON.stringify({ responseMiB: mb, chunkKiB: 16, oldMs: Math.round(oldMs), currentMs: Math.round(performance.now() - start) }));
}
