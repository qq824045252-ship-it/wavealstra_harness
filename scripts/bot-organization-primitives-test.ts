import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { z } from "zod";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry, type StageExpertVersionInput } from "../src/main/agent/work/BotRegistry";
import { BotCreationService } from "../src/main/agent/work/BotCreationService";
import { BotSettingsService } from "../src/main/agent/work/BotSettingsService";
import { WorkHostAuthority } from "../src/main/agent/work/WorkHostAuthority";
import { botSettingsSchema } from "../src/shared/bot-settings";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

const choice = (id: string) => ({ id, name: id, available: true });
const choices = {
  models: [choice("fixture/base"), choice("fixture/changed"), choice("fixture/latest")],
  experts: [], skills: [choice("own-skill")], mcps: [choice("connected-mcp")], connectors: [choice("installed-connector")],
};
function assemble(input: z.infer<typeof botSettingsSchema>): StageExpertVersionInput {
  const revision = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return { expertId: `expert-${input.botId}`, sourceRevision: revision, systemPromptHash: revision,
    allowedSkillIds: input.skillIds, allowedMcpIds: input.mcpIds, allowedConnectorIds: input.connectorIds,
    stagedBy: LOCAL_USER_ID,
    configuration: { revision, name: input.botId, instructions: "Fixture personal responsibility",
      skillIds: input.skillIds, mcpIds: input.mcpIds, connectorIds: input.connectorIds } };
}
const workerJobSchema = z.object({ root: z.string(), dbPath: z.string(), botId: z.string(),
  operationId: z.string(), authorityId: z.string() });
const workerResultSchema = z.object({ settings: z.object({ revision: z.number(), modelId: z.string() }),
  appliedAt: z.number(), replayed: z.boolean() });

if (!isMainThread) {
  const job = workerJobSchema.parse(workerData);
  process.env.HOME = job.root; process.env.USERPROFILE = job.root;
  const port = parentPort;
  assert(port);
  const db = new AppDatabase(job.dbPath);
  db.connection.pragma("busy_timeout=10000");
  const bots = new BotRegistry(db.connection);
  const authority = new WorkHostAuthority(db.connection, job.authorityId);
  const settings = new BotSettingsService(db, bots, LOCAL_USER_ID, join(job.root, "workspaces"), async botId => {
    assert.equal(botId, job.botId);
    port.postMessage("validated");
    const [command] = await once(port, "message");
    assert.equal(command, "commit");
    return choices;
  }, assemble);
  port.postMessage("ready");
  const [start] = await once(port, "message");
  assert.equal(start, "start");
  try {
    const result = await settings.configureOperation({ operationId: job.operationId, botId: job.botId,
      expectedRevision: 0, changes: { modelId: "fixture/changed" } }, () => {
      assert(authority.isAuthority(), "persisted host lease is required");
      assert(bots.isPrimaryBot(LOCAL_USER_ID, DEFAULT_BOT_ID));
    });
    port.postMessage(result);
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally { db.close(); port.close(); }
} else {
  const tempBase = resolve(tmpdir());
  const root = mkdtempSync(join(tempBase, "bot-organization-primitives-"));
  process.env.HOME = root; process.env.USERPROFILE = root;
  const dbPath = join(root, "app.db");
  let db = new AppDatabase(dbPath);
  let bots = new BotRegistry(db.connection);
  let authority = new WorkHostAuthority(db.connection, "organization-primitives-host");
  assert(authority.acquire().ok);
  const catalogTargets: Array<string | undefined> = [];
  const catalog = async (botId?: string) => { catalogTargets.push(botId); return choices; };
  const service = () => new BotSettingsService(db, bots, LOCAL_USER_ID, join(root, "workspaces"), catalog, assemble);
  const authorize = () => {
    assert(authority.isAuthority(), "persisted host lease is required");
    assert(bots.isPrimaryBot(LOCAL_USER_ID, DEFAULT_BOT_ID), "only the actual primary may configure through organization");
  };
  const scalar = (sql: string) => z.number().parse(db.connection.prepare(sql).pluck().get());
  try {
    const original = bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "Already renamed primary" });
    assert.equal(original.organizationRole, "ordinary", "only explicit default bootstrap seeds the role");
    const primary = bots.ensureDefaultBot(LOCAL_USER_ID);
    assert.equal(primary.displayName, "Already renamed primary");
    assert.equal(primary.organizationRole, "primary");
    assert(bots.isPrimaryBot(LOCAL_USER_ID, primary.botId));
    assert(!bots.isPrimaryBot("other-user", primary.botId));
    assert.equal(scalar("SELECT COUNT(*) FROM bot_identity_roles"), 1);
    const assignedAt = scalar("SELECT assigned_at FROM bot_identity_roles");
    bots.ensureDefaultBot(LOCAL_USER_ID);
    assert.equal(scalar("SELECT assigned_at FROM bot_identity_roles"), assignedAt);
    const impostor = bots.registerBot({ botId: "ordinary-impostor", userId: LOCAL_USER_ID,
      displayName: "MyBuddy", responsibilitySummary: "默认长期主负责人 Bot" });
    assert.equal(impostor.organizationRole, "ordinary");
    assert(!bots.isPrimaryBot(LOCAL_USER_ID, impostor.botId));
    assert.equal(bots.listBots(LOCAL_USER_ID).filter(bot => bot.organizationRole === "primary").length, 1);
    const creation = new BotCreationService(db.connection, bots, { userId: LOCAL_USER_ID, isAuthority: () => authority.isAuthority() });
    const renamed = creation.renameBot({ botId: primary.botId, expectedUpdatedAt: primary.updatedAt, displayName: "组织助理" });
    assert(renamed.ok);
    assert.equal(renamed.bot.botId, DEFAULT_BOT_ID);
    assert.equal(renamed.bot.organizationRole, "primary");
    const createRequest = { requestId: randomUUID(), displayName: "资料核对助理", responsibilitySummary: "核对本地记录" };
    const created = creation.createBot(createRequest);
    assert(created.ok);
    assert.equal(created.bot.organizationRole, "ordinary");
    assert.match(created.bot.expertProfile.configuration!.instructions, /个人助理/);
    assert(!bots.isPrimaryBot(LOCAL_USER_ID, created.bot.botId));
    const targetId = created.bot.botId;
    const settings = service();
    const folder = join(root, "task-folder"); mkdirSync(folder);
    const initial = await settings.save({ botId: targetId, expectedRevision: 0, modelId: "fixture/base", workspacePath: folder,
      expertId: "", skillIds: ["own-skill"], mcpIds: ["connected-mcp"], connectorIds: ["installed-connector"] });
    const operation = { operationId: "config-with-lost-reply", botId: targetId, expectedRevision: 1,
      changes: { modelId: "fixture/changed" } };
    const applied = await settings.configureOperation(operation, authorize);
    assert.equal(applied.replayed, false);
    assert.equal(applied.settings.revision, 2);
    assert.equal(applied.settings.modelId, "fixture/changed");
    assert.equal(applied.settings.workspacePath, initial.settings.workspacePath);
    assert.deepEqual(applied.settings.skillIds, ["own-skill"]);
    assert.deepEqual(applied.settings.mcpIds, ["connected-mcp"]);
    assert.deepEqual(applied.settings.connectorIds, ["installed-connector"]);
    assert.deepEqual(bots.activeSnapshot(targetId)?.allowedSkillIds, ["own-skill"]);
    const committedVersions = bots.expertVersions(targetId).length;
    await settings.view(targetId);
    await settings.prepareMessage(targetId, { modelId: "fixture/changed", expertId: "", skillIds: [], mcpIds: [], connectorIds: [] });
    assert(catalogTargets.length >= 4);
    assert(catalogTargets.every(id => id === targetId), "view/save/operation/composer catalogue is scoped to the actual target");
    await assert.rejects(settings.configureOperation({ ...operation, changes: { modelId: "fixture/latest" } }, authorize), /idempotency_conflict/);
    await assert.rejects(settings.configureOperation({ ...operation, expectedRevision: 2 }, authorize), /idempotency_conflict/);
    await assert.rejects(settings.configureOperation(operation, () => { throw new Error("ordinary Bot denied"); }), /ordinary Bot denied/);
    const injected = { operationId: "injected-role", botId: targetId, expectedRevision: 2,
      changes: { modelId: "fixture/latest", organizationRole: "primary" } };
    await assert.rejects(settings.configureOperation(injected, authorize), /Unrecognized key/);
    await assert.rejects(settings.configureOperation({ ...operation, operationId: "stale-settings" }, authorize), /已在其他窗口更新/);
    await assert.rejects(settings.configureOperation({ ...operation, operationId: "missing-private-skill", expectedRevision: 2,
      changes: { skillIds: ["another-bot-private-skill"] } }, authorize), /Skill不可用/);
    assert.equal(settings.get(targetId).revision, 2);
    assert.equal(bots.expertVersions(targetId).length, committedVersions);
    assert.equal(scalar("SELECT COUNT(*) FROM bot_settings_operations"), 1);

    const botCountBeforeRead = scalar("SELECT COUNT(*) FROM bots");
    const versionsBeforeRead = bots.expertVersions(targetId).length;
    const catalogCallsBeforeRead = catalogTargets.length;
    assert.deepEqual(creation.readCreation(createRequest), { ...created, bot: bots.getBot(targetId), replayed: true });
    const creationConflict = creation.readCreation({ ...createRequest, responsibilitySummary: "不同职责" });
    assert(creationConflict && !creationConflict.ok);
    assert.equal(creationConflict.code, "request_conflict");
    assert.equal(creation.readCreation({ ...createRequest, requestId: randomUUID() }), undefined);
    assert.deepEqual(settings.readConfigurationOperation(operation.operationId), { ...applied, replayed: true });
    assert.equal(settings.readConfigurationOperation("not-created-operation"), undefined);
    assert.equal(scalar("SELECT COUNT(*) FROM bots"), botCountBeforeRead);
    assert.equal(bots.expertVersions(targetId).length, versionsBeforeRead);
    assert.equal(catalogTargets.length, catalogCallsBeforeRead, "recovery reads do not rediscover or assemble configuration");
    assert(!existsSync(join(root, "workspaces")), "pure recovery reads do not prepare workspace directories");

    // A later user edit must survive replay of the earlier operation, even after a real reopen.
    await settings.save({ botId: targetId, expectedRevision: 2, modelId: "fixture/latest", workspacePath: folder,
      expertId: "", skillIds: ["own-skill"], mcpIds: ["connected-mcp"], connectorIds: ["installed-connector"] });
    db.close();
    db = new AppDatabase(dbPath); bots = new BotRegistry(db.connection);
    authority = new WorkHostAuthority(db.connection, "organization-primitives-host");
    assert(authority.acquire().ok);
    assert.equal(bots.ensureDefaultBot(LOCAL_USER_ID).displayName, "组织助理");
    assert(bots.isPrimaryBot(LOCAL_USER_ID, DEFAULT_BOT_ID));
    assert.equal(scalar("SELECT assigned_at FROM bot_identity_roles"), assignedAt);
    const afterReopen = service();
    const versionsAfterEdit = bots.expertVersions(targetId).length;
    const replay = await afterReopen.configureOperation(operation, authorize);
    assert.deepEqual(replay, { ...applied, replayed: true });
    assert.equal(afterReopen.get(targetId).revision, 3);
    assert.equal(afterReopen.get(targetId).modelId, "fixture/latest");
    assert.equal(bots.expertVersions(targetId).length, versionsAfterEdit);
    const readAfterReopen = new BotCreationService(db.connection, bots, { userId: LOCAL_USER_ID, isAuthority: () => false })
      .readCreation(createRequest);
    assert(readAfterReopen?.ok);
    assert.equal(readAfterReopen.bot.botId, targetId);
    assert.deepEqual(afterReopen.readConfigurationOperation(operation.operationId), { ...applied, replayed: true });
    const foreign = new BotSettingsService(db, bots, "other-user", join(root, "foreign"), catalog, assemble);
    await assert.rejects(foreign.configureOperation(operation, () => {}), /不属于当前用户/);
    assert.equal(foreign.readConfigurationOperation(operation.operationId), undefined);

    // Revoke the real persisted lease after asynchronous validation starts.
    const beforeRevocation = afterReopen.get(targetId);
    const versionsBeforeRevocation = bots.expertVersions(targetId).length;
    const revoked = new BotSettingsService(db, bots, LOCAL_USER_ID, join(root, "workspaces"), async () => {
      authority.release(); return choices;
    }, assemble);
    const revokedOperation = { operationId: "lease-lost-during-validation", botId: targetId,
      expectedRevision: 3, changes: { modelId: "fixture/base" } };
    await assert.rejects(revoked.configureOperation(revokedOperation, authorize), /persisted host lease/);
    assert.deepEqual(afterReopen.get(targetId), beforeRevocation);
    assert.equal(bots.expertVersions(targetId).length, versionsBeforeRevocation);
    assert.equal(scalar("SELECT COUNT(*) FROM bot_settings_operations"), 1);
    assert(authority.acquire().ok);
    assert.equal((await afterReopen.configureOperation(revokedOperation, authorize)).settings.revision, 4);

    // Receipt insertion failure rolls back settings and the adopted expert together.
    db.connection.exec(`CREATE TEMP TRIGGER fail_organization_settings_receipt BEFORE INSERT ON bot_settings_operations
      WHEN NEW.operation_id='receipt-rollback' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;`);
    const rollback = { operationId: "receipt-rollback", botId: targetId, expectedRevision: 4, changes: { modelId: "fixture/latest" } };
    const beforeRollback = afterReopen.get(targetId);
    const profileBeforeRollback = bots.activeSnapshot(targetId);
    await assert.rejects(afterReopen.configureOperation(rollback, authorize), /fixture receipt failure/);
    assert.deepEqual(afterReopen.get(targetId), beforeRollback);
    assert.deepEqual(bots.activeSnapshot(targetId), profileBeforeRollback);
    db.connection.exec("DROP TRIGGER fail_organization_settings_receipt");
    assert.equal((await afterReopen.configureOperation(rollback, authorize)).settings.revision, 5);

    // Two independent connections validate revision zero before either may commit.
    const concurrentBot = bots.registerBot({ botId: "concurrent-specialist", userId: LOCAL_USER_ID, displayName: "Concurrent specialist" });
    const job = { root, dbPath, botId: concurrentBot.botId, operationId: "same-operation-concurrent",
      authorityId: "organization-primitives-host" };
    const workers: Worker[] = [];
    const exits: Array<Promise<unknown[]>> = [];
    for (let i = 0; i < 2; i++) {
      const worker = new Worker(new URL(import.meta.url), { workerData: job });
      workers.push(worker); exits.push(once(worker, "exit"));
      assert.equal((await once(worker, "message"))[0], "ready");
    }
    const validations = workers.map(async worker => {
      const message = once(worker, "message"); worker.postMessage("start");
      assert.equal((await message)[0], "validated");
    });
    await Promise.all(validations);
    const results = workers.map(async worker => {
      const message = once(worker, "message"); worker.postMessage("commit");
      return workerResultSchema.parse((await message)[0]);
    });
    const concurrent = await Promise.all(results);
    await Promise.all(exits);
    assert.equal(concurrent.filter(result => result.replayed).length, 1);
    assert.equal(concurrent[0].appliedAt, concurrent[1].appliedAt);
    assert(concurrent.every(result => result.settings.revision === 1 && result.settings.modelId === "fixture/changed"));
    assert.equal(afterReopen.get(concurrentBot.botId).revision, 1);
    assert.equal(bots.expertVersions(concurrentBot.botId).length, 2);
    assert.equal(scalar("SELECT COUNT(*) FROM bot_settings_operations WHERE operation_id='same-operation-concurrent'"), 1);
    const disabled = bots.disableBot(DEFAULT_BOT_ID);
    assert(disabled.ok);
    assert.equal(disabled.bot?.status, "disabled");
    assert.equal(disabled.bot?.organizationRole, "primary", "disabling does not silently assign another primary");
    assert(bots.isPrimaryBot(LOCAL_USER_ID, DEFAULT_BOT_ID));
    assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
    console.log("PASS organization primitives: stable primary, own-Bot scope, target catalogue, patch preservation, lost reply/reopen, exact conflict, CAS, lease revocation, atomic receipt and real concurrent connections");
  } finally {
    db.close();
    assert(resolve(root).startsWith(join(tempBase, "bot-organization-primitives-")));
    rmSync(root, { recursive: true, force: true });
  }
}
