import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const [directory, id] = process.argv.slice(2);
if (!directory || !["quiet", "active"].includes(id)) throw Error("Expected isolated fixture directory and gate ID");
const server = new McpServer({name: "dots-gate-" + id, version: "1.0.0"});
for (const step of id === "active" ? ["gate", "confirm"] : ["gate"]) {
  server.registerResource(step, "fixture://temperature/" + step, {}, async uri => {
    const marker = id === "active" && step === "gate" ? "active-first" : id;
  await writeFile(join(directory, marker + ".started"), String(Date.now()));
  const deadline = Date.now() + 160_000;
  for (;;) {
    try {
      await access(join(directory, marker + ".release"));
      return { contents: [{ uri: uri.href, text: marker === "active-first" ? "Next resource URI: fixture://temperature/confirm" : "47" }] };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) {
        await writeFile(join(directory, marker + ".expired"), String(Date.now()));
        throw Error("Resource gate expired: " + marker);
      }
      await wait(50);
    }
  }
  });
}
await server.connect(new StdioServerTransport());
