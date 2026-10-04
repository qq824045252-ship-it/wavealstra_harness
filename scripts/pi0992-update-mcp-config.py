from pathlib import Path
root=Path(__file__).resolve().parent.parent
p=root/'src/main/mcp/NativeMcpConfig.ts';s=p.read_text(encoding='utf-8')
s=s.replace("['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden']", "['codemode', 'deferred', 'direct', 'hidden']")
s=s.replace("function exposure(value: unknown): McpExposure | undefined {", "function exposure(value: unknown): McpExposure | undefined {\n  if (value === 'codemode-deferred') return 'codemode'; // Pi 0.99.2 canonical alias")
s=s.replace('  for (const [name, entry] of Object.entries(filtered.config.mcpServers ?? {})) {', '''  const names = Object.keys(filtered.config.mcpServers ?? {});
  const encodedCounts = new Map<string, number>();
  for (const name of names) { const key = name.replace(/-/g, '_'); encodedCounts.set(key, (encodedCounts.get(key) ?? 0) + 1); }
  for (const [name, entry] of Object.entries(filtered.config.mcpServers ?? {})) {''')
s=s.replace("    try {\n      if (!/^[A-Za-z0-9_-]+$/.test(name))", "    try {\n      if ((encodedCounts.get(name.replace(/-/g, '_')) ?? 0) > 1) throw new Error('server names collide after native Pi normalization: ' + name);\n      if (!/^[A-Za-z0-9_-]+$/.test(name))")
s=s.replace("      const common = {", "      if (entry.description != null && typeof entry.description !== 'string') throw new Error('description must be a string');\n      const common = {\n        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),")
s=s.replace("['clientId', 'clientSecret', 'callbackUrl', 'scope'] as const", "['clientId', 'clientSecret', 'clientName', 'callbackUrl', 'scope'] as const")
old="        config = { ...common, type: 'http', url: entry.url, headers, ...(Object.keys(oauth).length ? { oauth } : {}) };"
new="""        let auth: { provider: string } | undefined;
        if (entry.auth != null) {
          const rawAuth = entry.auth as Record<string, unknown>;
          if (typeof rawAuth !== 'object' || Array.isArray(rawAuth) || typeof rawAuth.provider !== 'string'
            || !rawAuth.provider.trim() || Object.keys(rawAuth).some(key => key !== 'provider')) throw new Error('invalid provider authentication');
          if (entry.oauth != null || hasAuthorization || entry.bearerToken || entry.bearerTokenEnv) throw new Error('provider auth cannot be combined with OAuth or bearer headers');
          if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('provider auth requires HTTPS except on loopback');
          auth = { provider: rawAuth.provider };
        }
        config = { ...common, type: 'http', url: entry.url, headers, ...(auth ? { auth } : {}), ...(Object.keys(oauth).length ? { oauth } : {}) };"""
assert old in s;s=s.replace(old,new)
p.write_text(s,encoding='utf-8',newline='\n')
print('Canonical MCP exposure, normalized collision rejection, description/clientName/provider auth adapted to Pi 0.99.2.')
