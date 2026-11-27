import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader } from "../../platform/runtime-audit";
import type {
  BotChannelBindingDto,
  BotDto,
  BotExpertVersionDto,
  BotLifecycleStatus,
  ExpertConfigSnapshotDto,
  ExpertProfileDto,
  WorkAuthorizationDto,
} from "../../../shared/bot-work";
import { DEFAULT_BOT_ID, minimumAuthorization } from "../../../shared/bot-work";
import { enqueueWorkOp, overlayDelete, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites, workDomainRunTx } from "./WorkDomainRuntime";

type BotRow = {
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
};

export type RuntimeBotRow = BotRow & { is_primary: boolean };
export type RuntimeBotListQuery = { kind: "list"; userId: string };
export type RuntimeBotLookup = { kind: "bot"; botId: string }
  | { kind: "channel"; userId: string; channelType: BotChannelBindingDto["channelType"]; channelIdentifier: string };
export type RuntimeBotRegistrationReply = { ok: true; bot: RuntimeBotRow } | { ok: false; reason: "owner_mismatch" };

type ExpertVersionRow = {
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
};

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
  const instructions = "作为长期主负责人，澄清委托、维护 Work、核对成果与证据。根据用户委托安排执行，不把推测或执行完成当作目标验收。";
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

function botRegistration(input: RegisterBotInput) {
  const botId = input.botId ?? DEFAULT_BOT_ID;
  const profile: ExpertProfileDto = { ...defaultExpertProfile(), ...input.expertProfile };
  profile.activeVersion = profile.desiredVersion;
  return {
    botId, userId: input.userId, displayName: input.displayName,
    responsibilitySummary: input.responsibilitySummary ?? "",
    expertProfileJson: JSON.stringify(profile),
    memoryScopeJson: JSON.stringify({
      personalMemoryNamespace: `mem-${botId}`,
      sharePersonalMemoryWithTeam: false,
      allowUnconfirmedSpeculationInMemory: false,
      ...input.memoryScope,
    }),
    authorizationJson: JSON.stringify(normalizeAuthorization(input.authorization)),
    foregroundAllowedToolsJson: JSON.stringify(input.foregroundAllowedTools ?? []),
    notificationPolicyJson: input.notificationPolicyJson ?? JSON.stringify({ inAppCard: true }),
    status: input.status ?? "active", now: Date.now(),
    activeVersion: profile.activeVersion, expertId: profile.expertId, sourceRevision: profile.revision,
    systemPromptHash: profile.systemPromptHash,
    allowedMcpIdsJson: JSON.stringify(profile.allowedMcpIds),
    allowedSkillIdsJson: JSON.stringify(profile.allowedSkillIds),
    allowedConnectorIdsJson: JSON.stringify(profile.allowedConnectorIds),
    configurationJson: JSON.stringify(profile.configuration ?? null),
    skillPackagesJson: JSON.stringify(profile.skillPackages ?? []),
  };
}

function defaultBot(userId: string): RegisterBotInput {
  return { botId: DEFAULT_BOT_ID, userId, displayName: "MyBuddy", responsibilitySummary: "默认长期主负责人 Bot" };
}

export type RuntimeBotRegistration = ReturnType<typeof botRegistration> & { primary: boolean; operationId: string };

export class BotRegistry {
  constructor(private readonly fixture?: Database.Database, private readonly core?: RuntimeAuditReader) {
    if (fixture && !fixture.readonly) {
      fixture.exec(`CREATE TABLE IF NOT EXISTS bot_identity_roles (
        user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role='primary'),
        bot_id TEXT NOT NULL UNIQUE REFERENCES bots(bot_id) ON DELETE CASCADE,
        assigned_at INTEGER NOT NULL, PRIMARY KEY(user_id,role));`);
    }
  }

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("Bot 注册表要求使用 Core");
    return this.fixture;
  }

  async ensureDefaultBotSaved(userId: string): Promise<BotDto> {
    if (!this.core) return this.ensureDefaultBot(userId);
    return this.registerSaved(defaultBot(userId), true);
  }

  async registerSaved(input: RegisterBotInput, primary = false): Promise<BotDto> {
    if (!this.core) return this.registerBot(input);
    const request = { ...botRegistration(input), primary, operationId: randomUUID() };
    let result: RuntimeBotRegistrationReply | undefined;
    try {
      result = await this.core.registerBot(request);
    } catch (error) {
      if (!(error instanceof RuntimeAuditUnknownOperationError)) throw error;
    }
    result ??= await this.core.registerBot(request);
    if (!result) throw new Error("Core 未确认 Bot 登记");
    if (!result.ok) throw new Error("Bot 不属于该用户");
    return this.mapBot(result.bot, result.bot.is_primary);
  }

  async readBot(botId: string): Promise<BotDto | undefined> {
    if (!this.core) return this.getBot(botId);
    const row = await this.core.readBotRegistry({ kind: "bot", botId });
    if (row === undefined) throw new Error("Core 未确认 Bot 查询");
    return row ? this.mapBot(row, row.is_primary) : undefined;
  }

  async readBots(userId: string): Promise<BotDto[]> {
    if (!this.core) return this.listBots(userId);
    const rows = await this.core.readBotRegistry({ kind: "list", userId });
    if (!rows) throw new Error("Core 未确认 Bot 列表查询");
    return rows.map(row => this.mapBot(row, row.is_primary));
  }

  async readChannelBot(userId: string, channelType: BotChannelBindingDto["channelType"], channelIdentifier: string): Promise<BotDto | undefined> {
    if (!this.core) {
      const bot = this.resolveBotByChannel(channelType, channelIdentifier);
      return bot?.userId === userId ? bot : undefined;
    }
    const row = await this.core.readBotRegistry({ kind: "channel", userId, channelType, channelIdentifier });
    if (row === undefined) throw new Error("Core 未确认 Bot 频道查询");
    return row ? this.mapBot(row, row.is_primary) : undefined;
  }

  registerBot(input: RegisterBotInput): BotDto {
    const existing = this.getBot(input.botId ?? DEFAULT_BOT_ID);
    if (existing) {
      if (existing.userId !== input.userId) throw new Error("Bot 不属于该用户");
      return existing;
    }
    const registration = botRegistration(input);
    const { botId, now, expertProfileJson, memoryScopeJson, authorizationJson, foregroundAllowedToolsJson,
      notificationPolicyJson, status, activeVersion, expertId, sourceRevision, systemPromptHash,
      allowedMcpIdsJson, allowedSkillIdsJson, allowedConnectorIdsJson, configurationJson, skillPackagesJson } = registration;
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "bots", botId, {
        bot_id: botId, user_id: input.userId, display_name: input.displayName,
        responsibility_summary: input.responsibilitySummary ?? "",
        expert_profile_json: expertProfileJson, memory_scope_json: memoryScopeJson,
        authorization_json: authorizationJson, foreground_allowed_tools_json: foregroundAllowedToolsJson,
        notification_policy_json: notificationPolicyJson, status, created_at: now, updated_at: now,
      });
      overlaySet(this.db, "bot_expert_versions", `${botId}\0${activeVersion}`, {
        bot_id: botId, version: activeVersion, state: "active", expert_id: expertId,
        source_revision: sourceRevision, system_prompt_hash: systemPromptHash,
        allowed_mcp_ids_json: allowedMcpIdsJson, allowed_skill_ids_json: allowedSkillIdsJson,
        allowed_connector_ids_json: allowedConnectorIdsJson, staged_by: "host", created_at: now, adopted_at: now,
        configuration_json: configurationJson, skill_packages_json: skillPackagesJson,
      });
      enqueueWorkOp(this.db, { op: "botUpsert", ...registration });
      return this.getBot(botId)!;
    }
    this.db.prepare(`INSERT INTO bots (
      bot_id,user_id,display_name,responsibility_summary,expert_profile_json,memory_scope_json,
      authorization_json,foreground_allowed_tools_json,notification_policy_json,status,created_at,updated_at
    ) VALUES (@botId,@userId,@displayName,@responsibilitySummary,@expertProfileJson,@memoryScopeJson,
      @authorizationJson,@foregroundAllowedToolsJson,@notificationPolicyJson,@status,@now,@now)`).run(registration);
    this.db.prepare(`INSERT OR IGNORE INTO bot_expert_versions (
      bot_id,version,state,expert_id,source_revision,system_prompt_hash,allowed_mcp_ids_json,
      allowed_skill_ids_json,allowed_connector_ids_json,configuration_json,skill_packages_json,staged_by,created_at,adopted_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      botId, activeVersion, "active", expertId, sourceRevision, systemPromptHash,
      allowedMcpIdsJson, allowedSkillIdsJson, allowedConnectorIdsJson, configurationJson,
      skillPackagesJson, "host", now, now,
    );
    return this.getBot(botId)!;
  }

  ensureDefaultBot(userId: string): BotDto {
    return workDomainRunTx(this.db, () => {
      const bot = this.registerBot(defaultBot(userId));
      const assignedAt = Date.now();
      if (requiresWorkRustWrites(this.db)) {
        overlayMutate(this.db, "bot_identity_roles", `${userId}\0primary`, () =>
          this.db.prepare("SELECT * FROM bot_identity_roles WHERE user_id=? AND role='primary'").get(userId) as Record<string, unknown> | undefined,
        cur => cur ?? { user_id: userId, role: "primary", bot_id: bot.botId, assigned_at: assignedAt });
        enqueueWorkOp(this.db, { op: "botPrimaryRoleEnsure", userId, botId: bot.botId, assignedAt });
      } else {
        this.db.prepare("INSERT OR IGNORE INTO bot_identity_roles(user_id,role,bot_id,assigned_at) VALUES(?,'primary',?,?)")
          .run(userId, bot.botId, assignedAt);
      }
      return this.getBot(bot.botId)!;
    });
  }

  isPrimaryBot(userId: string, botId: string): boolean {
    const role = overlayReadOne<{ user_id: string; bot_id: string }>(this.db, "bot_identity_roles", `${userId}\0primary`, () =>
      this.db.prepare("SELECT user_id,bot_id FROM bot_identity_roles WHERE user_id=? AND role='primary'").get(userId) as { user_id: string; bot_id: string } | undefined);
    return Boolean(role && role.bot_id === botId && this.getBotRow(botId)?.user_id === userId);
  }

  private getBotRow(botId: string): BotRow | undefined {
    return overlayReadOne<BotRow>(this.db, "bots", botId, () =>
      this.db.prepare("SELECT * FROM bots WHERE bot_id=?").get(botId) as BotRow | undefined);
  }

  getBot(botId: string): BotDto | undefined {
    const row = this.getBotRow(botId);
    return row ? this.mapBot(row) : undefined;
  }

  listBots(userId: string): BotDto[] {
    const dbRows = this.db.prepare("SELECT * FROM bots WHERE user_id=? ORDER BY created_at ASC").all(userId) as BotRow[];
    return overlayFindAll(this.db, "bots", dbRows, r => r.bot_id, r => r.user_id === userId, (a, b) => a.created_at - b.created_at)
      .map((row) => this.mapBot(row));
  }

  activeSnapshot(botId: string): ExpertConfigSnapshotDto | undefined {
    const bot = this.getBot(botId);
    if (!bot) return undefined;
    const dbRows = this.db.prepare("SELECT * FROM bot_expert_versions WHERE bot_id=? ORDER BY version DESC").all(botId) as ExpertVersionRow[];
    const row = overlayFindAll(this.db, "bot_expert_versions", dbRows, r => `${r.bot_id}\0${r.version}`, r => r.bot_id === botId && r.state === "active")[0];
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
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "bot_channel_bindings", `${binding.channelType}\0${binding.channelIdentifier}`, {
        channel_type: binding.channelType, channel_identifier: binding.channelIdentifier,
        bot_id: binding.botId, bound_at: binding.boundAt,
      });
      enqueueWorkOp(this.db, {
        op: "botChannelBind", channelType: binding.channelType, channelIdentifier: binding.channelIdentifier,
        botId: binding.botId, boundAt: binding.boundAt,
      });
      return;
    }
    this.db.prepare(`INSERT INTO bot_channel_bindings (channel_type,channel_identifier,bot_id,bound_at)
      VALUES (?,?,?,?) ON CONFLICT(channel_type,channel_identifier)
      DO UPDATE SET bot_id=excluded.bot_id, bound_at=excluded.bound_at`)
      .run(binding.channelType, binding.channelIdentifier, binding.botId, binding.boundAt);
  }

  resolveBotByChannel(channelType: BotChannelBindingDto["channelType"], channelIdentifier: string): BotDto | undefined {
    const binding = overlayReadOne<{ bot_id: string }>(this.db, "bot_channel_bindings", `${channelType}\0${channelIdentifier}`, () =>
      this.db.prepare("SELECT channel_type,channel_identifier,bot_id,bound_at FROM bot_channel_bindings WHERE channel_type=? AND channel_identifier=?")
        .get(channelType, channelIdentifier) as { bot_id: string } | undefined);
    return binding ? this.getBot(binding.bot_id) : undefined;
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
    return workDomainRunTx(this.db, () => {
      const bot = this.getBot(botId);
      if (!bot) return { ok: false as const, code: "not_found" as const, message: "找不到 Bot" };
      const pending = this.getPendingVersionRow(botId);
      const nextVersion = Math.max(bot.expertProfile.desiredVersion, bot.expertProfile.activeVersion) + 1;
      const allowedMcpIdsJson = JSON.stringify(input.allowedMcpIds ?? []);
      const allowedSkillIdsJson = JSON.stringify(input.allowedSkillIds ?? []);
      const allowedConnectorIdsJson = JSON.stringify(input.allowedConnectorIds ?? []);
      const configurationJson = input.configuration ? JSON.stringify(input.configuration) : null;
      const skillPackagesJson = JSON.stringify(input.skillPackages ?? []);
      const profile: ExpertProfileDto = {
        ...bot.expertProfile,
        desiredVersion: nextVersion,
        pendingVersion: nextVersion,
      };
      if (requiresWorkRustWrites(this.db)) {
        if (pending) overlaySet(this.db, "bot_expert_versions", `${botId}\0${pending.version}`, { ...pending, state: "superseded" });
        overlaySet(this.db, "bot_expert_versions", `${botId}\0${nextVersion}`, {
          bot_id: botId, version: nextVersion, state: "pending", expert_id: input.expertId,
          source_revision: input.sourceRevision, system_prompt_hash: input.systemPromptHash,
          allowed_mcp_ids_json: allowedMcpIdsJson, allowed_skill_ids_json: allowedSkillIdsJson,
          allowed_connector_ids_json: allowedConnectorIdsJson, staged_by: input.stagedBy, created_at: now,
          adopted_at: null, configuration_json: configurationJson, skill_packages_json: skillPackagesJson,
        });
        overlayMutate(this.db, "bots", botId, () => this.getBotRow(botId),
          cur => cur ? { ...cur, expert_profile_json: JSON.stringify(profile), updated_at: now } : cur);
        enqueueWorkOp(this.db, {
          op: "botExpertStage", botId, supersedeVersion: pending?.version ?? null, version: nextVersion,
          expertId: input.expertId, sourceRevision: input.sourceRevision, systemPromptHash: input.systemPromptHash,
          allowedMcpIdsJson, allowedSkillIdsJson, allowedConnectorIdsJson, stagedBy: input.stagedBy,
          configurationJson, skillPackagesJson, expertProfileJson: JSON.stringify(profile), now,
        });
        return { ok: true as const, bot: this.getBot(botId)!, pendingVersion: nextVersion };
      }
      if (pending) {
        this.db.prepare("UPDATE bot_expert_versions SET state='superseded' WHERE bot_id=? AND version=?").run(botId, pending.version);
      }
      this.db.prepare(`INSERT INTO bot_expert_versions (
        bot_id,version,state,expert_id,source_revision,system_prompt_hash,allowed_mcp_ids_json,
        allowed_skill_ids_json,allowed_connector_ids_json,staged_by,created_at,configuration_json,skill_packages_json
      ) VALUES (?,?,'pending',?,?,?,?,?,?,?,?,?,?)`).run(
        botId, nextVersion, input.expertId, input.sourceRevision, input.systemPromptHash,
        allowedMcpIdsJson, allowedSkillIdsJson, allowedConnectorIdsJson, input.stagedBy, now,
        configurationJson, skillPackagesJson,
      );
      this.writeProfile(botId, profile, now);
      return { ok: true as const, bot: this.getBot(botId)!, pendingVersion: nextVersion };
    });
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
    return workDomainRunTx(this.db, (): ExpertAdoptionResult => {
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
      if (requiresWorkRustWrites(this.db)) {
        const versions = this.listVersionRows(botId);
        for (const v of versions) {
          if (v.state === "active") overlaySet(this.db, "bot_expert_versions", `${botId}\0${v.version}`, { ...v, state: "superseded" });
        }
        overlaySet(this.db, "bot_expert_versions", `${botId}\0${pending.version}`, { ...pending, state: "active", adopted_at: now });
        overlayMutate(this.db, "bots", botId, () => this.getBotRow(botId),
          cur => cur ? { ...cur, expert_profile_json: JSON.stringify(profile), updated_at: now } : cur);
        enqueueWorkOp(this.db, {
          op: "botExpertAdopt", botId, version: pending.version, expertProfileJson: JSON.stringify(profile), now,
        });
        return { ok: true, bot: this.getBot(botId)!, adoptedVersion: pending.version };
      }
      this.db.prepare("UPDATE bot_expert_versions SET state='superseded' WHERE bot_id=? AND state='active'").run(botId);
      this.db.prepare(`UPDATE bot_expert_versions SET state='active', adopted_at=? WHERE bot_id=? AND version=?`)
        .run(now, botId, pending.version);
      this.writeProfile(botId, profile, now);
      return { ok: true, bot: this.getBot(botId)!, adoptedVersion: pending.version };
    });
  }

  /**
   * Disabling keeps responsibility and settlement records. It never cascades into
   * works: the caller gets the affected ids so the UI can show them.
   */
  disableBot(botId: string, now = Date.now()): { ok: boolean; bot?: BotDto; affectedActiveWorkIds: string[] } {
    const bot = this.getBot(botId);
    if (!bot) return { ok: false, affectedActiveWorkIds: [] };
    const dbWorks = this.db.prepare("SELECT work_id,owner_bot_id,lifecycle FROM works WHERE owner_bot_id=? AND lifecycle != 'closed'").all(botId) as Array<{ work_id: string; owner_bot_id: string; lifecycle: string }>;
    const activeWorks = overlayFindAll(this.db, "works", dbWorks, r => r.work_id, r => r.owner_bot_id === botId && r.lifecycle !== "closed");
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "bots", botId, () => this.getBotRow(botId),
        cur => cur ? { ...cur, status: "disabled" as const, updated_at: now } : cur);
      enqueueWorkOp(this.db, { op: "botDisable", botId, now });
    } else {
      this.db.prepare("UPDATE bots SET status='disabled', updated_at=? WHERE bot_id=?").run(now, botId);
    }
    return { ok: true, bot: this.getBot(botId), affectedActiveWorkIds: activeWorks.map((row) => row.work_id) };
  }

  /**
   * Hard delete is only allowed when the bot holds no responsibility and no unsettled
   * execution. Otherwise the caller must hand off / close first.
   */
  deleteBot(botId: string): { ok: true } | { ok: false; code: "not_found" | "has_responsibility"; message: string; blockingWorkIds?: string[] } {
    const bot = this.getBot(botId);
    if (!bot) return { ok: false, code: "not_found", message: "找不到 Bot" };
    const ownedDb = this.db.prepare("SELECT work_id,owner_bot_id FROM works WHERE owner_bot_id=?").all(botId) as Array<{ work_id: string; owner_bot_id: string }>;
    const owned = overlayFindAll(this.db, "works", ownedDb, r => r.work_id, r => r.owner_bot_id === botId);
    const partDb = this.db.prepare("SELECT work_id,bot_id FROM work_participants WHERE bot_id=?").all(botId) as Array<{ work_id: string; bot_id: string }>;
    const participating = overlayFindAll(this.db, "work_participants", partDb, r => `${r.work_id}\0${r.bot_id}`, r => r.bot_id === botId);
    const unsettled = this.db.prepare(`SELECT DISTINCT b.work_id FROM work_execution_bindings b
      WHERE (b.bot_id=? OR b.work_id IN (SELECT work_id FROM works WHERE owner_bot_id=?)) AND b.settled_at IS NULL`).all(botId, botId) as Array<{ work_id: string }>;
    const blocking = [...new Set([...owned, ...participating, ...unsettled].map((row) => row.work_id))];
    if (blocking.length > 0) {
      return {
        ok: false, code: "has_responsibility",
        message: "Bot 仍有责任或未结算的执行，不能删除", blockingWorkIds: blocking,
      };
    }
    if (requiresWorkRustWrites(this.db)) {
      const dbBindings = this.db.prepare("SELECT channel_type,channel_identifier,bot_id FROM bot_channel_bindings WHERE bot_id=?").all(botId) as Array<{ channel_type: string; channel_identifier: string; bot_id: string }>;
      for (const b of overlayFindAll(this.db, "bot_channel_bindings", dbBindings, r => `${r.channel_type}\0${r.channel_identifier}`, r => r.bot_id === botId)) {
        overlayDelete(this.db, "bot_channel_bindings", `${b.channel_type}\0${b.channel_identifier}`);
      }
      for (const v of this.listVersionRows(botId)) overlayDelete(this.db, "bot_expert_versions", `${botId}\0${v.version}`);
      overlayDelete(this.db, "bots", botId);
      enqueueWorkOp(this.db, { op: "botDelete", botId });
      return { ok: true };
    }
    this.db.prepare("DELETE FROM bot_channel_bindings WHERE bot_id=?").run(botId);
    this.db.prepare("DELETE FROM bot_expert_versions WHERE bot_id=?").run(botId);
    this.db.prepare("DELETE FROM bots WHERE bot_id=?").run(botId);
    return { ok: true };
  }

  private listVersionRows(botId: string): ExpertVersionRow[] {
    const dbRows = this.db.prepare("SELECT * FROM bot_expert_versions WHERE bot_id=? ORDER BY version DESC").all(botId) as ExpertVersionRow[];
    return overlayFindAll(this.db, "bot_expert_versions", dbRows, r => `${r.bot_id}\0${r.version}`, r => r.bot_id === botId, (a, b) => b.version - a.version);
  }

  /**
   * R09 read model: the immutable staged/active configurations a user must review before
   * adopting. The pending row keeps its own full content, so reviewing v2 while v3 is
   * staged is a detectable conflict rather than a silent overwrite.
   */
  expertVersions(botId: string): BotExpertVersionDto[] {
    return this.listVersionRows(botId).map(row => ({
        botId: row.bot_id, version: row.version, state: row.state, snapshotId: `expert:${row.bot_id}:v${row.version}`,
        expertId: row.expert_id, sourceRevision: row.source_revision, systemPromptHash: row.system_prompt_hash,
        allowedMcpIds: parseJson<string[]>(row.allowed_mcp_ids_json, []),
        allowedSkillIds: parseJson<string[]>(row.allowed_skill_ids_json, []),
        allowedConnectorIds: parseJson<string[]>(row.allowed_connector_ids_json, []),
        configuration: parseJson<BotExpertVersionDto["configuration"]>(row.configuration_json, undefined),
        stagedBy: row.staged_by, createdAt: row.created_at, adoptedAt: row.adopted_at ?? undefined,
      }));
  }

  private getPendingVersionRow(botId: string): ExpertVersionRow | undefined {
    return this.listVersionRows(botId).find(r => r.state === "pending");
  }

  private writeProfile(botId: string, profile: ExpertProfileDto, now: number): void {
    this.db.prepare("UPDATE bots SET expert_profile_json=?, updated_at=? WHERE bot_id=?")
      .run(JSON.stringify(profile), now, botId);
  }

  private mapBot(row: BotRow, isPrimary = this.isPrimaryBot(row.user_id, row.bot_id)): BotDto {
    return {
      botId: row.bot_id,
      userId: row.user_id,
      organizationRole: isPrimary ? "primary" : "ordinary",
      displayName: row.display_name,
      responsibilitySummary: row.responsibility_summary,
      expertProfile: parseJson<ExpertProfileDto>(row.expert_profile_json, defaultExpertProfile()),
      memoryScope: parseJson<BotDto["memoryScope"]>(row.memory_scope_json, {
        personalMemoryNamespace: `mem-${row.bot_id}`,
        sharePersonalMemoryWithTeam: false,
        allowUnconfirmedSpeculationInMemory: false,
      }),
      authorization: normalizeAuthorization(parseJson<WorkAuthorizationDto>(row.authorization_json, minimumAuthorization())),
      foregroundAllowedTools: parseJson<string[]>(row.foreground_allowed_tools_json, []),
      notificationPolicyJson: row.notification_policy_json,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function normalizeAuthorization(_input: Partial<WorkAuthorizationDto> | undefined): WorkAuthorizationDto {
  // Ignore retired stored grants, including expired scopes and path whitelists.
  return minimumAuthorization();
}

export function newBotId(): string {
  return `bot-${randomUUID()}`;
}
