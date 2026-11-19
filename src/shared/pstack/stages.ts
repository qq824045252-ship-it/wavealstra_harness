import type { PstackParameter, PstackPlaybook, PstackStage } from "./types";

export function book(id: string, label: string, description: string, stages: PstackStage[], parameters: PstackParameter[] = []): PstackPlaybook {
  return { id, label, description, stages, parameters };
}

export function step(id: string, label: string, instructions: string, skillIds: string[] = [], roleId?: string): PstackStage {
  return { id, label, instructions, skillIds, ...(roleId && { roleId }) };
}

export const delivery = () => step("handoff", "交付与授权", "给出本次结果、证据及剩余事项。用户已要求 PR 时进入 opening-a-pr；仓库和用户对提交、推送、发布的限制继续生效。");
