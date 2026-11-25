import type { RuntimeAuditReader, RuntimeNoteScope, RuntimeScopedNote } from "../platform/runtime-audit";

type NoteErrors = { missing: string; archived: string; conflict: string };

export class ScopedNotePersistence {
  constructor(
    private readonly reader: RuntimeAuditReader | undefined,
    private readonly scope: RuntimeNoteScope,
    private readonly maxChars: number,
    private readonly errors: NoteErrors,
  ) {}

  async read<T extends RuntimeScopedNote>(id: string, key: "projectId" | "workspaceId", readOnHost: () => T): Promise<T> {
    const result = await this.reader?.readScopedNote(this.scope, id);
    if (!result) return readOnHost();
    if (result.status !== "ok") throw new Error(this.errors[result.status]);
    return { [key]: id, ...result.note } as T;
  }

  async save<T extends RuntimeScopedNote>(
    id: string,
    key: "projectId" | "workspaceId",
    request: { content: string; expectedRevision: number },
    readOnHost: () => T,
    saveOnHost: (updatedAt: number) => T,
  ): Promise<T> {
    const { content, expectedRevision } = request;
    if (typeof content !== "string" || content.length > this.maxChars) {
      throw new Error(`便签最多支持 ${this.maxChars} 个字符`);
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("便签版本无效，请先读取最新版本");
    const updatedAt = Date.now();
    // JavaScript can carry unpaired surrogates that Rust JSON strings cannot represent.
    if (!this.reader || /[\uD800-\uDFFF]/u.test(content) || /[\uD800-\uDFFF]/u.test(id)) return saveOnHost(updatedAt);
    const result = await this.reader.saveScopedNote(this.scope, id, { content, expectedRevision, updatedAt });
    if (result?.status === "ok") return { [key]: id, ...result.note } as T;
    if (result) throw new Error(this.errors[result.status]);
    // The commit may have reached SQLite before the worker lost its reply.
    const current = readOnHost();
    if (current.revision === expectedRevision + 1 && current.updatedAt === updatedAt && current.content === content) return current;
    return saveOnHost(updatedAt);
  }
}
