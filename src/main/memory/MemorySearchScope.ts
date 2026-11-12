import type { MemoryRecordDto, MemoryScopeType, MemoryStatus } from "../../shared/memory-kernel";

export type MemorySearchScope = {
  scopes: Array<{ scopeType: MemoryScopeType; scopeId?: string }>;
  statuses?: MemoryStatus[];
  kinds?: MemoryRecordDto["kind"][];
};

/** EXISTS gives each atom one candidate slot, even with several readable bindings. */
export function memorySearchWhere(input: MemorySearchScope, now = Date.now()): { sql: string; args: (string | number)[] } {
  const args: (string | number)[] = [];
  const scopes = input.scopes.map(scope => {
    if (scope.scopeType === "global") return "(s.scope_type='global' AND s.scope_id IS NULL)";
    args.push(scope.scopeType, scope.scopeId ?? "");
    return "(s.scope_type=? AND s.scope_id=?)";
  });
  const where = [`EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND (${scopes.join(" OR ") || "0"}))`];
  const statuses = input.statuses?.length ? input.statuses : ["active"];
  where.push(`m.status IN (${statuses.map(() => "?").join(",")})`);
  args.push(...statuses);
  if (input.kinds?.length) {
    where.push(`m.kind IN (${input.kinds.map(() => "?").join(",")})`);
    args.push(...input.kinds);
  }
  where.push("(m.status<>'active' OR ((m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_until IS NULL OR m.valid_until>?)))");
  args.push(now, now);
  return { sql: where.join(" AND "), args };
}
