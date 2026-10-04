import type { LoadedMcpConfig, McpExposure, McpServerConfig } from '@earendil-works/pi-coding-agent';
import type { McpFilterResult } from './McpModeFilter';

const EXPOSURES = new Set<McpExposure>(['codemode', 'deferred', 'direct', 'hidden']);
function exposure(value: unknown): McpExposure | undefined {
  if (value === 'codemode-deferred') return 'codemode'; // Pi 0.99.2 canonical alias
  return typeof value === 'string' && EXPOSURES.has(value as McpExposure) ? value as McpExposure : undefined;
}
function configValue(value: string): string {
  return value.replace(/^\$env:([A-Za-z_][A-Za-z0-9_]*)$/, '${$1}')
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
}
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('env/headers must be string records');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error('env/headers values must be strings');
    result[key] = configValue(item);
  }
  return result;
}
/** Product policy resolves once; Pi exclusively owns transport, discovery and invocation. */
export function toNativeMcpConfig(filtered: McpFilterResult, source = 'mybuddy:resolved-session', codeModeEnabled = true): LoadedMcpConfig {
  // Session projection only: never rewrite the user's persisted MCP exposure configuration.
  const projectExposure = (value: McpExposure): McpExposure => !codeModeEnabled && value === 'codemode' ? 'deferred' : value;
  const servers: LoadedMcpConfig['servers'] = [];
  const errors: string[] = [];
  const names = Object.keys(filtered.config.mcpServers ?? {});
  const encodedCounts = new Map<string, number>();
  for (const name of names) { const key = name.replace(/-/g, '_'); encodedCounts.set(key, (encodedCounts.get(key) ?? 0) + 1); }
  for (const [name, entry] of Object.entries(filtered.config.mcpServers ?? {})) {
    try {
      if ((encodedCounts.get(name.replace(/-/g, '_')) ?? 0) > 1) throw new Error('server names collide after native Pi normalization: ' + name);
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('server name must contain only letters, digits, _ and -');
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('server entry must be an object');
      if (entry.socket || entry.type === 'sse' || entry.transport === 'sse') throw new Error('legacy SSE/socket transport is unsupported; configure an explicit Streamable HTTP or stdio endpoint');
      if (entry.type != null && !['stdio', 'http', 'streamable-http'].includes(String(entry.type))) throw new Error('unsupported explicit transport type');
      if (entry.command && entry.url) throw new Error('choose exactly one of command and url');
      if (entry.type === 'stdio' && !entry.command) throw new Error('stdio requires a command');
      if ((entry.type === 'http' || entry.type === 'streamable-http') && !entry.url) throw new Error('HTTP requires a url');
      if (entry.cwd != null && (typeof entry.cwd !== 'string' || !entry.cwd.trim())) throw new Error('cwd must be a nonempty string');
      if (entry.oauth != null && (typeof entry.oauth !== 'object' || Array.isArray(entry.oauth))) throw new Error('oauth must be an object');
      if (entry.directTools != null && typeof entry.directTools !== 'boolean' && (!Array.isArray(entry.directTools) || entry.directTools.some(tool => typeof tool !== 'string' || !tool.trim()))) throw new Error('directTools must be a boolean or nonempty tool names');
      if (entry.enabled != null && typeof entry.enabled !== 'boolean') throw new Error('enabled must be boolean');
      if (entry.disabled != null && typeof entry.disabled !== 'boolean') throw new Error('disabled must be boolean');
      if (entry.exposure != null && !exposure(entry.exposure)) throw new Error('invalid exposure');
      const toolExposure: Record<string, McpExposure> = {};
      if (entry.toolExposure != null) {
        if (typeof entry.toolExposure !== 'object' || Array.isArray(entry.toolExposure)) throw new Error('invalid toolExposure');
        for (const [tool, value] of Object.entries(entry.toolExposure)) {
          const normalized = exposure(value);
          if (!normalized) throw new Error('invalid tool exposure: ' + tool);
          toolExposure[tool] = projectExposure(normalized);
        }
      }
      if (Array.isArray(entry.directTools)) for (const tool of entry.directTools) toolExposure[tool] ??= 'direct';
      const rawTimeout = entry.timeout ?? (typeof entry.requestTimeoutMs === 'number' ? entry.requestTimeoutMs / 1000 : undefined)
        ?? (typeof filtered.config.settings?.requestTimeoutMs === 'number' ? filtered.config.settings.requestTimeoutMs / 1000 : undefined);
      if (rawTimeout != null && (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) throw new Error('timeout must be positive seconds');
      if (entry.description != null && typeof entry.description !== 'string') throw new Error('description must be a string');
      const common = {
        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
        enabled: entry.disabled !== true && entry.enabled !== false,
        exposure: projectExposure(exposure(entry.exposure) ?? (entry.directTools === true ? 'direct' : 'codemode')),
        ...(Object.keys(toolExposure).length ? { toolExposure } : {}),
        ...(typeof rawTimeout === 'number' ? { timeout: rawTimeout } : {}),
      };
      let config: McpServerConfig;
      if (typeof entry.url === 'string' && entry.url.trim()) {
        const url = new URL(entry.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid HTTP endpoint');
        const headers = stringRecord(entry.headers) ?? {};
        const hasAuthorization = Object.keys(headers).some(key => key.toLowerCase() === 'authorization');
        if (!hasAuthorization && entry.bearerTokenEnv) headers.Authorization = 'Bearer ${' + entry.bearerTokenEnv + '}';
        else if (!hasAuthorization && entry.bearerToken) headers.Authorization = 'Bearer ' + entry.bearerToken;
        const raw = entry.oauth && typeof entry.oauth === 'object' ? entry.oauth as Record<string, unknown> : {};
        const oauth: NonNullable<Extract<McpServerConfig, { url: string }>['oauth']> = {};
        for (const key of ['clientId', 'clientSecret', 'clientName', 'callbackUrl', 'scope', 'authServerMetadataUrl'] as const) {
          if (raw[key] != null && typeof raw[key] !== 'string') throw new Error('invalid OAuth setting: ' + key);
          if (typeof raw[key] === 'string') oauth[key] = configValue(raw[key]);
        }
        if (oauth.authServerMetadataUrl != null) {
          const metadata = new URL(oauth.authServerMetadataUrl);
          if (metadata.protocol !== 'https:' && !(metadata.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(metadata.hostname)))
            throw new Error('OAuth metadata URL requires HTTPS except on loopback');
          if (metadata.username || metadata.password || metadata.hash) throw new Error('invalid OAuth metadata URL');
        }
        if (raw.callbackPort != null) {
          if (!Number.isInteger(raw.callbackPort) || Number(raw.callbackPort) < 1 || Number(raw.callbackPort) > 65535) throw new Error('invalid OAuth callback port');
          oauth.callbackPort = Number(raw.callbackPort);
        }
        let auth: { provider: string } | undefined;
        if (entry.auth != null && entry.auth !== 'oauth') {
          const rawAuth = entry.auth as Record<string, unknown>;
          if (typeof rawAuth !== 'object' || Array.isArray(rawAuth) || typeof rawAuth.provider !== 'string'
            || !rawAuth.provider.trim() || Object.keys(rawAuth).some(key => key !== 'provider')) throw new Error('invalid provider authentication');
          if (entry.oauth != null || hasAuthorization || entry.bearerToken || entry.bearerTokenEnv) throw new Error('provider auth cannot be combined with OAuth or bearer headers');
          if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('provider auth requires HTTPS except on loopback');
          auth = { provider: rawAuth.provider };
        }
        config = { ...common, type: 'http', url: entry.url, headers, ...(auth ? { auth } : {}), ...(Object.keys(oauth).length ? { oauth } : {}) };
      } else if (typeof entry.command === 'string' && entry.command.trim()) {
        if (entry.args != null && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string'))) throw new Error('args must be a string array');
        config = { ...common, type: 'stdio', command: entry.command, args: entry.args, env: stringRecord(entry.env), cwd: entry.cwd };
      } else throw new Error('missing stdio command or Streamable HTTP url');
      // These are configured servers, not pi.registerMcpServer registrations.
      servers.push({ name, config, source, scope: 'global' });
    } catch (error) { errors.push('MCP ' + name + ': ' + (error instanceof Error ? error.message : String(error))); }
  }
  return { servers, autoEnableCodemode: codeModeEnabled, errors };
}
