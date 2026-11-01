// Local fake MCP server for the management-host integration fixture only.
import { createServer } from "node:http";
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer fixture") { response.writeHead(401).end(); return; }
  if (request.method !== "POST") { response.writeHead(405).end(); return; }
  let body = "";
  for await (const chunk of request) body += chunk;
  const message = JSON.parse(body);
  if (message.id === undefined) { response.writeHead(202).end(); return; }
  const result = message.method === "initialize"
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : message.method === "tools/list" ? { tools: [] } : {};
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
console.log(`http://127.0.0.1:${server.address().port}/mcp`);
process.stdin.resume();
process.stdin.on("end", () => server.close());
