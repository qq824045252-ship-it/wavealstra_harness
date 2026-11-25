import type { AppDatabase } from "../db/AppDatabase";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gatewayChannelSpaceId, isGatewaySidebarChannelId } from "../../shared/gateway-task";
import { getMyBuddyDir } from "../paths";
export { gatewayChannelSpaceId } from "../../shared/gateway-task";

/** 网关会话的侧栏父容器。身份是 id；显示名只在第一次创建时使用。 */
export const GATEWAY_ROOT_SPACE_ID = "sp-gw-root";
export const GATEWAY_ROOT_SPACE_NAME = "网关助理";

function isUniqueNameConstraint(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_FOREIGNKEY") return false;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT") return true;
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
}

/** 按固定 id 取空间；同级重名时换显示名，不占用别人的空间。 */
function ensureGatewaySpace(db: AppDatabase, id: string, preferredName: string, parentId: string | null, path?: string): void {
  const existing = db.getSpace(id);
  if (existing) {
    if (path && existing.path !== path) db.upsertSpace({ id: existing.id, name: existing.name, path });
    return;
  }
  let name = preferredName;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      db.createSpace({ id, name, parentId, path });
      return;
    } catch (error) {
      if (db.getSpace(id)) return;
      if (!isUniqueNameConstraint(error)) throw error;
      name = `${preferredName} ${attempt + 2}`;
    }
  }
  throw new Error(`无法创建网关空间 ${id}`);
}

/** Only host-defined channels own directories. Never follow links into a user-selected workspace. */
export function gatewayChannelDirectory(db: AppDatabase, channelId: string, create: boolean): string {
  if (!isGatewaySidebarChannelId(channelId)) throw new Error("网关渠道身份无效");
  let path = db.connection.memory ? getMyBuddyDir() : dirname(resolve(db.connection.name));
  for (const name of ["gateway", "spaces", channelId]) {
    path = join(path, name);
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) throw new Error("网关渠道目录不是本机的独立目录：" + path);
  }
  return path;
}

/** 渠道空间绑定宿主管理的目录，保留用户设置的显示名。 */
export function ensureGatewayChannelSpace(db: AppDatabase, channelId: string, channelName: string): string {
  const path = gatewayChannelDirectory(db, channelId, true);
  ensureGatewaySpace(db, GATEWAY_ROOT_SPACE_ID, GATEWAY_ROOT_SPACE_NAME, null);
  const childId = gatewayChannelSpaceId(channelId);
  ensureGatewaySpace(db, childId, channelName, GATEWAY_ROOT_SPACE_ID, path);
  return childId;
}
