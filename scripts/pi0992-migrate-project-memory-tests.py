from pathlib import Path
root=Path(__file__).resolve().parent.parent
p=root/'scripts/project-memory-agent-test.ts';s=p.read_text(encoding='utf-8')
a=s.index('/* ---------------- 1. resolver');b=s.index('/* ---------------- 2.',a)
s=s[:a]+'''/* ---------------- 1. One Memory source, no stored prompt duplicate ---------------- */
{
  const ctxA = resolver.resolveTask("task-a");
  assertOk(ctxA != null && ctxA.memorySummary == null, "resolver: 项目上下文不携带第二份 Memory 摘要");
  const stored = service.listMemory(projectP.id);
  assertOk(stored.length === 4, "memory: 四条真实记录");
  assertOk(stored.filter(m => m.status === "active").length === 4, "memory: active 状态正确");
  const recalled = memory.resolveContext({ taskId: "task-a", query: "客户介质", trackRecall: false });
  assertOk(recalled.items.some(m => m.title === "客户介质"), "projection: 按查询召回当前项目事实");
  assertOk(recalled.includedChars <= recalled.budgetChars, "projection: 有界上下文");
  assertOk(resolver.resolveTask("task-none") === null, "resolver: 未绑定项目任务无项目上下文");
  assertOk(memory.resolveContext({ taskId: "task-q", query: "客户介质", trackRecall: false }).items.length === 0, "projection: 不泄漏其它项目");
}

'''+s[b:]
a=s.index('  const summaryB = ctxB.memorySummary!;');b=s.index('  const manual =',a)
s=s[:a]+'''  const storedB = service.listMemory(projectP.id);
  assertOk(storedB.some(m => m.title === "高温版本交期" && m.status === "resolved"), "taskB: 看到已解决记录");
  const recallB = memory.resolveContext({ taskId: "task-b", query: "交期", trackRecall: false });
  assertOk(recallB.items.some(item => item.title === "交期" && item.content.includes("4 周")), "taskB: 召回同项目新事实");

'''+s[b:]
a=s.index('/* 5. 100+');b=s.index('/* 6.',a)
s=s[:a]+'''/* 5. Query-dependent projection stays bounded with a large persistent store. */
{
  for (let i = 0; i < 110; i++) service.createMemory({ projectId: projectP.id, kind: "fact", title: `批量事实 ${i}`, content: "批量数据不应成为完整系统提示" });
  assertOk(service.listMemory(projectP.id).length >= 110, "bulk: 全量保留在长期存储");
  const projected = memory.resolveContext({ taskId: "task-a", query: "交期", budgetChars: 900, limit: 3, trackRecall: false });
  assertOk(projected.items.length <= 3, "bulk: 召回数量不超限制");
  assertOk(Buffer.byteLength(projected.text, "utf8") <= 900, "bulk: 序列化字节预算不超");
  assertOk(projected.items.every(item => memory.get(item.id)?.status === "active"), "bulk: 已解决或被替代事实不进入默认上下文");
  assertOk(!assembleProjectContextSegments(resolver.resolveTask("task-a")).some(item => item.id === "projectMemory"), "bulk: 不恢复已删除的永久摘要注入");
}

'''+s[b:]
s=s.replace('resolver.resolveProject(projectP.id)!.memorySummary!.total','service.listMemory(projectP.id).length')
p.write_text(s,encoding='utf-8',newline='\n')
print('Project memory regression migrated to current L1 source + query-only projection; retained write, readonly, archived and lifecycle sections.')
