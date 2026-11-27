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
  if (result?.status === "applied") return result.profile;
  if (db.coreIdentity) throw new Error("身份资料读取未获 Rust Core 确认");
  return db.getSoul();
}

export async function writeSoulProfile(db: AppDatabase, partial: Partial<SoulDto>): Promise<SoulDto> {
  const reader = db.runtimeAuditReader;
  const rustRequired = db.readonly;
  if (!reader) {
    if (rustRequired) throw new Error("只读数据库模式下无法保存身份资料");
    return db.updateSoul(partial);
  }
  if (Object.entries(partial ?? {}).some(([field, value]) =>
    !soulFields.includes(field as keyof SoulDto) || typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value))) {
    if (rustRequired) throw new Error("身份资料包含不受支持的字符或字段");
    return db.updateSoul(partial);
  }
  const result = await reader.soulProfile({ kind: "update", patch: partial ?? {} });
  if (result?.status === "applied") return result.profile;
  if (result?.status === "needsHost" && !rustRequired) return db.updateSoul(partial);
  throw new Error(result?.status === "rejected" ? result.message : "保存身份资料未获确认");
}
