import { startFakeOAuthServer } from "../../lib/__fixtures__/mcp-oauth-server.mjs";

const server = await startFakeOAuthServer();
console.log(server.url);
process.stdin.resume();
process.stdin.on("end", async () => { await server.close(); });
