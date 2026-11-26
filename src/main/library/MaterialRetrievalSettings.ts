import type { AppDatabase } from "../db/AppDatabase";
import type {
  MaterialRetrievalMode,
  MaterialRetrievalScope,
  MaterialRetrievalScopeSettings,
  MaterialRetrievalSettings,
} from "../../shared/materialRetrieval";

export type RuntimeMaterialRetrievalRequest =
  | { kind: "getSettings" }
  | { kind: "setSettings"; mode?: MaterialRetrievalMode; setDecisionModel: boolean; decisionModel: string | null }
  | { kind: "getScope"; scope?: MaterialRetrievalScope }
  | { kind: "setScope"; scope: MaterialRetrievalScope; mode: MaterialRetrievalMode | null };

export type RuntimeMaterialRetrievalReply =
  | { status: "settings"; settings: MaterialRetrievalSettings }
  | { status: "scope"; settings: MaterialRetrievalScopeSettings }
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

export function ensureMaterialRetrievalTables(conn: AppDatabase["connection"]): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS material_retrieval_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      mode TEXT NOT NULL CHECK (mode IN ('keyword', 'hybrid')),
      decision_model TEXT
    );
    CREATE TABLE IF NOT EXISTS material_retrieval_spaces (
      id TEXT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('keyword', 'hybrid'))
    );
    CREATE TABLE IF NOT EXISTS material_retrieval_projects (
      id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('keyword', 'hybrid'))
    );
  `);
}

export function getMaterialRetrievalSettings(db: AppDatabase): MaterialRetrievalSettings {
  const row = db.connection.prepare(`
    SELECT mode, decision_model AS decisionModel FROM material_retrieval_settings WHERE singleton = 1
  `).get() as MaterialRetrievalSettings | undefined;
  return row ?? { mode: "hybrid", decisionModel: null };
}

function validateMode(mode: unknown): asserts mode is MaterialRetrievalMode {
  if (mode !== "keyword" && mode !== "hybrid") throw new Error("未知的资料检索方式");
}

function validateDecisionModel(model: unknown): void {
  if (model !== null && (typeof model !== "string" || !model.trim())) {
    throw new Error("无效的 SAG2 决策模型");
  }
}

export function setMaterialRetrievalSettings(
  db: AppDatabase,
  patch: Partial<MaterialRetrievalSettings>,
): MaterialRetrievalSettings {
  const settings = { ...getMaterialRetrievalSettings(db), ...patch };
  validateMode(settings.mode);
  validateDecisionModel(settings.decisionModel);
  db.connection.prepare(`
    INSERT INTO material_retrieval_settings (singleton, mode, decision_model)
    VALUES (1, @mode, @decisionModel)
    ON CONFLICT(singleton) DO UPDATE SET mode = excluded.mode, decision_model = excluded.decision_model
  `).run(settings);
  return settings;
}

export async function readMaterialRetrievalSettings(db: AppDatabase): Promise<MaterialRetrievalSettings> {
  const runtime = db.connection.inTransaction ? undefined : db.runtimeAuditReader;
  const reply = await runtime?.materialRetrievalData({ kind: "getSettings" });
  return reply?.status === "settings" ? reply.settings : getMaterialRetrievalSettings(db);
}

export async function writeMaterialRetrievalSettings(
  db: AppDatabase, patch: Partial<MaterialRetrievalSettings>,
): Promise<MaterialRetrievalSettings> {
  const runtime = db.connection.inTransaction ? undefined : db.runtimeAuditReader;
  const rustRequired = db.connection.readonly || runtime?.supervised === true;
  if (!runtime) {
    if (db.connection.readonly) throw new Error("只读数据库模式下无法修改资料检索设置");
    return setMaterialRetrievalSettings(db, patch);
  }
  const mode = Object.hasOwn(patch, "mode") ? patch.mode : undefined;
  const setDecisionModel = Object.hasOwn(patch, "decisionModel");
  if (Object.hasOwn(patch, "mode")) validateMode(mode);
  if (setDecisionModel) validateDecisionModel(patch.decisionModel);
  const decisionModel = setDecisionModel ? patch.decisionModel ?? null : null;
  if (decisionModel && /[\uD800-\uDFFF]/u.test(decisionModel)) {
    if (rustRequired) throw new Error("无效的决策模型名称");
    return setMaterialRetrievalSettings(db, patch);
  }
  const reply = await runtime.materialRetrievalData({ kind: "setSettings", mode, decisionModel, setDecisionModel });
  if (reply?.status === "settings") return reply.settings;
  if (reply?.status === "needsHost" && !rustRequired) return setMaterialRetrievalSettings(db, patch);
  throw new Error(reply?.status === "rejected" ? reply.message : "资料检索设置保存未获确认，请刷新后重试");
}

type SpaceRow = { id: string; parent_id: string | null; mode: MaterialRetrievalMode | null };
type ProjectRow = { id: string; default_space_id: string | null; mode: MaterialRetrievalMode | null };

const SELECT_SPACE_POLICY = `
  SELECT s.id, s.parent_id, o.mode FROM spaces s LEFT JOIN material_retrieval_spaces o ON s.id = o.id
`;
const SELECT_PROJECT_POLICY = `
  SELECT p.id, p.default_space_id, o.mode FROM projects p LEFT JOIN material_retrieval_projects o ON p.id = o.id
`;

function effectiveSpacePolicy(
  getSpace: (id: string) => SpaceRow | undefined,
  spaceId: string | null,
  global: MaterialRetrievalMode,
): Omit<MaterialRetrievalScopeSettings, "override"> {
  const seen = new Set<string>();
  while (spaceId && !seen.has(spaceId)) {
    seen.add(spaceId);
    const space = getSpace(spaceId);
    if (!space) break;
    if (space.mode) return { effective: space.mode, source: "space", sourceId: space.id };
    spaceId = space.parent_id;
  }
  return { effective: global, source: "global", sourceId: null };
}

export function resolveMaterialRetrievalScope(
  db: AppDatabase,
  scope?: MaterialRetrievalScope,
): MaterialRetrievalScopeSettings {
  const global = getMaterialRetrievalSettings(db).mode;
  const stmt = db.connection.prepare(SELECT_SPACE_POLICY + " WHERE s.id = ?");
  const getSpace = (id: string) => stmt.get(id) as SpaceRow | undefined;
  let spaceId: string | null = null;
  let override: MaterialRetrievalMode | null = null;
  if (scope?.kind === "project") {
    const project = db.connection.prepare(SELECT_PROJECT_POLICY + " WHERE p.id = ?").get(scope.id) as ProjectRow | undefined;
    if (project?.mode) return { override: project.mode, effective: project.mode, source: "project", sourceId: project.id };
    spaceId = project?.default_space_id ?? null;
  } else if (scope?.kind === "space") {
    spaceId = scope.id;
    override = getSpace(spaceId)?.mode ?? null;
  }
  return { override, ...effectiveSpacePolicy(getSpace, spaceId, global) };
}

export function setMaterialRetrievalScope(
  db: AppDatabase,
  scope: MaterialRetrievalScope,
  mode: MaterialRetrievalMode | null,
): MaterialRetrievalScopeSettings {
  if (db.readonly || db.runtimeAuditReader?.supervised) {
    throw new Error("资料检索范围设置在只读/受监督模式下仅允许通过 Rust 核心保存");
  }
  if (scope?.kind !== "space" && scope?.kind !== "project") throw new Error("未知的资料检索范围");
  const isProject = scope.kind === "project";
  if (isProject) {
    const project = db.connection.prepare("SELECT archived, default_space_id AS spaceId FROM projects WHERE id = ?")
      .get(scope.id) as { archived: number; spaceId: string | null } | undefined;
    if (!project) throw new Error("资料检索范围已不存在");
    if (project.archived || (project.spaceId && db.isSpaceEffectiveArchived(project.spaceId))) {
      throw new Error("归档项目的资料检索设置为只读");
    }
  } else {
    const space = db.getSpace(scope.id);
    if (!space) throw new Error("资料检索范围已不存在");
    if (space.effectiveArchived) throw new Error("归档空间的资料检索设置为只读");
  }
  const table = isProject ? "material_retrieval_projects" : "material_retrieval_spaces";
  if (mode === null) {
    db.connection.prepare(`DELETE FROM ${table} WHERE id = ?`).run(scope.id);
  } else {
    validateMode(mode);
    db.connection.prepare(`
      INSERT INTO ${table} (id, mode) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET mode = excluded.mode
    `).run(scope.id, mode);
  }
  return resolveMaterialRetrievalScope(db, scope);
}

function nativeScope(scope: MaterialRetrievalScope): boolean {
  return typeof scope.id === "string" && !/[\uD800-\uDFFF]/u.test(scope.id);
}

export async function readMaterialRetrievalScope(
  db: AppDatabase, scope?: MaterialRetrievalScope,
): Promise<MaterialRetrievalScopeSettings> {
  const runtime = db.connection.inTransaction ? undefined : db.runtimeAuditReader;
  if (!runtime || (scope && !nativeScope(scope))) return resolveMaterialRetrievalScope(db, scope);
  const queryScope = scope?.kind === "space" || scope?.kind === "project" ? scope : undefined;
  const reply = await runtime.materialRetrievalData({ kind: "getScope", scope: queryScope });
  return reply?.status === "scope" ? reply.settings : resolveMaterialRetrievalScope(db, scope);
}

export async function writeMaterialRetrievalScope(
  db: AppDatabase, scope: MaterialRetrievalScope, mode: MaterialRetrievalMode | null,
): Promise<MaterialRetrievalScopeSettings> {
  const runtime = db.connection.inTransaction ? undefined : db.runtimeAuditReader;
  const rustRequired = db.connection.readonly || runtime?.supervised === true;
  if (!runtime) {
    if (db.connection.readonly) throw new Error("只读数据库模式下无法修改资料检索范围");
    return setMaterialRetrievalScope(db, scope, mode);
  }
  if ((scope?.kind !== "space" && scope?.kind !== "project") || !nativeScope(scope) ||
    (mode !== null && mode !== "keyword" && mode !== "hybrid")) {
    if (rustRequired) throw new Error("资料检索范围参数无效");
    return setMaterialRetrievalScope(db, scope, mode);
  }
  const reply = await runtime.materialRetrievalData({ kind: "setScope", scope, mode });
  if (reply?.status === "scope") return reply.settings;
  if (reply?.status === "needsHost" && !rustRequired) return setMaterialRetrievalScope(db, scope, mode);
  throw new Error(reply?.status === "rejected" ? reply.message : "资料检索范围保存未获确认，请刷新后重试");
}

export function hybridLibrarySpaceIds(db: AppDatabase): string[] {
  const global = getMaterialRetrievalSettings(db).mode;
  const spaces = new Map((db.connection.prepare(SELECT_SPACE_POLICY).all() as SpaceRow[]).map(row => [row.id, row]));
  const projects = new Map((db.connection.prepare(SELECT_PROJECT_POLICY).all() as ProjectRow[]).map(row => [row.id, row]));
  const owners = db.connection.prepare("SELECT id, workspace_id, project_id FROM library_spaces").all() as Array<{
    id: string; workspace_id: string | null; project_id: string | null;
  }>;
  const getSpace = (id: string) => spaces.get(id);
  return owners.filter(owner => {
    const project = owner.project_id ? projects.get(owner.project_id) : undefined;
    const spaceId = project?.default_space_id ?? owner.workspace_id;
    return (project?.mode ?? effectiveSpacePolicy(getSpace, spaceId, global).effective) === "hybrid";
  }).map(owner => owner.id);
}
