import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class ProbeExitUnconfirmedError extends Error {}

// Only owns and terminates the child it creates. Output limits are cumulative,
// including complete lines; stderr is continuously drained and bounded too.
export async function runPreviewProbe({ program, args, input, accept, cwd, env, timeoutMs = 30000, exitTimeoutMs = 5000, outputLimit = 1024 * 1024, spawnChild = spawn }) {
  const child = spawnChild(program, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let exited = false, closed = false;
  let stdoutBytes = 0, stderrBytes = 0, stderr = "", pending = "";
  const decoder = new StringDecoder("utf8");
  let resolveClose;
  const close = new Promise((resolve) => { resolveClose = resolve; });
  child.once("exit", () => { exited = true; });
  child.once("close", () => { closed = true; resolveClose(); });
  const alreadyExited = () => exited || child.exitCode != null || child.signalCode != null;
  let error, limitError;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(); };
      const timer = setTimeout(() => finish(new Error("response timeout")), timeoutMs);
      child.once("error", (err) => finish(new Error(`spawn failed: ${err.message}`)));
      child.once("exit", (code, signal) => finish(new Error(`exited before reply (code ${code}, signal ${signal})`)));
      child.stdout.on("error", (err) => finish(new Error(`stdout error: ${err.message}`)));
      child.stderr.on("error", (err) => finish(new Error(`stderr error: ${err.message}`)));
      child.stdin.on("error", (err) => finish(new Error(`stdin error: ${err.message}`)));
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
        if (stderrBytes > outputLimit) { limitError ??= new Error(`stderr exceeded ${outputLimit} bytes`); finish(limitError); }
      });
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > outputLimit) { limitError ??= new Error(`stdout exceeded ${outputLimit} bytes`); return finish(limitError); }
        pending += decoder.write(chunk);
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try { if (accept(JSON.parse(line))) return finish(); } catch (err) { return finish(new Error(`invalid probe response: ${err.message}`)); }
        }
      });
      child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  } catch (err) { error = err; }

  if (!alreadyExited() && child.pid) {
    try { child.kill(); } catch (err) { error ??= new Error(`could not terminate probe child: ${err.message}`); }
  }
  if (!closed) {
    let timer;
    const confirmed = await Promise.race([close.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), exitTimeoutMs); })]);
    clearTimeout(timer);
    if (!confirmed) {
      // Do not wait forever or touch any process other than this child. Leave
      // its temporary files intact because it may still be using them.
      child.unref?.();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      throw new ProbeExitUnconfirmedError(`probe child ${child.pid ?? "unknown"} exit/stdio closure unconfirmed after ${exitTimeoutMs}ms; temporary data retained${error ? `; ${error.message}` : ""}`);
    }
  }
  error ??= limitError;
  if (error) throw new Error(`offline probe failed: ${error.message}; stdout=${stdoutBytes} bytes stderr=${stderrBytes} bytes${stderr ? `; stderr excerpt: ${stderr}` : ""}`);
}
