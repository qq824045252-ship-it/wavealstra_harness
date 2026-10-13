import type { AppDatabase } from "../db/AppDatabase";

/** 网关会话的侧栏父容器。身份是 id；显示名只在第一次创建时使用。 */
export const GATEWAY_ROOT_SPACE_ID = "sp-gw-root";
export const GATEWAY_ROOT_SPACE_NAME = "网关助理";

export function gatewayChannelSpaceId(channelId: string): string {
  return `sp-gw-${channelId}`;
}

function isUniqueNameConstraint(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_FOREIGNKEY") return false;
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT") return true;
  return /UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error));
}

/** 按固定 id 取空间。不存在才创建，且不写 path；同级重名时换显示名，不占用别人的空间。 */
function ensureGatewaySpace(db: AppDatabase, id: string, preferredName: string, parentId: string | null): void {
  if (db.getSpace(id)) return;
  let name = preferredName;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      db.createSpace({ id, name, parentId });
      return;
    } catch (error) {
      if (db.getSpace(id)) return;
      if (!isUniqueNameConstraint(error)) throw error;
      name = `${preferredName} ${attempt + 2}`;
    }
  }
  throw new Error(`无法创建网关空间 ${id}`);
}

/** 新网关任务的子文件夹。返回渠道空间 id；父、子都已存在时不改名、不改父级、不补路径。 */
export function ensureGatewayChannelSpace(db: AppDatabase, channelId: string, channelName: string): string {
  ensureGatewaySpace(db, GATEWAY_ROOT_SPACE_ID, GATEWAY_ROOT_SPACE_NAME, null);
  const childId = gatewayChannelSpaceId(channelId);
  ensureGatewaySpace(db, childId, channelName, GATEWAY_ROOT_SPACE_ID);
  return childId;
}
