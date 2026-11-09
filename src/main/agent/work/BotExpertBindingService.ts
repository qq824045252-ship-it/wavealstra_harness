import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { TaskExpertSnapshot } from "../../../shared/expert-binding";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { ExpertService } from "../../experts/ExpertService";
import type { TaskExpertBindingService } from "../../experts/TaskExpertBindingService";
import { copyExpertPackages } from "../../experts/ExpertSnapshotFiles";
import { getMyBuddyDir } from "../../paths";
import type { BotRegistry } from "./BotRegistry";

/** Explicit template adoption uses the same task-owned assembly as ordinary experts. */
export class BotExpertBindingService {
  constructor(private readonly bots: BotRegistry, private readonly experts: ExpertService,
    private readonly tasks: TaskExpertBindingService,
    private readonly options: { rootDir?: string; resolveSkillDirectory?: (id: string) => string | undefined } = {}) {}

  stage(botId: string, userId: string, expertId: string) {
    const bot = this.bots.getBot(botId);
    if (!bot || bot.userId !== userId) throw new Error("Bot 不属于当前用户");
    const expert = this.experts.getDetail(expertId);
    if (!expert.enabled) throw new Error("专家已停用");
    const configuration: TaskExpertSnapshot = { revision: randomUUID(), sourceExpertId: expert.id,
      sourceRevision: expert.revision, name: expert.name, instructions: expert.instructions,
      skillIds: expert.skills ?? [], mcpIds: expert.mcpIds, connectorIds: expert.connectorIds };
    const privateRoot = this.experts.getPrivateSkillsDir(expertId);
    const packages = configuration.skillIds.map(id => {
      const candidate = privateRoot ? resolve(privateRoot, id) : undefined;
      const privatePath = candidate && candidate.startsWith(resolve(privateRoot!) + sep) && existsSync(candidate) ? candidate
        : privateRoot && configuration.skillIds.length === 1 && existsSync(join(privateRoot, "SKILL.md")) ? privateRoot : undefined;
      const directory = privatePath ?? this.options.resolveSkillDirectory?.(id);
      if (!directory) throw new Error(`技能「${id}」的完整包不可用`);
      return { id, directory, origin: privatePath ? "private" as const : "global" as const };
    });
    const root = this.options.rootDir ?? join(getMyBuddyDir(), "bot-expert-bindings");
    const skillPackages = copyExpertPackages(join(root, createHash("sha256").update(botId).digest("hex"), configuration.revision), packages);
    return this.bots.stageExpertVersion(botId, { expertId, sourceRevision: expert.revision,
      systemPromptHash: createHash("sha256").update(expert.instructions).digest("hex"),
      allowedMcpIds: [...expert.mcpIds], allowedSkillIds: [...configuration.skillIds],
      allowedConnectorIds: [...expert.connectorIds], stagedBy: userId, configuration, skillPackages });
  }

  assembleSettings(input: import("../../../shared/bot-settings").BotSettingsSaveRequest, userId: string): import("./BotRegistry").StageExpertVersionInput {
    const bot = this.bots.getBot(input.botId);
    if (!bot || bot.userId !== userId) throw new Error("Bot 不属于当前用户");
    const expert = input.expertId ? this.experts.getDetail(input.expertId) : undefined;
    const skillIds = [...new Set([...(expert?.skills ?? []), ...input.skillIds])];
    const configuration: TaskExpertSnapshot = { revision: randomUUID(), sourceExpertId: expert?.id,
      sourceRevision: expert?.revision, name: expert?.name ?? bot.displayName,
      instructions: expert?.instructions ?? `你的名字是 ${bot.displayName}。${bot.responsibilitySummary}`,
      skillIds, mcpIds: [...new Set([...(expert?.mcpIds ?? []), ...input.mcpIds])],
      connectorIds: [...new Set([...(expert?.connectorIds ?? []), ...input.connectorIds])] };
    const privateRoot = expert && this.experts.getPrivateSkillsDir(expert.id);
    const packages = skillIds.map(id => {
      const candidate = privateRoot ? resolve(privateRoot, id) : undefined;
      const privatePath = candidate && candidate.startsWith(resolve(privateRoot!) + sep) && existsSync(join(candidate, "SKILL.md")) ? candidate
        : privateRoot && expert?.skills?.length === 1 && expert.skills.includes(id) && existsSync(join(privateRoot, "SKILL.md")) ? privateRoot : undefined;
      const directory = privatePath ?? this.options.resolveSkillDirectory?.(id);
      if (!directory) throw new Error(`技能「${id}」不可用，请先安装并启用`);
      return { id, directory, origin: privatePath ? "private" as const : "global" as const };
    });
    const skillPackages = copyExpertPackages(join(this.options.rootDir ?? join(getMyBuddyDir(), "bot-expert-bindings"),
      createHash("sha256").update(input.botId).digest("hex"), configuration.revision), packages);
    return { expertId: expert?.id ?? `expert-${input.botId}`, sourceRevision: configuration.revision,
      systemPromptHash: createHash("sha256").update(configuration.instructions).digest("hex"),
      allowedMcpIds: configuration.mcpIds, allowedSkillIds: skillIds, allowedConnectorIds: configuration.connectorIds,
      stagedBy: userId, configuration, skillPackages };
  }

  install(binding: WorkExecutionBindingDto): void {
    const snapshot = binding.expertSnapshot;
    if (snapshot.configuration) this.tasks.installFrozen(binding.taskId, snapshot.configuration, snapshot.skillPackages ?? []);
    else if (snapshot.expertId !== "expert-default-coordinator") throw new Error("执行缺少完整专家配置快照");
  }
}
