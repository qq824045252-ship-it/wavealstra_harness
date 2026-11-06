import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  BotChannelBindingDto,
  BotDto,
  BotLifecycleStatus,
  ExpertConfigSnapshotDto,
  ExpertProfileDto,
  WorkAuthorizationDto,
} from "../../../shared/bot-work";
import { DEFAULT_BOT_ID, minimumAuthorization } from "../../../shared/bot-work";

interface BotRow {
  bot_id: string;
  user_id: string;
  display_name: string;
  responsibility_summary: string;
  expert_profile_json: string;
  memory_scope_json: string;
  authorization_json: string;
  foreground_allowed_tools_json: string;
  notification_policy_json: string;
  status: BotLifecycleStatus;
  created_at: number;
  updated_at: number;
}

interface ExpertVersionRow {
  bot_id: string;
  version: number;
  state: "pending" | "active" | "superseded";
  expert_id: string;
  source_revision: string;
  system_prompt_hash: string;
  allowed_mcp_ids_json: string;
  allowed_skill_ids_json: string;
  allowed_connector_ids_json: string;
  staged_by: string;
  created_at: number;
  adopted_at: number | null;
  configuration_json: string | null;
  skill_packages_json: string;
}

export interface RegisterBotInput {
  botId?: string;
  userId: string;
  displayName: string;
  responsibilitySummary?: string;
  expertProfile?: Partial<ExpertProfileDto>;
  authorization?: Partial<WorkAuthorizationDto>;
  memoryScope?: Partial<BotDto["memoryScope"]>;
  foregroundAllowedTools?: string[];
  notificationPolicyJson?: string;
  status?: BotLifecycleStatus;
}

export interface StageExpertVersionInput {
  expertId: string;
  sourceRevision: string;
  systemPromptHash: string;
  allowedMcpIds?: string[];
  allowedSkillIds?: string[];
  allowedConnectorIds?: string[];
  stagedBy: string;
  configuration?: ExpertConfigSnapshotDto["configuration"];
  skillPackages?: ExpertConfigSnapshotDto["skillPackages"];
}

export type ExpertAdoptionResult =
  | { ok: true; bot: BotDto; adoptedVersion: number }
  | { ok: false; code: "not_found" | "no_pending_version" | "version_conflict"; message: string; latestBot?: BotDto };

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function defaultExpertProfile(): ExpertProfileDto {
  const instructions = "作为长期主负责人，澄清委托、维护 Work、核对成果与证据。仅在已授权范围内安排执行，不把推测或执行完成当作目标验收。";
  return {
    expertId: "expert-default-coordinator",
    revision: "default-v1",
    systemPromptHash: createHash("sha256").update(instructions).digest("hex"),
    version: 1,
    allowedMcpIds: [],
    allowedSkillIds: [],
    allowedConnectorIds: [],
    capturedAt: Date.now(),
    desiredVersion: 1,
    activeVersion: 1,
    configuration: { revision: "default-v1", name: "MyBuddy", instructions, skillIds: [], mcpIds: [], connectorIds: [] },
    skillPackages: [],
  };
}

function activeSnapshot(profile: ExpertProfileDto): ExpertConfigSnapshotDto {
  return {
    expertId: profile.expertId,
    revision: profile.revision,
    version: profile.activeVersion,
    systemPromptHash: profile.systemPromptHash,
    allowedMcpIds: [...profile.allowedMcpIds],
    allowedSkillIds: [...profile.allowedSkillIds],
    allowedConnectorIds: [...profile.allowedConnectorIds],
    capturedAt: profile.capturedAt,
    configuration: profile.configuration,
    skillPackages: profile.skillPackages,
  };
}

export class BotRegistry {
  constructor(private readonly db: Database.Database) {}

  registerBot(input: RegisterBotInput): BotDto {
    const now = Date.now();
    const botId = input.botId ?? DEFAULT_BOT_ID;
    const existing = this.getBot(botId);
    if (existing) {
      if (existing.userId !== input.userId) throw new Error("Bot 不属于该用户");
      return existing;
    }
    const profile: ExpertProfileDto = { ...defaultExpertProfile(), ...input.expertProfile };
    profile.activeVersion = profile.desiredVersion;
    const authorization = normalizeAuthorization(input.authorization);
    this.db.prepare(`INSERT INTO bots (
      bot_id,user_id,display_name,responsibility_summary,expert_profile_json,memory_scope_json,
      authorization_json,foreground_allowed_tools_json,notification_policy_json,status,created_at,updated_at
    ) VALUES (@botId,@userId,@displayName,@responsibilitySummary,@expertProfileJson,@memoryScopeJson,
      @authorizationJson,@foregroundAllowedToolsJson,@notificationPolicyJson,@status,@now,@now)`).run({
      botId,
      userId: input.userId,
      displayName: input.displayName,
      responsibilitySummary: input.responsibilitySummary ?? "",
      expertProfileJson: JSON.stringify(profile),
      memoryScopeJson: JSON.stringify({
        personalMemoryNamespace: `mem-${botId}`,
        sharePersonalMemoryWithTeam: false,
        allowUnconfirmedSpeculationInMemory: false,
        ...input.memoryScope,
      }),
      authorizationJson: JSON.stringify(authorization),
      foregroundAllowedToolsJson: JSON.stringify(input.foregroundAllowedTools ?? [
        "work_query_status", "work_create", "work_amend", "work_pause", "work_resume", "work_cancel", "memory_search",
      ]),
      notificationPolicyJson: input.notificationPolicyJson ?? JSON.stringify({ inAppCard: true }),
      status: input.status ?? "active",
      now,
    });
    this.db.prepare(`INSERT OR IGNORE INTO bot_expert_versions (
      bot_id,version,state,expert_id,source_revision,system_prompt_hash,allowed_mcp_ids_json,
      allowed_skill_ids_json,allowed_connector_ids_json,staged_by,created_at,adopted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      botId, profile.activeVersion, "active", profile.expertId, profile.revision, profile.systemPromptHash,
      JSON.stringify(profile.allowedMcpIds), JSON.stringify(profile.allowedSkillIds),
      JSON.stringify(profile.allowedConnectorIds), "host", now, now,
    );
    return this.getBot(botId)!;
  }

  ensureDefaultBot(userId: string): BotDto {
    return this.registerBot({
      botId: DEFAULT_BOT_ID,
      userId,
      displayName: "MyBuddy",
      responsibilitySummary: "默认长期主负责人 Bot",
    });
  }

  getBot(botId: string): BotDto | undefined {
    const row = this.db.prepare("SELECT * FROM bots WHERE bot_id=?").get(botId) as BotRow | undefined;
    return row ? this.mapBot(row) : undefined;
  }

  listBots(userId: string): BotDto[] {
    return (this.db.prepare("SELECT * FROM bots WHERE user_id=? ORDER BY created_at ASC").all(userId) as BotRow[])
      .map((row) => this.mapBot(row));
  }

  activeSnapshot(botId: string): ExpertConfigSnapshotDto | undefined {
    const bot = this.getBot(botId);
    if (!bot) return undefined;
    const row = this.db.prepare("SELECT * FROM bot_expert_versions WHERE bot_id=? AND state='active'").get(botId) as ExpertVersionRow | undefined;
    return {
      ...activeSnapshot(bot.expertProfile),
      configuration: row ? parseJson(row.configuration_json, bot.expertProfile.configuration) : bot.expertProfile.configuration,
      skillPackages: row ? parseJson(row.skill_packages_json, []) : [],
    };
  }

  bindChannel(binding: BotChannelBindingDto): void {
    const bot = this.getBot(binding.botId);
    if (!bot) throw new Error("Bot 不存在");
    const existing = this.resolveBotByChannel(binding.channelType, binding.channelIdentifier);
    if (existing && existing.userId !== bot.userId) throw new Error("不能覆盖其他用户的渠道绑定");
    this.db.prepare(`INSERT INTO bot_channel_bindings (channel_type,channel_identifier,bot_id,bound_at)
      VALUES (?,?,?,?) ON CONFLICT(channel_type,channel_identifier)
      DO UPDATE SET bot_id=excluded.bot_id, bound_at=excluded.bound_at`)
      .run(binding.channelType, binding.channelIdentifier, binding.botId, binding.boundAt);
  }

  resolveBotByChannel(channelType: BotChannelBindingDto["channelType"], channelIdentifier: string): BotDto | undefined {
    const row = this.db.prepare(`SELECT b.* FROM bots b
      INNER JOIN bot_channel_bindings c ON b.bot_id=c.bot_id
      WHERE c.channel_type=? AND c.channel_identifier=?`).get(channelType, channelIdentifier) as BotRow | undefined;
    return row ? this.mapBot(row) : undefined;
  }

  /**
   * R09: stage the *complete* next configuration as one immutable row. A later stage
   * supersedes the pending row with a new immutable version; nothing is merged with the
   * active snapshot while a user is still reviewing.
   */
  stageExpertVersion(
    botId: string,
    input: StageExpertVersionInput,
    now = Date.now(),
  ): { ok: true; bot: BotDto; pendingVersion: number } | { ok: false; code: "not_found"; message: string } {
    const tx = this.db.transaction(() => {
      const bot = this.getBot(botId);
      if (!bot) return { ok: false as const, code: "not_found" as const, message: "找不到 Bot" };
      const pending = this.getPendingVersionRow(botId);
      const nextVersion = Math.max(bot.expertProfile.desiredVersion, bot.expertProfile.activeVersion) + 1;
      if (pending) {
        this.db.prepare("UPDATE bot_expert_versions SET state='superseded' WHERE bot_id=? AND version=?").run(botId, pending.version);
      }
      this.db.prepare(`INSERT INTO bot_expert_versions (
        bot_id,version,state,expert_id,source_revision,system_prompt_hash,allowed_mcp_ids_json,
        allowed_skill_ids_json,allowed_connector_ids_json,staged_by,created_at,configuration_json,skill_packages_json
      ) VALUES (?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(
        botId, nextVersion, input.expertId, input.sourceRevision, input.systemPromptHash,
        JSON.stringify(input.allowedMcpIds ?? []), JSON.stringify(input.allowedSkillIds ?? []),
        JSON.stringify(input.allowedConnectorIds ?? []), input.stagedBy, now,
        input.configuration ? JSON.stringify(input.configuration) : null, JSON.stringify(input.skillPackages ?? []),
      );
      const profile: ExpertProfileDto = {
        ...bot.expertProfile,
        desiredVersion: nextVersion,
        pendingVersion: nextVersion,
      };
      this.writeProfile(botId, profile, now);
      return { ok: true as const, bot: this.getBot(botId)!, pendingVersion: nextVersion };
    });
    return tx.immediate();
  }

  /**
   * R09: adopt exactly the reviewed pending version or refuse. The whole row (prompt
   * hash plus MCP/skill/connector lists) is copied in one transaction, so a version
   * number can never be paired with another version's content.
   */
  adoptExpertVersion(
    botId: string,
    expected: { pendingVersion?: number; snapshotId?: string },
    now = Date.now(),
  ): ExpertAdoptionResult {
    const tx = this.db.transaction((): ExpertAdoptionResult => {
      const bot = this.getBot(botId);
      if (!bot) return { ok: false, code: "not_found", message: "找不到 Bot" };
      const pending = this.getPendingVersionRow(botId);
      if (!pending) {
        return { ok: false, code: "no_pending_version", message: "没有待审阅的专家配置版本" };
      }
      const expectedVersion = expected.pendingVersion ?? (expected.snapshotId ? pending.version : undefined);
      if (expected.snapshotId && expected.snapshotId !== `expert:${botId}:v${pending.version}`) {
        return {
          ok: false, code: "version_conflict",
          message: `审阅的配置快照已不再是待采纳版本（当前待采纳 v${pending.version}）`,
          latestBot: bot,
        };
      }
      if (expectedVersion !== pending.version) {
        return {
          ok: false, code: "version_conflict",
          message: `审阅的版本 v${expectedVersion} 已被 v${pending.version} 取代，拒绝把旧提示词绑定到新版本`,
          latestBot: bot,
        };
      }
      this.db.prepare("UPDATE bot_expert_versions SET state='superseded' WHERE bot_id=? AND state='active'").run(botId);
      this.db.prepare(`UPDATE bot_expert_versions SET state='active', adopted_at=? WHERE bot_id=? AND version=?`)
        .run(now, botId, pending.version);
      const profile: ExpertProfileDto = {
        expertId: pending.expert_id,
        revision: pending.source_revision,
        version: pending.version,
        systemPromptHash: pending.system_prompt_hash,
        allowedMcpIds: parseJson<string[]>(pending.allowed_mcp_ids_json, []),
        allowedSkillIds: parseJson<string[]>(pending.allowed_skill_ids_json, []),
        allowedConnectorIds: parseJson<string[]>(pending.allowed_connector_ids_json, []),
        capturedAt: now,
        desiredVersion: pending.version,
        activeVersion: pending.version,
        configuration: parseJson(pending.configuration_json, undefined),
        skillPackages: parseJson(pending.skill_packages_json, []),
      };
      this.writeProfile(botId, profile, now);
      return { ok: true, bot: this.getBot(botId)!, adoptedVersion: pending.version };
    });
    return tx.immediate();
  }

  /**
   * Disabling keeps responsibility and settlement records. It never cascades into
   * works: the caller gets the affected ids so the UI can show them.
   */
  disableBot(botId: string, now = Date.now()): { ok: boolean; bot?: BotDto; affectedActiveWorkIds: string[] } {
    const bot = this.getBot(botId);
    if (!bot) return { ok: false, affectedActiveWorkIds: [] };
    const activeWorks = this.db.prepare(
      "SELECT work_id FROM works WHERE owner_bot_id=? AND lifecycle != 'closed'",
    ).all(botId) as Array<{ work_id: string }>;
    this.db.prepare("UPDATE bots SET status='disabled', updated_at=? WHERE bot_id=?").run(now, botId);
    return { ok: true, bot: this.getBot(botId), affectedActiveWorkIds: activeWorks.map((row) => row.work_id) };
  }

  /**
   * Hard delete is only allowed when the bot holds no responsibility and no unsettled
   * execution. Otherwise the caller must hand off / close first.
   */
  deleteBot(botId: string): { ok: true } | { ok: false; code: "not_found" | "has_responsibility"; message: string; blockingWorkIds?: string[] } {
    const bot = this.getBot(botId);
    if (!bot) return { ok: false, code: "not_found", message: "找不到 Bot" };
    const owned = this.db.prepare("SELECT work_id FROM works WHERE owner_bot_id=?").all(botId) as Array<{ work_id: string }>;
    const participating = this.db.prepare("SELECT work_id FROM work_participants WHERE bot_id=?").all(botId) as Array<{ work_id: string }>;
    const unsettled = this.db.prepare(`SELECT DISTINCT b.work_id FROM work_execution_bindings b
      WHERE (b.bot_id=? OR b.work_id IN (SELECT work_id FROM works WHERE owner_bot_id=?)) AND b.settled_at IS NULL`).all(botId, botId) as Array<{ work_id: string }>;
    const blocking = [...new Set([...owned, ...participating, ...unsettled].map((row) => row.work_id))];
    if (blocking.length > 0) {
      return {
        ok: false, code: "has_responsibility",
        message: "Bot 仍有责任或未结算的执行，不能删除", blockingWorkIds: blocking,
      };
    }
    this.db.prepare("DELETE FROM bot_channel_bindings WHERE bot_id=?").run(botId);
    this.db.prepare("DELETE FROM bot_expert_versions WHERE bot_id=?").run(botId);
    this.db.prepare("DELETE FROM bots WHERE bot_id=?").run(botId);
    return { ok: true };
  }

  private getPendingVersionRow(botId: string): ExpertVersionRow | undefined {
    return this.db.prepare("SELECT * FROM bot_expert_versions WHERE bot_id=? AND state='pending' LIMIT 1")
      .get(botId) as ExpertVersionRow | undefined;
  }

  private writeProfile(botId: string, profile: ExpertProfileDto, now: number): void {
    this.db.prepare("UPDATE bots SET expert_profile_json=?, updated_at=? WHERE bot_id=?")
      .run(JSON.stringify(profile), now, botId);
  }

  private mapBot(row: BotRow): BotDto {
    return {
      botId: row.bot_id,
      userId: row.user_id,
      displayName: row.display_name,
      responsibilitySummary: row.responsibility_summary,
      expertProfile: parseJson<ExpertProfileDto>(row.expert_profile_json, defaultExpertProfile()),
      memoryScope: parseJson<BotDto["memoryScope"]>(row.memory_scope_json, {
        personalMemoryNamespace: `mem-${row.bot_id}`,
        sharePersonalMemoryWithTeam: false,
        allowUnconfirmedSpeculationInMemory: false,
      }),
      authorization: parseJson<WorkAuthorizationDto>(row.authorization_json, minimumAuthorization()),
      foregroundAllowedTools: parseJson<string[]>(row.foreground_allowed_tools_json, []),
      notificationPolicyJson: row.notification_policy_json,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function normalizeAuthorization(input: Partial<WorkAuthorizationDto> | undefined): WorkAuthorizationDto {
  const minimum = minimumAuthorization();
  return {
    allowedScopes: [...new Set(input?.allowedScopes ?? minimum.allowedScopes)],
    targetWhitelist: [...new Set(input?.targetWhitelist ?? [])],
    allowGitBranchOrWorktree: Boolean(input?.allowGitBranchOrWorktree),
    allowRedelegation: Boolean(input?.allowRedelegation),
    ...(typeof input?.budgetLimitTokens === "number" ? { budgetLimitTokens: input.budgetLimitTokens } : {}),
    ...(typeof input?.expiresAt === "number" ? { expiresAt: input.expiresAt } : {}),
  };
}

export function newBotId(): string {
  return `bot-${randomUUID()}`;
}
