from pathlib import Path
import re,json
root=Path(__file__).resolve().parent.parent
p=root/'src/main/mcp/McpConfigService.ts';s=p.read_text(encoding='utf-8').replace('  auth?: string;','  auth?: string | { provider: string };');p.write_text(s,encoding='utf-8',newline='\n')
p=root/'src/main/mcp/NativeMcpConfig.ts';s=p.read_text(encoding='utf-8').replace('if (entry.auth != null) {',"if (entry.auth != null && entry.auth !== 'oauth') {");p.write_text(s,encoding='utf-8',newline='\n')
p=root/'scripts/project-memory-agent-test.ts';s=p.read_text(encoding='utf-8').replace('  renderProjectMemoryContext,\n','')
a=s.index('  const readOnly = renderProjectMemoryContext(');b=s.index('  const roSegments',a)
s=s[:a]+'''  const projected = memory.resolveContext({ taskId: "task-a", query: "交期", trackRecall: false });
  assertOk(projected.items.every(item => item.scopeType !== "project" || item.scopeId === projectP.id), "projection: 只召回当前项目范围");

'''+s[b:]
a=s.index('  const emptyReadOnly = renderProjectMemoryContext(');b=s.index('\n}',a)
s=s[:a]+'''  const emptyProjection = memory.resolveContext({ taskId: "task-q", query: "交期", trackRecall: false });
  assertOk(!emptyProjection.items.some(item => item.scopeId === projectP.id), "projection: 空项目不继承其它项目记忆");'''+s[b:]
p.write_text(s,encoding='utf-8',newline='\n')
p=root/'package.json';v=json.loads(p.read_text(encoding='utf-8'))
for name in ['memory-race','mcp-config']:
 v['scripts']['test:pi0992-'+name]='esbuild scripts/pi0992-'+name+'-test.ts --bundle --platform=node --format=esm --packages=external --outfile=out/tests/pi0992-'+name+'-test.mjs && node scripts/test-guard.mjs out/tests/pi0992-'+name+'-test.mjs'
p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
print('Preserved imported OAuth compatibility, removed retired duplicate memory-renderer test assumptions, registered regression commands.')
