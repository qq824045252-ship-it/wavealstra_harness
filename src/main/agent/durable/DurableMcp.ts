import { Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { awaitWithContext } from "@earendil-works/chord/context";
import { createMcpAuthProvider, type ModelRuntime, type McpServerConfig, type LoadedMcpConfig, type McpOAuthCredentialStore } from "@earendil-works/pi-coding-agent";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type AuthProvider, type Tool } from "@earendil-works/pi-mcp";
import { defineTool, type ToolRegistration, type JsonObject } from "@earendil-works/pi-durable";

function expand(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const result = process.env[name];
    if (result === undefined) throw new Error("MCP environment variable is missing: " + name);
    return result;
  });
}
function strings(input?: Record<string, string>): Record<string, string> | undefined {
  return input && Object.fromEntries(Object.entries(input).map(([key, value]) => [key, expand(value)]));
}
const namespace = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, "_");
const toolName = (server: string, name: string) => "mcp__" + namespace(server) + "__" + namespace(name);
function visible(server: McpServerConfig, name: string): boolean {
  const overrides = server.toolExposure ?? {};
  const pattern = Object.keys(overrides).find(key => new RegExp("^" + key.split("*").map(part => part.replace(/[.*+?^{}$()|[\]\\]/g, "\\$&")).join(".*") + "$").test(name));
  return (overrides[name] ?? (pattern ? overrides[pattern] : undefined) ?? server.exposure) !== "hidden";
}
interface Server {
  config: McpServerConfig;
  client?: McpClient;
  connecting?: Promise<McpClient>;
  listing?: Promise<Tool[]>;
  error?: string;
  connectMs?: number;
  listToolsMs?: number;
}

/** Task-scoped native Pi transports. Discovery and invocation are ordinary Durable ToolTasks. */
export class DurableMcp {
  readonly tools: ToolRegistration[] = [];
  readonly errors: string[] = [];
  private readonly servers = new Map<string, Server>();
  private readonly credentialsSettled: Array<() => Promise<void>> = [];
  private credentials!: McpOAuthCredentialStore;
  private models!: ModelRuntime;
  private cwd!: string;
  private closed = false;

  static async open(config: LoadedMcpConfig, credentials: McpOAuthCredentialStore, models: ModelRuntime, cwd: string): Promise<DurableMcp> {
    const host = new DurableMcp();
    host.credentials = credentials; host.models = models; host.cwd = cwd;
    host.errors.push(...config.errors);
    for (const entry of config.servers) if (entry.config.enabled !== false) host.servers.set(entry.name, { config: entry.config });
    // Declare discovery from local configuration. A greeting never connects an unrelated server.
    const listing = [...host.servers].map(([name, server]) => name + (server.config.description ? ": " + server.config.description : "")).join("\n");
    host.tools.push(defineTool({ name: "mcp_list_tools", description: "Discover tools and input schemas on ONE configured MCP server before calling it. Connections are prepared on demand.\nConfigured servers:\n" + listing,
      parameters: Type.Object({ server: Type.String() }), replay: "safe",
      execute: async ({ server }, _api, context) => {
        const tools = await awaitWithContext(host.catalog(server), context);
        const client = host.servers.get(server)!.client!;
        return { content: [{ type: "text", text: JSON.stringify({ server, instructions: client.instructions,
          tools, callWith: "mcp_call_tool", resources: Boolean(client.serverCapabilities?.resources) }) }] };
      } }));
    host.tools.push(defineTool({ name: "mcp_call_tool", description: "Call an MCP tool discovered with mcp_list_tools. Use the exact server, tool name and arguments matching its input schema. Works in native mode and Code Mode.",
      parameters: Type.Object({ server: Type.String(), tool: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }), replay: "unsafe",
      execute: async (args, _api, context) => host.call(args.server, args.tool, args.arguments, context) }));
    host.tools.push(defineTool({ name: "mcp_list_resources", description: "List resources and templates on ONE configured MCP server; connects only that server.",
      parameters: Type.Object({ server: Type.String() }), replay: "safe",
      execute: async ({ server }, _api, context) => {
        const client = await awaitWithContext(host.client(server), context);
        return { content: [{ type: "text", text: JSON.stringify({ resources: await client.listResources({ signal: context.abortSignal }), templates: await client.listResourceTemplates({ signal: context.abortSignal }) }) }] };
      } }));
    host.tools.push(defineTool({ name: "mcp_read_resource", description: "Read a resource on ONE configured MCP server.",
      parameters: Type.Object({ server: Type.String(), uri: Type.String() }), replay: "safe",
      execute: async ({ server, uri }, _api, context) => {
        const client = await awaitWithContext(host.client(server), context);
        return { content: [{ type: "text", text: JSON.stringify(await client.readResource(uri, { signal: context.abortSignal })) }] };
      } }));
    host.tools.push(defineTool({ name: "mcp_status", description: "Inspect configured MCP connections, discovery timings and errors without connecting unused servers.", parameters: Type.Object({}), replay: "safe",
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ servers: [...host.servers].map(([name, server]) => ({ name,
        state: server.error ? "failed" : server.client?.connectionState ?? "idle", instructions: server.client?.instructions,
        connectMs: server.connectMs, listToolsMs: server.listToolsMs, error: server.error })), errors: host.errors }) }] }) }));
    return host;
  }

  /** Resolve stored native tool names locally before Durable resumes old native/Code Mode work. */
  restoreTools(names: readonly string[]): ToolRegistration[] {
    const restored: ToolRegistration[] = [];
    for (const name of new Set(names)) {
      const server = [...this.servers.keys()].sort((a, b) => b.length - a.length).find(server => name.startsWith("mcp__" + namespace(server) + "__"));
      if (!server) continue;
      const resource = name.slice(("mcp__" + namespace(server) + "__").length);
      if (resource === "list_resources" || resource === "read_resource") {
        const tool = this.tools.find(tool => tool.name === (resource === "list_resources" ? "mcp_list_resources" : "mcp_read_resource"))!;
        restored.push({ ...tool, name, parameters: resource === "list_resources" ? Type.Object({}) : Type.Object({ uri: Type.String() }),
          execute: (args, api, context) => tool.execute({ ...args as Record<string, unknown>, server }, api, context) });
      } else restored.push({ name, description: "Previously configured tool on " + server + "; its current schema is checked on invocation.",
        parameters: Type.Record(Type.String(), Type.Unknown()), replay: "unsafe",
        execute: (args, _api, context) => this.call(server, name, args as Record<string, unknown>, context) });
    }
    return restored;
  }

  /** Old scripts can keep their native names; enumeration discovers tools only during execution. */
  async codeModeTools(code: string, context: Parameters<ToolRegistration["execute"]>[2]): Promise<ToolRegistration[]> {
    const names = [...code.matchAll(/\bmcp__[A-Za-z0-9_]+/g)].map(match => match[0]);
    const restored = new Map(this.restoreTools(names).map(tool => [tool.name, tool]));
    if (/\bALL_TOOLS\b/.test(code)) {
      const referenced = [...this.servers.keys()].filter(name => code.includes("mcp__" + namespace(name) + "__"));
      await Promise.all((referenced.length ? referenced : [...this.servers.keys()]).map(async server => {
        const state = this.servers.get(server)!;
        if (state.config.exposure === "hidden" && !Object.values(state.config.toolExposure ?? {}).some(value => value !== "hidden")) return;
        try {
          const catalog = await awaitWithContext(this.catalog(server), context);
          for (const tool of catalog) {
            const name = toolName(server, tool.name);
            restored.set(name, { ...this.restoreTools([name])[0], description: tool.description ?? server + ": " + tool.name, parameters: Type.Unsafe(tool.inputSchema) });
          }
        } catch (error) { if (context.abortSignal?.aborted) throw error; } // One unavailable server cannot hide healthy tools.
      }));
    }
    return [...restored.values()];
  }

  private server(name: string): Server {
    if (this.closed) throw new Error("MCP host is closed");
    const server = this.servers.get(name);
    if (!server) throw new Error("MCP server is not enabled: " + name);
    if (server.config.exposure === "hidden" && !Object.values(server.config.toolExposure ?? {}).some(value => value !== "hidden")) throw new Error("MCP server is hidden: " + name);
    return server;
  }

  private client(name: string): Promise<McpClient> {
    const state = this.server(name);
    if (state.connecting) return state.connecting;
    const client = state.client = new McpClient({ name: "mybuddy-durable", version: "1.0.0", requestTimeoutMs: (state.config.timeout ?? 30) * 1000 });
    state.connecting = (async () => {
      const started = performance.now();
      try {
        const server = state.config;
        const transport = "command" in server
          ? new StdioTransport({ command: expand(server.command), args: server.args?.map(expand), env: strings(server.env), cwd: server.cwd ? expand(server.cwd) : this.cwd })
          : new StreamableHttpTransport({ url: expand(server.url), headers: strings(server.headers), authProvider: await this.auth(name, server, this.credentials, this.models) });
        if (this.closed) throw new Error("MCP host is closed");
        await client.connect(transport);
        state.connectMs = Math.round(performance.now() - started);
        return client;
      } catch (error) {
        this.failure(name, state, error);
        await client.close().catch(() => {});
        throw error;
      }
    })();
    return state.connecting;
  }

  private catalog(name: string): Promise<Tool[]> {
    const state = this.server(name);
    if (state.listing) return state.listing;
    state.listing = (async () => {
      const client = await this.client(name);
      const started = performance.now();
      try {
        const tools = await client.listTools();
        state.listToolsMs = Math.round(performance.now() - started);
        return tools.filter(tool => visible(state.config, tool.name));
      } catch (error) { this.failure(name, state, error); throw error; }
    })();
    return state.listing;
  }

  private failure(name: string, server: Server, error: unknown): void {
    server.error = error instanceof Error ? error.message : String(error);
    this.errors.push(name + ": " + server.error);
  }

  private async call(server: string, name: string, args: Record<string, unknown>, context: Parameters<ToolRegistration["execute"]>[2]) {
    const tools = await awaitWithContext(this.catalog(server), context);
    const matches = tools.filter(tool => tool.name === name || toolName(server, tool.name) === name);
    if (matches.length > 1) throw new Error("MCP tool name is ambiguous: " + server + "/" + name);
    const tool = matches[0];
    if (!tool) throw new Error("MCP tool is unavailable or hidden: " + server + "/" + name);
    const validated = validateToolArguments({ name: tool.name, description: tool.description ?? "", parameters: Type.Unsafe(tool.inputSchema) },
      { type: "toolCall", id: "mcp", name: tool.name, arguments: args as JsonObject });
    const result = await this.servers.get(server)!.client!.callTool(tool.name, validated, { signal: context.abortSignal });
    return { content: toLlmContent(result), isError: result.isError === true };
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
    this.closed = true;
    await Promise.allSettled([...this.servers.values()].map(server => server.client?.close()));
    await Promise.allSettled([...this.servers.values()].flatMap(server => [server.connecting, server.listing].filter(Boolean)));
    await Promise.allSettled(this.credentialsSettled.map(wait => wait()));
  }
}
