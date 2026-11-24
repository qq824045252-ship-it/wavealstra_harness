import { dotsCapabilityKinds, type DotsCapabilityRequirement } from "../../shared/dots";
import type { WelcomeMode } from "../../shared/mode-profile";
import { dotsInstructionText } from "./DotsFollowUpInput";

const capabilityId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u;

type DotsExecutionChoice = { id: string; label: string };

export type DotsExecutionConfiguration = {
  welcomeMode?: WelcomeMode;
  modePresetId?: string;
  expertId?: string;
  connectorIds?: string[];
};

export type DotsExecutionCatalog = {
  defaultMode: WelcomeMode;
  modes: readonly (DotsExecutionChoice & {
    id: WelcomeMode;
    presets: readonly DotsExecutionChoice[];
    skills?: readonly string[];
    mcp?: readonly string[];
  })[];
  experts: readonly DotsExecutionChoice[];
  connectors: readonly DotsExecutionChoice[];
};

export type DotsExecutionSelection = DotsExecutionConfiguration & { authorizationQuote: string };

const modeAliases: Readonly<Record<WelcomeMode, readonly string[]>> = {
  coding: ["编程模式", "编码模式", "开发模式", "编程任务", "开发任务"],
  working: ["办公模式", "办公任务"],
  general: ["通用任务"],
};

const choiceAction = /(?:新建|创建|开(?:个|一个)|委派|交给|交办|指定|选择|选用|采用|使用|用(?!途|法|语|户|例|处)|\b(?:use|select|choose|create|start|delegate|assign)\b)/iu;
const negativeChoice = /(?:不要|不用|不必|无需|不需要|别|禁止|避免|不能|\b(?:don['’]t|do not|without|avoid|instead of)\b)/iu;
const hypotheticalChoice = /(?:仅了解|想知道|能否|可否|是否|能不能|怎么|如何|比较|对比|比如|示例|举例|例子|假如|假设|如果|\b(?:if|how|what|whether|can I|could)\b)/iu;
const introductoryCondition = /^\s*(?:(?:比如|举例|例如|示例|假如|假设|如果|这是.{0,6}(?:示例|例子))|\b(?:if|suppose|for example)\b)/iu;
const choiceQuestion = /^(?:\s*(?:场景|模式|预设|专家|连接器|任务|mode|preset|expert|connector|task)\s*)?(?:可以吗|行吗|吗|能不能|能否|好不好|哪个好|哪个更|还是|或者|\bor\b|[?？])/iu;

function choicePosition(text: string, name: string): { start: number; end: number } | undefined {
  const normalized = name.normalize("NFKC").trim().toLowerCase();
  if (!normalized) return;
  let start = text.indexOf(normalized);
  if (/^[a-z\d_.:-]+$/u.test(normalized)) {
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    start = new RegExp(`(?<![a-z\\d_.:-])${escaped}(?![a-z\\d_.:-])`, "u").exec(text)?.index ?? -1;
  }
  if (start >= 0) return { start, end: start + normalized.length };
}

function explicitlySelects(text: string, names: readonly string[]): boolean {
  const statements = text.split(/(?<=[。！？!?；;\n])/u);
  let selected = false;
  let contextual = false;
  for (const statement of statements) {
    for (const clause of statement.split(/[,，]/u)) {
      for (const name of names) {
        const position = choicePosition(clause, name);
        if (!position) continue;
        const before = clause.slice(0, position.start);
        const after = clause.slice(position.end).replace(/^[`"'”’」』]+/u, "").trimStart();
        if (negativeChoice.test(before) || negativeChoice.test(after) && !choiceAction.test(before)) return false;
        if (!contextual && choiceAction.test(before) && !hypotheticalChoice.test(before) && !choiceQuestion.test(after)) selected = true;
      }
      contextual ||= introductoryCondition.test(clause);
    }
  }
  return selected;
}

export function dotsExecutionConfiguration(selection: DotsExecutionSelection, intent: string, catalog: DotsExecutionCatalog): DotsExecutionConfiguration {
  const sourceQuote = selection.authorizationQuote?.trim();
  const instruction = dotsInstructionText(intent);
  if (!sourceQuote || sourceQuote.length > 500 || !instruction.includes(sourceQuote)) throw new Error("请选择本轮原话中明确授权的执行配置。");
  const original = instruction.normalize("NFKC").trim().toLowerCase();
  const quote = sourceQuote.normalize("NFKC").toLowerCase();
  const choices = (label: string, id: string, available: readonly DotsExecutionChoice[], aliases: readonly string[] = []) => {
    const option = available.find(item => item.id === id);
    if (!option) throw new Error(`${label}「${id}」在所选工作空间不可用。`);
    const names = [option.id, option.label, ...aliases];
    if (!explicitlySelects(quote, names) || !explicitlySelects(original, names)) {
      throw new Error(`本轮原话没有明确授权选择${label}「${id}」。`);
    }
  };

  const { welcomeMode, modePresetId, expertId } = selection;
  const connectorIds = [...new Set(selection.connectorIds ?? [])];
  if (connectorIds.length > 8 || !welcomeMode && !modePresetId && !expertId && !connectorIds.length) throw new Error("执行配置需要已授权的场景、预设、专家或连接器。");
  if (welcomeMode) choices("场景", welcomeMode, catalog.modes, modeAliases[welcomeMode]);
  if (modePresetId) choices("预设", modePresetId, catalog.modes.find(item => item.id === (welcomeMode ?? catalog.defaultMode))?.presets ?? []);
  if (expertId) choices("专家", expertId, catalog.experts);
  for (const id of connectorIds) choices("连接器", id, catalog.connectors);
  return { welcomeMode, modePresetId, expertId, ...(connectorIds.length ? { connectorIds } : {}) };
}

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
