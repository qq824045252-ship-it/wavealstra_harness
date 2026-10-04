<!-- __SANITIZED__ 来源: C:\Users\user\.mybuddy\sessions\--C--Users-user-Desktop-design--\2026-08-07T00-36-21-271Z_019fd9a6-4897-7ca9-9d0e-db86c8f0c34b.jsonl | block:  | 长度: 3114 -->
## Quick Start

Preferred project config: `.mcp.json`

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.6.0"]
    }
  }
}
```

Preferred user-global shared config: `~/.config/mcp/mcp.json`. Pi also reads the tool-agnostic global paths `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json`.

Pi also reads Pi-owned override files for settings and host-specific compatibility:

- `<Pi agent dir>/mcp.json` — Pi global override (`~/.pi/agent/mcp.json` by default)
===types===
13: export type Transport = McpTransport;
20: export type McpServerRuntimeStatus =
24: | "needs-auth"
47: export type ImportKind =
56: type SdkTool = ListToolsResult["tools"][number];
57: type SdkResource = ListResourcesResult["resources"][number];
58: type SdkPrompt = ListPromptsResult["prompts"][number];
59: type SdkPromptArgument = NonNullable<SdkPrompt["arguments"]>[number];
156: export type UiDisplayMode = "inline" | "fullscreen" | "pip";
204: if (params.type === "prompt" || params.prompt) {
211: .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
250: if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
333: export type ContentBlock = TextContent | ImageContent;
335: // OAuth configuration (SDK handles auto-discovery and dynamic registration)
336: export interface OAuthConfig {
337: /** OAuth grant type (defaults to authorization_code) */
338: grantType?: "authorization_code" | "client_credentials";
343: /** Requested OAuth scopes */
345: /** Extra authorization URL parameters for provider-specific extensions. Flow-owned parameters cannot be overridden. */
346: authorizationParams?: Record<string, string>;
347: /** Exact authorization-code redirect URI for pre-registered clients */
356: export interface ServerEntry {
359: /** Explicit rmcp-mux Unix-domain socket path. Mutually exclusive with command and url. */
364: url?: string;
367: * Authentication type:
368: * - 'oauth' - Use OAuth 2.1 (auto-discovers endpoints, supports dynamic client registration)
370: * - false - Disable authentication
371: * If not specified and url is present, OAuth will be auto-detected unless custom headers are configured
373: auth?: "oauth" | "bearer" | false;
377: * OAuth configuration (optional).
379: * Set to false to explicitly disable OAuth for this server.
381: oauth?: OAuthConfig | false;
413: export function isServerDisabled(definition: ServerEntry | undefined): boolean {
428: export type ToolPrefix = "server" | "none" | "short" | "mcp";
429: export type HostConfigDiscovery = "off" | "prompt" | "on";
430: export type McpFooterStatus = "full" | "compact" | "off";
445: export type McpToolApprovalOrigin = "proxy" | "direct" | "script" | "resource" | "iframe";
446: export type McpToolApprovalDecision = "allow_once" | "allow_for_session" | "deny" | "abstain";
447: export type McpToolApprovalHandler = () => McpToolApprovalDecision | Promise<McpToolApprovalDecision>;
481: autoAuth?: boolean;