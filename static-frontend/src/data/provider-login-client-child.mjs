// Test-only fake WebView bridge: feed real Rust Channel frames to the static
// login service; emit its rendered events for the parent fixture to inspect.
import { createInterface } from "node:readline";
import { createJiti } from "jiti";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });
const { bindProviderAuthLogin, subscribeOAuthLogin } = await jiti.import("./provider-auth-login.ts");
const { IpcClient } = await jiti.import("../ipc/client.ts");
let deliver;
bindProviderAuthLogin(new IpcClient({
  send: async () => ({}),
  subscribe: (_op, _args, onMessage) => { deliver = onMessage; return () => {}; },
}));
subscribeOAuthLogin("relay-fake", (event) => process.stdout.write(`${JSON.stringify(event)}\n`), (error) => process.stdout.write(`${JSON.stringify({ error: error.message })}\n`));
createInterface({ input: process.stdin }).on("line", (line) => deliver(JSON.parse(line)));
