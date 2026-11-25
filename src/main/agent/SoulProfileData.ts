import type { SoulDto } from "../../shared/agent-ipc";
import type { AppDatabase } from "../db/AppDatabase";

export type RuntimeSoulProfileRequest = { kind: "read" } | { kind: "update"; patch: Partial<SoulDto> };

export type RuntimeSoulProfileReply =
  | { status: "applied"; profile: SoulDto }
  | { status: "needsHost" }
  | { status: "rejected"; message: string };

const soulFields = ["name", "alias", "persona"] as const;

export async function readSoulProfile(db: AppDatabase): Promise<SoulDto> {
  const result = await db.runtimeAuditReader?.soulProfile({ kind: "read" });
  return result?.status === "applied" ? result.profile : db.getSoul();
}

export async function writeSoulProfile(db: AppDatabase, partial: Partial<SoulDto>): Promise<SoulDto> {
  const reader = db.runtimeAuditReader;
  // Preserve the binding behavior for callers outside the typed IPC contract.
  if (!reader || Object.entries(partial ?? {}).some(([field, value]) =>
    !soulFields.includes(field as keyof SoulDto) || typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value))) {
    return db.updateSoul(partial);
  }
  const result = await reader.soulProfile({ kind: "update", patch: partial ?? {} });
  if (result?.status === "applied") return result.profile;
  if (result?.status === "needsHost") return db.updateSoul(partial);
  throw new Error(result?.status === "rejected" ? result.message : "保存身份资料未获确认");
}
