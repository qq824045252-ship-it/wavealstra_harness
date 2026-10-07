import { Type } from "@earendil-works/pi-ai";
import { createMcpAuthProvider, type ModelRuntime, type McpServerConfig, type LoadedMcpConfig, type McpOAuthCredentialStore } from "@earendil-works/pi-coding-agent";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type AuthProvider, type Tool } from "@earendil-works/pi-mcp";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

function expand(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const result = process.env[name];
    if (result === undefined) throw new Error(`MCP environment variable is missing: ${name}`);
    return result;
  });
}
function strings(input?: Record<string, string>): Record<string, string> | undefined {
  return input && Object.fromEntries(Object.entries(input).map(([key, value]) => [key, expand(value)]));
}

/** Native Pi MCP transport, registered as ordinary Durable tools; no AgentSession or scenario policy. */
export class DurableMcp {
  readonly tools: ToolRegistration[] = [];
  readonly errors: string[] = [];
  private readonly clients = new Map<string, McpClient>();
  private readonly credentialsSettled: Array<() => Promise<void>> = [];

  static async open(config: LoadedMcpConfig, credentials: McpOAuthCredentialStore, models: ModelRuntime, cwd: string): Promise<DurableMcp> {
    const host = new DurableMcp();
    host.errors.push(...config.errors);
    await Promise.all(config.servers.filter(entry => entry.config.enabled !== false).map(async entry => {
      const client = new McpClient({ name: "mybuddy-durable", version: "1.0.0", requestTimeoutMs: (entry.config.timeout ?? 30) * 1000 });
      host.clients.set(entry.name, client);
      try {
        const server = entry.config;
        const transport = "command" in server
          ? new StdioTransport({ command: expand(server.command), args: server.args?.map(expand), env: strings(server.env), cwd: server.cwd ? expand(server.cwd) : cwd })
          : new StreamableHttpTransport({ url: expand(server.url), headers: strings(server.headers),
            authProvider: await host.auth(entry.name, server, credentials, models) });
        await client.connect(transport);
        const tools = await client.listTools();
        for (const tool of tools) {
          const overrides = server.toolExposure ?? {};
          const pattern = Object.keys(overrides).find(key => new RegExp("^" + key.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(tool.name));
          if ((overrides[tool.name] ?? (pattern ? overrides[pattern] : undefined) ?? server.exposure) === "hidden") continue;
          host.tools.push(host.tool(entry.name, tool, client));
        }
        if (client.serverCapabilities?.resources) {
          const namespace = entry.name.replace(/[^a-zA-Z0-9_]/g, "_");
          host.tools.push(defineTool({ name: `mcp__${namespace}__list_resources`, description: `List resources and templates on ${entry.name}.`, parameters: Type.Object({}), replay: "safe",
            execute: async (_args, _api, context) => ({ content: [{ type: "text", text: JSON.stringify({ resources: await client.listResources({ signal: context.abortSignal }), templates: await client.listResourceTemplates({ signal: context.abortSignal }) }) }] }) }));
          host.tools.push(defineTool({ name: `mcp__${namespace}__read_resource`, description: `Read a resource on ${entry.name}.`, parameters: Type.Object({ uri: Type.String() }), replay: "safe",
            execute: async (args, _api, context) => ({ content: [{ type: "text", text: JSON.stringify(await client.readResource(args.uri, { signal: context.abortSignal })) }] }) }));
        }
      } catch (error) {
        host.errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
        await client.close().catch(() => {});
      }
    }));
    host.tools.push(defineTool({ name: "mcp_status", description: "Inspect configured MCP connections and connection errors.", parameters: Type.Object({}), replay: "safe",
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ servers: [...host.clients].map(([name,c]) => ({ name, state: c.connectionState, instructions: c.instructions })), errors: host.errors }) }] }) }));
    return host;
  }

  private tool(server: string, tool: Tool, client: McpClient): ToolRegistration {
    return {
      name: `mcp__${server.replace(/[^a-zA-Z0-9_]/g, "_")}__${tool.name.replace(/[^a-zA-Z0-9_]/g, "_")}`,
      description: tool.description ?? `${server}: ${tool.name}`,
      parameters: Type.Unsafe(tool.inputSchema),
      // An annotation is not sufficient proof that an external operation can be replayed.
      replay: "unsafe",
      execute: async (args, _api, context) => {
        const result = await client.callTool(tool.name, args as Record<string, unknown>, { signal: context.abortSignal });
        const content = toLlmContent(result);
        return { content, isError: result.isError === true };
      },
    };
  }

  private async auth(name: string, server: Extract<McpServerConfig, { url: string }>, credentials: McpOAuthCredentialStore, models: ModelRuntime): Promise<AuthProvider | undefined> {
    if (server.auth) return { token: async () => (await models.getAuth(server.auth!.provider))?.auth.apiKey };
    if (Object.keys(server.headers ?? {}).some(key => key.toLowerCase() === "authorization")) return undefined;
    const store = credentials.forServer(name, server.url);
    const provider = createMcpAuthProvider({
      serverUrl: server.url, store,
      settings: () => ({ ...server.oauth, clientName: server.oauth?.clientName ?? "MyBuddy",
        clientSecret: server.oauth?.clientSecret ? expand(server.oauth.clientSecret) : undefined,
        authServerMetadataUrl: server.oauth?.authServerMetadataUrl ? new URL(server.oauth.authServerMetadataUrl) : undefined,
      }),
      // Sign-in remains in plugin management; native refresh never opens a browser.
      onChallenge: () => {},
    });
    this.credentialsSettled.push(() => provider.settled());
    return provider;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map(client => client.close()));
    await Promise.allSettled(this.credentialsSettled.map(wait => wait()));
  }
}
