import { flag, number } from "./parameters";
import { pstackDecisionLogPath, workspaceDocumentPath } from "./paths";
import { PSTACK_PLAYBOOKS } from "./playbooks";
import { PSTACK_EFFORTS, PSTACK_ROLES, PSTACK_ROLE_COUNT_MAX, pstackRoleMinimumCount } from "./roles";
import { PSTACK_SKILLS } from "./skills";
import { THERMOS_CRITERIA, THERMOS_REVIEWER_ROLES } from "./thermos";
import type { PstackEntrySettings, PstackParameter, PstackRoleSettings, PstackSettings, PstackValue } from "./types";

type Input = Record<string, unknown>;
type Definition = { id: string; parameters: PstackParameter[] };

// Missing fields are defaults for new or partial profiles. Invalid present fields are
// reported on save and may be repaired independently when reading a damaged profile.
function section(raw: unknown, path: string, keys: string[], errors: string[]): Input {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${path} 必须是配置对象`);
    return {};
  }
  const result: Input = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (keys.includes(key)) result[key] = value;
    else errors.push(`${path}.${key} 不是已注册的配置项`);
  }
  return result;
}

function read<T>(value: unknown, fallback: T, valid: (candidate: unknown) => boolean, path: string, expected: string, errors: string[]): T {
  if (value === undefined) return fallback;
  if (valid(value)) return value as T;
  errors.push(`${path} 应为${expected}`);
  return fallback;
}

const isBoolean = (value: unknown) => typeof value === "boolean";
const inRange = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const modelId = /^[^\s/]+\/[^\s]+$/u;
const modelAlias = /^(?!(?:__proto__|constructor|prototype)$)[a-z\d_-]+$/iu;

function parameterValue(raw: unknown, param: PstackParameter, path: string, errors: string[]): PstackValue {
  if (path === "playbooks.multi-phase-plan.parameters.planPath" && typeof raw === "string" && raw !== "") {
    try { return workspaceDocumentPath(raw, "计划文档"); }
    catch (error) { errors.push(`${path}：${(error as Error).message}`); return param.defaultValue; }
  }
  if (path === "skills.show-me-your-work.parameters.logPath" && raw !== undefined) {
    try { return pstackDecisionLogPath(raw); }
    catch (error) { errors.push(`${path}：${(error as Error).message}`); return param.defaultValue; }
  }
  if (path === "skills.setup-pstack.parameters.excludeModels" && typeof raw === "string") {
    const invalid = raw.split(/[,，\n]/).map(id => id.trim()).filter(Boolean).find(id => !modelId.test(id));
    if (invalid) {
      errors.push(`${path} 排除项 ${invalid} 应为完整的 provider/model`);
      return param.defaultValue;
    }
  }
  switch (param.type) {
    case "boolean": return read(raw, param.defaultValue, isBoolean, path, "开关值", errors);
    case "select": return read(raw, param.defaultValue, v => typeof v === "string" && !!param.options?.includes(v), path, (param.options ?? []).join(" / "), errors);
    case "text": return read(raw, param.defaultValue, v => typeof v === "string", path, "文本", errors);
    case "number": {
      const min = param.min ?? Number.MIN_SAFE_INTEGER, max = param.max ?? Number.MAX_SAFE_INTEGER;
      return read(raw, param.defaultValue, v => inRange(v, min, max), path, max === Number.MAX_SAFE_INTEGER ? `至少 ${min} 的整数` : `${min} 至 ${max} 的整数`, errors);
    }
  }
}

function entries(raw: unknown, defs: Definition[], group: string, errors: string[]): Record<string, PstackEntrySettings> {
  const values = section(raw, group, defs.map(d => d.id), errors);
  return Object.fromEntries(defs.map(({ id, parameters }) => {
    const path = group + "." + id;
    const entry = section(values[id], path, ["enabled", "parameters"], errors);
    const params = section(entry.parameters, path + ".parameters", parameters.map(p => p.id), errors);
    const normalized = Object.fromEntries(parameters.map(p => [p.id, parameterValue(params[p.id], p, path + ".parameters." + p.id, errors)]));
    if (typeof normalized.ratingMinimum === "number" && typeof normalized.ratingMaximum === "number" && normalized.ratingMinimum >= normalized.ratingMaximum) {
      errors.push(path + ".parameters.ratingMaximum 必须高于评分下限。");
      for (const p of parameters.filter(p=>p.id==="ratingMinimum" || p.id==="ratingMaximum")) normalized[p.id]=p.defaultValue;
    }
    return [id, {
      enabled: read(entry.enabled, true, isBoolean, path + ".enabled", "开关值", errors),
      parameters: normalized,
    }];
  }));
}

function roleSettings(raw: unknown, errors: string[]): PstackSettings["roles"] {
  const values = section(raw, "roles", PSTACK_ROLES.map(r => r.id), errors);
  return Object.fromEntries(PSTACK_ROLES.map(role => {
    const path = "roles." + role.id;
    const item = section(values[role.id], path, ["model", "effort", "count", "isolation"], errors);
    const model = read(item.model, role.defaultModel, v => typeof v === "string" && !/[\x00-\x1f]/u.test(v) && (modelId.test(v) || modelAlias.test(v)), path + ".model", "完整的 provider/model 或原生角色名", errors);
    const minimum = pstackRoleMinimumCount(role.id,model);
    const count = read(item.count, Math.max(minimum, role.defaultCount), v => inRange(v, minimum, PSTACK_ROLE_COUNT_MAX), path + ".count", `${minimum} 至 ${PSTACK_ROLE_COUNT_MAX} 的整数`, errors);
    const effort = read(item.effort, "default", v => typeof v === "string" && PSTACK_EFFORTS.includes(v), path + ".effort", PSTACK_EFFORTS.join(" / "), errors);
    const isolation = read<PstackRoleSettings["isolation"]>(item.isolation, role.defaultIsolation, v => v === "auto" || v === "shared" || v === "worktree", path + ".isolation", "auto / shared / worktree", errors);
    return [role.id, { model, count, effort, isolation }];
  }));
}

export const THERMOS_PARAMETERS = [
  number("changedLines", "变更行数阈值", "本次差异的增加行与删除行之和超过此值时触发。", 200, 0),
  number("fileLines", "单文件行数阈值", "本次改动使文件从阈值内增长到阈值以上时触发。", 1000, 0),
  number("specialCases", "分散特例数量阈值", "同一行为在不同位置出现的特例达到此数量时触发。", 3),
  flag("onRequest", "按请求评审", "明确要求 Thermos 审查时触发。", true),
  flag("beforeMerge", "合并前评审", "进入合并前检查时触发。", true),
];

function thermosSettings(raw: unknown, errors: string[]): PstackSettings["thermos"] {
  const item = section(raw, "thermos", [...THERMOS_PARAMETERS.map(p => p.id), "criteria", "reviewerRole"], errors);
  const [changedLines, fileLines, specialCases, onRequest, beforeMerge] = THERMOS_PARAMETERS.map(p => parameterValue(item[p.id], p, "thermos." + p.id, errors));
  const criteria = section(item.criteria, "thermos.criteria", THERMOS_CRITERIA.map(c => c.id), errors);
  return {
    changedLines: changedLines as number,
    fileLines: fileLines as number,
    specialCases: specialCases as number,
    onRequest: onRequest as boolean,
    beforeMerge: beforeMerge as boolean,
    reviewerRole: read(item.reviewerRole, THERMOS_REVIEWER_ROLES[0], v => typeof v === "string" && THERMOS_REVIEWER_ROLES.includes(v), "thermos.reviewerRole", THERMOS_REVIEWER_ROLES.join(" / "), errors),
    criteria: Object.fromEntries(THERMOS_CRITERIA.map(({ id }) => [id, read(criteria[id], true, isBoolean, "thermos.criteria." + id, "开关值", errors)])),
  };
}

function parse(raw: unknown, errors: string[]): PstackSettings {
  const cfg = section(raw, "pstackThermos", ["skills", "playbooks", "roles", "thermos"], errors);
  return {
    skills: entries(cfg.skills, PSTACK_SKILLS, "skills", errors),
    playbooks: entries(cfg.playbooks, PSTACK_PLAYBOOKS, "playbooks", errors),
    roles: roleSettings(cfg.roles, errors),
    thermos: thermosSettings(cfg.thermos, errors),
  };
}

export function normalizePstackSettings(raw?: unknown): PstackSettings {
  return parse(raw, []);
}

export function validatePstackSettings(raw: unknown): string[] {
  const errors: string[] = [];
  parse(raw, errors);
  return errors;
}
