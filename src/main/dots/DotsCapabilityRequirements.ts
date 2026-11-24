import { dotsCapabilityKinds, type DotsCapabilityRequirement } from "../../shared/dots";

const capabilityId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;

export function dotsCapabilityRequirements(
  ...lists: Array<readonly DotsCapabilityRequirement[] | undefined>
): DotsCapabilityRequirement[] {
  const requirements = new Map<string, DotsCapabilityRequirement>();
  for (const list of lists) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 12) throw new Error("Dots 必要能力最多可指定 12 项。");
    for (const item of list) {
      if (!item || !dotsCapabilityKinds.includes(item.kind) || typeof item.id !== "string" || !capabilityId.test(item.id)
        || (item.tool !== undefined && (item.kind !== "mcp" || typeof item.tool !== "string" || !capabilityId.test(item.tool)))) {
        throw new Error("Dots 必要能力需要已有能力的类型和精确 ID。只有 MCP 可以另外指定工具名。");
      }
      const { kind, id, tool } = item;
      requirements.set(JSON.stringify([kind, id, tool]), tool ? { kind, id, tool } : { kind, id });
    }
  }
  if (requirements.size > 12) throw new Error("Dots 必要能力最多可指定 12 项。");
  return [...requirements.values()];
}

const capabilityLabels: Record<DotsCapabilityRequirement["kind"], string> = {
  tool: "工具", skill: "技能", connector: "连接器", expert: "专家", mode: "场景", preset: "场景预设", mcp: "MCP",
};

export class DotsCapabilityUnavailable extends Error {
  constructor(readonly requirement: DotsCapabilityRequirement, reason: string) {
    const name = requirement.id + (requirement.tool ? " / " + requirement.tool : "");
    super("执行配置缺少所需" + capabilityLabels[requirement.kind] + "「" + name + "」。" + reason);
  }
}
