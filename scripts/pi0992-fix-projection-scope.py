from pathlib import Path
root=Path(__file__).resolve().parent.parent
p=root/'src/main/agent/MemoryContextProjection.ts';s=p.read_text(encoding='utf-8')
s+='''
/** Current task ownership only. A removed workspace must not fall back to session creation metadata. */
export function resolveTaskMemoryScope(taskId: string, task: { projectId?: string | null; spaceId?: string | null } | undefined) {
  return { taskId, projectId: task?.projectId ?? undefined, workspaceId: task?.spaceId ?? undefined };
}
'''
p.write_text(s,encoding='utf-8',newline='\n')
p=root/'src/main/agent/AgentService.ts';s=p.read_text(encoding='utf-8');s='import { resolveTaskMemoryScope } from "./MemoryContextProjection";\n'+s
old='return { taskId: opts.taskId, projectId: task?.projectId ?? undefined, workspaceId: task?.spaceId ?? opts.spaceId };'
assert old in s;s=s.replace(old,'return resolveTaskMemoryScope(opts.taskId, task);');p.write_text(s,encoding='utf-8',newline='\n')
p=root/'src/main/pi-bundled-runtime.ts';s=p.read_text(encoding='utf-8');s='import { dirname } from "node:path";\nimport { fileURLToPath } from "node:url";\n'+s
s=s.replace('configurePiCodemodeAssets(__dirname);','configurePiCodemodeAssets(typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url)));');p.write_text(s,encoding='utf-8',newline='\n')
print('Removed stale workspace fallback from live memory scope; fixed source-level ESM runtime initialization.')
