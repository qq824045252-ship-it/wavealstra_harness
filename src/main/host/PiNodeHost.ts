import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AgentDeleteUserMessageRequest,
  AgentPromptRequest,
  AgentRegenerateRequest,
  AgentSubmissionReceipt,
  AgentUiPatch,
  AuthLoginRequest,
} from "../../shared/agent-ipc";
import { DOTS_TASK_ID } from "../../shared/dots";
import { normalizeDreamSettings, normalizeRssSubscriptions } from "../../shared/dots-discovery";
import { normalizeDotsGoogleRules } from "../../shared/dots-google";
import { resolveDotsPreferences } from "../../shared/dots-settings";
import { AgentService, type AgentTaskLifecycleEvent } from "../agent/AgentService";
import { createArtifactDomain, type ArtifactDomain } from "../artifact/ArtifactDomainSetup";
import { search as searchDotsPublicWeb } from "../capabilities/web-access/gemini-search";
import { CronService } from "../cron/CronService";
import { AppDatabase } from "../db/AppDatabase";
import { DotsActions } from "../dots/DotsActions";
import { DotsDelegations } from "../dots/DotsDelegations";
import { DotsDiscovery } from "../dots/DotsDiscovery";
import { DotsGoogleAccounts } from "../dots/DotsGoogleAccounts";
import { DotsGoogleMonitor } from "../dots/DotsGoogleMonitor";
import { DotsGoogleReads } from "../dots/DotsGoogleReads";
import { DotsProactiveDelivery } from "../dots/DotsProactiveDelivery";
import { DotsReporting } from "../dots/DotsReporting";
import { GadgetRegistry } from "../gadget/GadgetRegistry";
import { GadgetRepository } from "../gadget/GadgetRepository";
import { GadgetRuntime } from "../gadget/GadgetRuntime";
import { GadgetService } from "../gadget/GadgetService";
import { GadgetStorage } from "../gadget/GadgetStorage";
import { LibraryService } from "../library/LibraryService";
import { MemoryService } from "../memory/MemoryService";
import { NotificationService } from "../notification/NotificationService";
import { getMyBuddyBinDir, getMyBuddyDir } from "../paths";
import type { CoreBusinessClient, CoreExecutionDispatch } from "../platform/core-business-client";
import { ProjectAttentionTracker } from "../project/ProjectAttention";
import { ProjectRepository } from "../project/ProjectRepository";
import { ProjectService } from "../project/ProjectService";
import { TaskBoardRepository } from "../task/TaskBoardRepository";
import { TaskExecutionWorkspace } from "../task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle } from "../task/TaskExecutionWorkspaceLifecycle";
import { TaskTerminalService } from "../terminal/TaskTerminalService";
import { resolveBoundWorkspaceCwd, TerminalHost } from "../terminal/TerminalHost";
import { WorkGraphService } from "../workgraph/WorkGraphService";
import {
  ExecutionHostBridge,
  createDurableBotExecutionRunner,
  type ExecutionBridgeRunner,
} from "./ExecutionHostBridge";
import { buildHostCapabilities, type HostCapabilityFlags } from "./HostCapabilities";
import { PlatformRpcClient } from "./PlatformRpcClient";
import { assertExpectedPiVersion } from "./pi-version";

export interface PiNodeHostOptions {
  hostId?: string;
  hostGeneration?: string;
  dataDirectory?: string;
  dbPath: string;
  storageRoot?: string;
  runtimeAuditExecutable: string;
  repoRoot?: string;
  heartbeatIntervalMs?: number;
  taskWorkspace?: TaskExecutionWorkspace;
  trashRoot?: string;
  libraryRoot?: string;
  models?: ModelRuntime;
  capabilities?: HostCapabilityFlags;
  runGatewayControlCycle?: (cycle: string, channelId: string, extra?: Record<string, unknown>) => Promise<void>;
}

interface ActiveProgressReporter {
  reportProgress(progress: unknown, opts?: { ephemeral?: boolean }): Promise<void>;
}

/**
 * Isolated standalone Pi Node Host process controller (`RC-20`..`RC-22`, `P0-01`..`P0-05`).
 *
 * Owns `ModelRuntime`, `DurableBotService`, `SummaryBudget` compaction, MCP, Subagents,
 * ArtifactDomain, GadgetService, workflow CronService bridge (core-scheduled only),
 * Dots runtime/monitors (`coreControlled`), and Platform RPC proxy outside Electron Main
 * while opening `app.db` strictly read-only.
 */
export class PiNodeHost {
  readonly hostId: string;
  readonly hostGeneration: string;
  readonly dataDirectory: string;
  readonly storageRoot: string;
  readonly declaredCapabilities: string[];
  private db?: AppDatabase;
  private agentService?: AgentService;
  private artifactDomain?: ArtifactDomain;
  private gadgetService?: GadgetService;
  private gadgetRuntime?: GadgetRuntime;
  private cronService?: CronService;
  private terminalHost?: TerminalHost;
  private dotsDelegations?: DotsDelegations;
  private dotsActions?: DotsActions;
  private dotsReporting?: DotsReporting;
  private dotsProactiveDelivery?: DotsProactiveDelivery;
  private dotsGoogleMonitor?: DotsGoogleMonitor;
  private dotsDiscovery?: DotsDiscovery;
  private libraryService?: LibraryService;
  private projectService?: ProjectService;
  private attentionTracker?: ProjectAttentionTracker;
  private workGraphService?: WorkGraphService;
  private taskLifecycle?: TaskExecutionWorkspaceLifecycle;
  private notificationService?: NotificationService;
  private platformRpc?: PlatformRpcClient;
  private bridge?: ExecutionHostBridge;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private offPatch?: () => void;
  private offReconnect?: () => void;
  private closed = false;
  private progressErrors = 0;
  private readonly reportersByTask = new Map<string, Set<ActiveProgressReporter>>();

  constructor(private readonly options: PiNodeHostOptions) {
    this.hostId = options.hostId?.trim() || `pi-host-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.hostGeneration = options.hostGeneration?.trim() || `pi-gen-${Date.now()}-${process.pid}`;
    this.dataDirectory = options.dataDirectory?.trim() || getMyBuddyDir();
    this.storageRoot = options.storageRoot?.trim() || join(this.dataDirectory, "durable-bots");
    this.declaredCapabilities = buildHostCapabilities({
      piCore: options.capabilities?.piCore ?? true,
      cron: options.capabilities?.cron ?? true,
      dotsControl: options.capabilities?.dotsControl ?? true,
      gatewayControl: options.capabilities?.gatewayControl ?? Boolean(options.runGatewayControlCycle),
      maintenanceControl: options.capabilities?.maintenanceControl,
      extraKinds: options.capabilities?.extraKinds,
    });
  }

  getProgressErrors(): number {
    return this.progressErrors;
  }

  getAgentService(): AgentService | undefined {
    return this.agentService;
  }

  getArtifactDomain(): ArtifactDomain | undefined {
    return this.artifactDomain;
  }

  getGadgetService(): GadgetService | undefined {
    return this.gadgetService;
  }

  getPlatformRpcClient(): PlatformRpcClient | undefined {
    return this.platformRpc;
  }

  getClient(): CoreBusinessClient | undefined {
    return this.bridge?.connection;
  }

  private trackTaskReporter(taskId: string, reporter: ActiveProgressReporter): () => void {
    let set = this.reportersByTask.get(taskId);
    if (!set) {
      set = new Set();
      this.reportersByTask.set(taskId, set);
    }
    set.add(reporter);
    return () => {
      set?.delete(reporter);
      if (set?.size === 0) this.reportersByTask.delete(taskId);
    };
  }

  private pushProgressToTask(taskId: string, progress: unknown, opts?: { ephemeral?: boolean }): void {
    const reporters = this.reportersByTask.get(taskId);
    if (!reporters?.size) return;
    for (const reporter of reporters) {
      void reporter.reportProgress(progress, opts).catch(error => {
        this.progressErrors += 1;
        console.warn("[PiNodeHost] progress delivery failed:", error instanceof Error ? error.message : String(error));
      });
    }
  }

  async start(): Promise<{
    hostId: string;
    hostGeneration: string;
    piVersion: string;
    pid: number;
    capabilities: string[];
  }> {
    if (this.closed) throw new Error("PiNodeHost has been closed");
    const { expected, actual } = assertExpectedPiVersion(this.options.repoRoot);

    this.db = await AppDatabase.open(this.options.dbPath, {
      runtimeAuditExecutable: this.options.runtimeAuditExecutable,
      runtimeAuditSupervised: true,
      readonly: true,
    });

    const platformRpc = new PlatformRpcClient(() => this.bridge?.connection);
    this.platformRpc = platformRpc;

    const agent = new AgentService(this.db, this.options.taskWorkspace, {
      models: this.options.models,
      executionMode: "host",
    });
    this.agentService = agent;
    agent.setPlatformRpcClient(platformRpc);
    agent.setAuthEventForwarder((kind, data) => {
      this.pushProgressToTask("__models__", { kind, data });
    });

    const notifications = new NotificationService(this.db);
    this.notificationService = notifications;

    // 1. Artifact Domain (isolated under dataDirectory/artifacts; writes route through Rust runtimeAuditReader)
    const artifactDomain = createArtifactDomain(
      this.db.connection,
      undefined,
      this.db.runtimeAuditReader,
      join(this.dataDirectory, "artifacts"),
    );
    this.artifactDomain = artifactDomain;
    agent.setArtifactDomain(artifactDomain.service, artifactDomain.coordinator);

    // 2. Gadget Domain (shared Core runtimeAuditReader + storage in dataDirectory/gadgets)
    const gadgetRepository = new GadgetRepository(this.db.connection, this.db.runtimeAuditReader);
    const gadgetStorage = new GadgetStorage(join(this.dataDirectory, "gadgets"), this.db.runtimeAuditReader);
    const gadgetRegistry = new GadgetRegistry();
    const gadgetRuntime = new GadgetRuntime(
      gadgetStorage,
      gadgetRegistry,
      () => undefined,
      this.db.runtimeAuditReader,
      { idleTimeoutMs: 5 * 60_000 },
    );
    this.gadgetRuntime = gadgetRuntime;
    const gadgetService = new GadgetService({
      repository: gadgetRepository,
      storage: gadgetStorage,
      registry: gadgetRegistry,
      runtime: gadgetRuntime,
      workspaceExists: id => Boolean(this.db?.getSpace(id)),
      workspaceEffectiveArchived: id => this.db?.getSpace(id)?.effectiveArchived === true,
      taskExists: id => Boolean(this.db?.getTask(id)),
      taskWorkspaceId: id => this.db?.getTask(id)?.spaceId ?? null,
      resolveTaskDirectory: id => agent.resolveTaskExecutionWorkspaceCwd(id),
      workspaceAncestors: id => this.db?.getSpaceAncestors(id).filter(s => !s.effectiveArchived).map(s => s.id) ?? [],
      artifacts: {
        read: async artifactId => {
          const descriptor = artifactDomain.service.get(artifactId);
          const content = await artifactDomain.service.readContent(artifactId);
          if (!descriptor || !content) return null;
          return {
            taskId: descriptor.taskId,
            title: descriptor.title ?? "HTML Gadget",
            kind: descriptor.kind,
            content: content.content,
          };
        },
        write: async ({ taskId, title, content }) => {
          const artifact = await artifactDomain.service.register({ taskId, kind: "html", title, content });
          return { artifactId: artifact.id };
        },
        writeFromGadget: async ({ taskId, title, source }, readOnHost) => {
          const artifact = await artifactDomain.service.registerGadgetHtml(taskId, title, { source, readOnHost });
          return { artifactId: artifact.id };
        },
      },
    });
    await gadgetService.recoverStorage();
    this.gadgetService = gadgetService;
    agent.setGadgetDomain(gadgetService);

    // 3. Workflow Cron + Terminal bridge (Core owns all Cron ticks; never call cronService.start() here)
    const terminalHost = new TerminalHost({
      resolveCwd: taskId => agent.resolveTaskExecutionWorkspaceCwd(taskId),
      resolveWorkspaceCwd: workspaceId => {
        const space = this.db?.getSpace(workspaceId);
        if (!space) throw new Error(`工作空间不存在：${workspaceId}`);
        return resolveBoundWorkspaceCwd(space, p => {
          try {
            return existsSync(p) && statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
      },
      getShellPath: () => agent.getAppSettings().terminalShellPath || undefined,
      getIsolationLevel: () => agent.getShellIsolationLevel(),
      getPathEntries: () => [getMyBuddyBinDir()],
    });
    this.terminalHost = terminalHost;
    const cronService = new CronService(
      this.db,
      agent,
      () => undefined,
      summary => {
        notifications.post({
          type: summary.status === "success" ? "automation.completed" : "automation.failed",
          level: summary.status === "success" ? "success" : "error",
          title: summary.message ? summary.jobName : summary.status === "success" ? "自动化已完成" : "自动化执行失败",
          body: summary.message ?? `${summary.jobName}${summary.error ? ` · ${summary.error}` : ""}`,
          sourceType: "automation",
          sourceId: summary.jobId,
          taskId: summary.taskId,
          projectId: summary.projectId,
          dedupeKey: `automation:${summary.jobId}:run:${summary.runId}:terminal`,
        });
      },
      agent.nativeImprovement,
      event => {
        notifications.post({
          type: "reminder.due",
          level: "info",
          title: event.jobName,
          body: "定时跟进已到期。你可以让 Dots 继续处理。",
          sourceType: "automation",
          sourceId: event.jobId,
          taskId: DOTS_TASK_ID,
          dedupeKey: `dots-timer:${event.jobId}:${event.occurrence}`,
        });
      },
    );
    this.cronService = cronService;
    agent.setLocalWorkflowServices({
      cron: cronService,
      terminal: new TaskTerminalService(terminalHost),
    });

    // 4. Dots runtime & Core-controlled monitors (zero local polling timers)
    const taskBoard = new TaskBoardRepository(this.db.connection, this.db.runtimeAuditReader);
    const dotsDelegations = new DotsDelegations(
      this.db.connection,
      (id, operation) => agent.dotsSubmission(id, operation),
      () => undefined,
      () => resolveDotsPreferences(agent.getAppSettings().dotsSettings).summaryIntervalSeconds * 1_000,
      this.db.runtimeAuditReader,
    );
    this.dotsDelegations = dotsDelegations;
    const dotsActions = new DotsActions(
      this.db,
      agent,
      {
        link: (...args) => dotsDelegations.link(...args),
        list: () => dotsDelegations.list(),
        observeTool: event => dotsDelegations.observeTool(event),
        observeProgress: (...args) => dotsDelegations.observeProgress(...args),
        rememberOrigin: (source, origin) => dotsDelegations.rememberOrigin(source, origin),
        changed: () => { dotsDelegations.refresh(); },
        failed: (...args) => dotsDelegations.failed(...args),
        preferences: () => resolveDotsPreferences(agent.getAppSettings().dotsSettings),
        fileNotice: event => notifications.post({
          type: "reminder.due",
          level: "info",
          title: "Dots 文件订阅",
          body: `${event.file} 已变化。你可以让 Dots 继续处理。`,
          sourceType: "task",
          sourceId: event.taskId,
          taskId: DOTS_TASK_ID,
          dedupeKey: `dots-watch:${event.id}:${event.revision}`,
        }),
        progressNotice: event => notifications.post({
          type: "reminder.due",
          level: "info",
          title: "Dots 事项进展",
          body: event.text,
          sourceType: "task",
          sourceId: event.taskId,
          taskId: DOTS_TASK_ID,
          dedupeKey: `dots-checkpoint:${event.operationId}`,
        }),
        failedTask: event => notifications.post({
          type: "task.failed",
          level: "error",
          title: "任务派发失败",
          body: `${event.title} · ${event.reason}`,
          sourceType: "task",
          sourceId: event.taskId,
          taskId: event.taskId,
          dedupeKey: `task:${event.taskId}:dispatch-failed`,
        }),
      },
      taskBoard,
    );
    this.dotsActions = dotsActions;
    const dotsReporting = new DotsReporting(
      this.db.connection,
      () => agent.isTaskBusy(DOTS_TASK_ID),
      (prompt, signal, onText) => agent.generateDotsReport(prompt, signal, onText),
      (reply, current) => agent.appendDotsReply(reply, current),
      () => undefined,
      this.db.runtimeAuditReader,
    );
    this.dotsReporting = dotsReporting;
    agent.setDotsForeground(() => dotsReporting.beginForeground());
    dotsDelegations.connect(
      (job, request) => dotsActions.followup(job, request),
      (reply, current) => dotsReporting.append(reply, current),
      taskId => dotsActions.allowsResult(taskId),
      kind => dotsActions.allowsReply(kind),
    );
    agent.setDotsActions(dotsActions);

    const dotsProactive = new DotsProactiveDelivery(
      this.db.connection,
      () => agent.getAppSettings().dotsSettings?.followupMode === "paused",
      (key, text, current) => agent.appendDotsProactive(key, text, current),
      this.db.runtimeAuditReader,
    );
    this.dotsProactiveDelivery = dotsProactive;

    const dotsGoogleAccounts = new DotsGoogleAccounts(
      join(this.dataDirectory, "dots", "google"),
      async () => undefined,
      async () => undefined,
      [],
    );
    const dotsGoogleMonitor = new DotsGoogleMonitor(
      dotsGoogleAccounts,
      () => normalizeDotsGoogleRules(agent.getAppSettings().dotsSettings?.google),
      () => agent.getAppSettings().dotsSettings?.followupMode === "paused",
      notice => {
        dotsProactive.post({ ...notice, source: "Google" });
        notifications.post({
          type: "reminder.due",
          level: "info",
          title: notice.title,
          body: notice.body,
          sourceType: "automation",
          sourceId: "dots-google",
          taskId: DOTS_TASK_ID,
          dedupeKey: notice.key,
        });
      },
      undefined,
      undefined,
      { coreControlled: true },
    );
    this.dotsGoogleMonitor = dotsGoogleMonitor;

    const dotsDiscovery = new DotsDiscovery(
      join(this.dataDirectory, "dots", "discovery"),
      () => {
        const { dotsSettings } = agent.getAppSettings();
        return {
          rss: normalizeRssSubscriptions(dotsSettings?.rss),
          dream: normalizeDreamSettings(dotsSettings?.dream),
          paused: dotsSettings?.followupMode === "paused",
        };
      },
      notice => {
        dotsProactive.post(notice);
        notifications.post({
          type: "automation.completed",
          level: "info",
          title: notice.title,
          body: notice.body,
          sourceType: "automation",
          sourceId: "dots-discovery",
          taskId: DOTS_TASK_ID,
          dedupeKey: notice.key,
        });
      },
      async (query, signal) => {
        const result = await searchDotsPublicWeb(query, {
          signal,
          numResults: 6,
          recencyFilter: "week",
          includeContent: false,
          budget: { remaining: 3, deadline: Date.now() + 30_000 },
        });
        if (!result.results.length && !result.providerRuns?.some(run => run.status === "success" || run.status === "empty")) {
          throw new Error("网页搜索没有可用结果回执。");
        }
        return result.results;
      },
      async (topic, items, signal) => {
        const output = await agent.generateDotsDream(
          JSON.stringify({ topic, results: items.map((item, index) => ({ index: index + 1, title: item.title, excerpt: item.summary })) }),
          AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        );
        const parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as {
          items?: Array<{ index: number; summary: string }>;
        };
        const seen = new Set<number>();
        const selected = (Array.isArray(parsed.items) ? parsed.items : []).flatMap(item => {
          if (!Number.isInteger(item?.index) || seen.has(item.index) || typeof item.summary !== "string" || !item.summary.trim()) return [];
          const original = items[item.index - 1];
          if (!original) return [];
          seen.add(item.index);
          return [{ ...original, summary: item.summary.trim().slice(0, 220) }];
        }).slice(0, 3);
        if (!selected.length) throw new Error("Dream 模型未返回可验证的条目编号。");
        return selected;
      },
      () => 0,
      undefined,
      undefined,
      undefined,
      { coreControlled: true },
    );
    this.dotsDiscovery = dotsDiscovery;
    agent.setDotsResident({
      discovery: dotsDiscovery,
      google: new DotsGoogleReads(dotsGoogleAccounts, () => normalizeDotsGoogleRules(agent.getAppSettings().dotsSettings?.google)),
    });

    await agent.init();
    await agent.resumePersistedTasks();

    // 5. Background maintenance services owned strictly under Core's maintenance_control dispatches.
    const libraryService = new LibraryService(this.db, {
      libraryRoot: this.options.libraryRoot ?? join(this.dataDirectory, "library"),
    });
    this.libraryService = libraryService;
    const projectRepository = new ProjectRepository(this.db.connection, this.db.runtimeAuditReader);
    const memoryKernel = new MemoryService(this.db);
    const projectService = new ProjectService(projectRepository, memoryKernel);
    this.projectService = projectService;
    this.attentionTracker = new ProjectAttentionTracker(projectService);
    const workGraphService = new WorkGraphService(this.db);
    this.workGraphService = workGraphService;
    const taskWorkspace = this.options.taskWorkspace ?? new TaskExecutionWorkspace(join(this.dataDirectory, "task-workspaces"));
    this.taskLifecycle = new TaskExecutionWorkspaceLifecycle({
      db: this.db,
      workspace: taskWorkspace,
      trashRoot: this.options.trashRoot ?? join(this.dataDirectory, "task-workspaces-trash"),
      onPurgeArtifacts: async taskId => {
        await artifactDomain.service.removeByTask(taskId, { requireTrashed: true });
      },
      onPurge: async taskId => {
        await agent.purgeDurableTask(taskId).catch(() => undefined);
        try { agent.clearTaskConnectorIds(taskId); } catch { /* ignore */ }
        await gadgetService.deleteByTask(taskId).catch(() => undefined);
        await workGraphService.cleanupByNodeAsync("task", taskId);
      },
    });

    this.offPatch = agent.onPatch((patch: AgentUiPatch) => {
      if ("taskId" in patch && typeof patch.taskId === "string") {
        const ephemeral = patch.type === "text_delta" || patch.type === "thinking_delta";
        this.pushProgressToTask(patch.taskId, { kind: "ui_patch", patch }, ephemeral ? { ephemeral: true } : undefined);
      }
    });
    agent.setTaskLifecycleListener((event: AgentTaskLifecycleEvent) => {
      this.pushProgressToTask(event.taskId, { kind: "task_lifecycle", event });
    });

    const runDotsControlCycle = async (cycleKey: string): Promise<void> => {
      switch (cycleKey) {
        case "google":
          await dotsGoogleMonitor.runCycle();
          return;
        case "discovery":
          await dotsDiscovery.runCycle();
          return;
        case "proactive":
          dotsProactive.refresh();
          await dotsProactive.flushWrites();
          return;
        case "file_watch":
        case "watches":
          dotsDelegations.refresh();
          return;
        default:
          throw new Error(`Unsupported Dots control cycle: ${cycleKey}`);
      }
    };

    const baseRunner = createDurableBotExecutionRunner({
      submit: req => agent.prompt(req, { durableAdmissionOnly: true }),
      submitCron: req => agent.prompt(req),
      waitForSubmission: receipt => agent.waitForSubmission(receipt),
      abort: id => agent.abort(id),
      stopObservedRun: id => agent.stopDotsTarget(id),
      findSubmission: (id, op) => agent.findSubmission(id, op),
      isTaskBusy: id => agent.isTaskBusy(id),
      resolveAvailableModelId: id => agent.resolveAvailableModelId(id),
      dotsSubmission: (id, op) => agent.dotsSubmission(id, op),
      ...(this.options.capabilities?.dotsControl !== false ? { runDotsControlCycle } : {}),
      ...(this.options.runGatewayControlCycle ? { runGatewayControlCycle: this.options.runGatewayControlCycle } : {}),
    });

    const runner: ExecutionBridgeRunner = {
      start: async (dispatch: CoreExecutionDispatch, helpers) => {
        const taskId = dispatch.execution.taskId;
        const untrack = this.trackTaskReporter(taskId, helpers);
        try {
          if (dispatch.execution.kind === "pi_turn") {
            return await this.runPiTurnDispatch(agent, dispatch, helpers);
          }
          if (dispatch.execution.kind === "pi_compact") {
            const outcome = await agent.compactTask(taskId);
            return { status: outcome.ok ? "completed" : "failed", result: outcome };
          }
          if (dispatch.execution.kind === "pi_control") {
            return await this.runPiControlDispatch(agent, dispatch, helpers);
          }
          if (dispatch.execution.kind === "maintenance_control") {
            return await this.runMaintenanceControlDispatch(dispatch);
          }
          return await baseRunner.start(dispatch, helpers);
        } finally {
          untrack();
        }
      },
      cancel: async (executionId, taskId) => {
        if (taskId === DOTS_TASK_ID || executionId.startsWith("dots-")) {
          await agent.abort(taskId);
          return;
        }
        await baseRunner.cancel?.(executionId, taskId);
      },
      pause: async (executionId, taskId) => {
        await baseRunner.pause?.(executionId, taskId);
      },
    };

    const bridge = new ExecutionHostBridge(
      this.options.runtimeAuditExecutable,
      this.options.dbPath,
      this.dataDirectory,
      runner,
      this.hostId,
      this.hostGeneration,
    );
    this.bridge = bridge;

    const registerWithCore = async (client: CoreBusinessClient, closeOnFence: boolean): Promise<boolean> => {
      platformRpc.attach(client);
      const registration = await client.piHost<{
        accepted?: boolean;
        fenced?: boolean;
        reason?: string;
      }>({
        action: "register",
        hostId: this.hostId,
        pid: process.pid,
        hostGeneration: this.hostGeneration,
        storageRoot: this.storageRoot,
        dbPath: this.options.dbPath,
        piVersion: actual,
        expectedPiVersion: expected,
        capabilities: this.declaredCapabilities,
      });
      if (!registration?.accepted || registration.fenced) {
        if (closeOnFence) {
          console.warn("[PiNodeHost] Registration rejected or fenced after reconnect:", registration?.reason ?? "fenced");
          await this.close().catch(() => undefined);
          return false;
        }
        throw new Error(`PiNodeHost registration rejected: ${registration?.reason ?? "fenced"}`);
      }
      return true;
    };

    this.offReconnect = bridge.onReconnected(async reconnectedClient => {
      if (this.closed) return;
      await registerWithCore(reconnectedClient, true);
    });

    const initialClient = await bridge.connect();
    try {
      await registerWithCore(initialClient, false);
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }

    const heartbeatMs = Math.max(500, this.options.heartbeatIntervalMs ?? 5_000);
    this.heartbeatTimer = setInterval(() => {
      const activeClient = this.bridge?.connection;
      if (this.closed || !activeClient || activeClient.isClosed) return;
      void activeClient.piHost<{ accepted?: boolean; fenced?: boolean }>({
        action: "heartbeat",
        hostId: this.hostId,
        pid: process.pid,
        hostGeneration: this.hostGeneration,
      }).then(reply => {
        if (reply && (!reply.accepted || reply.fenced)) {
          console.warn("[PiNodeHost] Generation fenced or lost ownership; shutting down host", this.hostGeneration);
          void this.close().catch(() => undefined);
        }
      }).catch(() => undefined);
    }, heartbeatMs);
    this.heartbeatTimer.unref?.();

    return {
      hostId: this.hostId,
      hostGeneration: this.hostGeneration,
      piVersion: actual,
      pid: process.pid,
      capabilities: [...this.declaredCapabilities],
    };
  }

  private async runPiTurnDispatch(
    agent: AgentService,
    dispatch: CoreExecutionDispatch,
    helpers: ActiveProgressReporter,
  ): Promise<{ status: "completed" | "failed" | "cancelled" | "paused" | "unknown"; result?: unknown; errorMessage?: string }> {
    const payload = dispatch.execution.payload as Partial<AgentPromptRequest> & {
      prompt?: string;
      durableAdmissionOnly?: boolean;
      waitForSettled?: boolean;
    };
    const req: AgentPromptRequest = {
      taskId: dispatch.execution.taskId,
      userMessageId: payload.userMessageId ?? dispatch.execution.idempotencyKey,
      assistantMessageId: payload.assistantMessageId ?? `asst-${dispatch.execution.idempotencyKey}`,
      text: typeof payload.text === "string"
        ? payload.text
        : (typeof payload.prompt === "string" ? payload.prompt : ""),
      ...payload,
    } as AgentPromptRequest;

    const existing = await agent.findSubmission(req.taskId, req.userMessageId).catch(() => undefined);
    if (existing?.receipt) {
      await helpers.reportProgress({ kind: "submission_receipt", result: existing }).catch(() => undefined);
      if (existing.receipt.status === "done") return { status: "completed", result: existing };
      if (existing.receipt.status === "unanswered") return { status: "unknown", result: existing };
      if (payload.waitForSettled === false) return { status: "completed", result: existing };
      const settled = await agent.waitForSubmission(existing.receipt);
      return this.settledResult(settled);
    }

    const accepted = await agent.prompt(req, { durableAdmissionOnly: payload.durableAdmissionOnly ?? true });
    await helpers.reportProgress({ kind: "submission_receipt", result: accepted }).catch(() => undefined);
    if (accepted.cancelled) return { status: "cancelled", result: accepted };
    if (accepted.error) return { status: "failed", result: accepted, errorMessage: accepted.error.message };
    if (!accepted.receipt) return { status: "completed", result: accepted };
    if (payload.waitForSettled === false) return { status: "completed", result: accepted };
    const settled = await agent.waitForSubmission(accepted.receipt);
    return this.settledResult(settled);
  }

  private settledResult(settled: Awaited<ReturnType<AgentService["waitForSubmission"]>>) {
    if (settled.cancelled) return { status: "cancelled" as const, result: settled };
    if (settled.error) return { status: "failed" as const, result: settled, errorMessage: settled.error.message };
    if (settled.receipt?.status === "unanswered") return { status: "unknown" as const, result: settled };
    return { status: "completed" as const, result: settled };
  }

  private async runPiControlDispatch(
    agent: AgentService,
    dispatch: CoreExecutionDispatch,
    helpers: ActiveProgressReporter,
  ): Promise<{ status: "completed" | "failed"; result?: unknown; errorMessage?: string }> {
    const payload = dispatch.execution.payload as Record<string, unknown>;
    const control = String(payload.controlAction ?? "");
    switch (control) {
      case "abort": {
        const res = await agent.abort(String(payload.taskId ?? dispatch.execution.taskId));
        return { status: "completed", result: res ?? null };
      }
      case "regenerate": {
        const res = await agent.regenerate(payload.request as AgentRegenerateRequest);
        return { status: "completed", result: res };
      }
      case "deleteUserMessage": {
        await agent.deleteUserMessage(payload.request as AgentDeleteUserMessageRequest);
        return { status: "completed", result: { ok: true } };
      }
      case "findSubmission": {
        const res = await agent.findSubmission(String(payload.taskId), String(payload.operationId));
        return { status: "completed", result: res ?? null };
      }
      case "submissionStatus": {
        const receipt = payload.receipt as AgentSubmissionReceipt;
        const res = payload.wait
          ? await agent.waitForSubmission(receipt)
          : await agent.submissionStatus(receipt);
        return { status: "completed", result: res };
      }
      case "newDotsConversation": {
        await agent.newDotsConversation();
        return { status: "completed", result: { ok: true } };
      }
      case "openDots": {
        const res = await agent.openDots();
        return { status: "completed", result: res };
      }
      case "generateTaskTitle": {
        const res = await agent.generateTaskTitle(String(payload.taskId ?? dispatch.execution.taskId), payload.maxTokens as number | undefined);
        return { status: "completed", result: res };
      }
      case "listModels": {
        const res = await agent.listModels();
        return { status: "completed", result: res };
      }
      case "reloadModels": {
        const res = await agent.reloadModels(typeof payload.providerId === "string" ? payload.providerId : undefined);
        return { status: "completed", result: res };
      }
      case "listLoginProviders": {
        const res = await agent.listLoginProviders();
        return { status: "completed", result: res };
      }
      case "setProviderEnabled": {
        const res = await agent.setProviderEnabled(String(payload.providerId), Boolean(payload.enabled));
        return { status: "completed", result: res };
      }
      case "listCredentials": {
        const res = await agent.listCredentials();
        return { status: "completed", result: res };
      }
      case "login": {
        const res = await agent.login(payload.request as AuthLoginRequest);
        return { status: "completed", result: res };
      }
      case "logout": {
        const res = await agent.logout(String(payload.providerId));
        return { status: "completed", result: res };
      }
      case "authRespond": {
        const ok = await agent.authRespond(String(payload.requestId), String(payload.value ?? ""));
        return { status: "completed", result: ok };
      }
      case "authCancel": {
        await agent.authCancel(typeof payload.requestId === "string" ? payload.requestId : undefined);
        return { status: "completed", result: { ok: true } };
      }
      case "generateDotsReport": {
        const ac = new AbortController();
        const text = await agent.generateDotsReport(
          String(payload.prompt ?? ""),
          ac.signal,
          delta => {
            void helpers.reportProgress({ kind: "dots_report_delta", text: delta }, { ephemeral: true }).catch(error => {
              this.progressErrors += 1;
              console.warn("[PiNodeHost] dots report delta delivery failed:", error instanceof Error ? error.message : String(error));
            });
          },
        );
        return { status: "completed", result: text };
      }
      case "generateDotsDream": {
        const ac = new AbortController();
        const text = await agent.generateDotsDream(String(payload.prompt ?? ""), ac.signal);
        return { status: "completed", result: text };
      }
      default:
        return { status: "failed", errorMessage: `Unsupported Pi control action: ${control}` };
    }
  }

  private async runMaintenanceControlDispatch(
    dispatch: CoreExecutionDispatch,
  ): Promise<{ status: "completed" | "failed"; result?: unknown; errorMessage?: string }> {
    const payload = (dispatch.execution.payload ?? {}) as Record<string, unknown>;
    const cycle = String(payload.maintenanceCycle ?? payload.cycle ?? "").trim();
    const trigger = String(payload.trigger ?? "scheduled");
    switch (cycle) {
      case "library_maintenance": {
        if (!this.libraryService) {
          return { status: "failed", errorMessage: "CAPABILITY_UNAVAILABLE: libraryService not initialized" };
        }
        await this.libraryService.recoverFileDeletes();
        await this.libraryService.recoverLibraryRestores();
        await this.libraryService.recoverPendingExtractions();
        const ftsV2 = await this.libraryService.recoverTextFtsCoverageV2({ batchSize: 20 });
        const chunks = await this.libraryService.backfillMissingChunks({ batchSize: 20 });
        return { status: "completed", result: { cycle, trigger, ftsV2, chunks } };
      }
      case "project_cadence": {
        if (!this.projectService || !this.attentionTracker) {
          return { status: "failed", errorMessage: "CAPABILITY_UNAVAILABLE: project cadence services not initialized" };
        }
        const projectIds = Array.isArray(payload.projectIds) && payload.projectIds.length > 0
          ? payload.projectIds.map(String)
          : (await this.projectService.readList(true)).map(p => p.id);
        const notifiedProjects: string[] = [];
        for (const projectId of projectIds) {
          try { this.projectService.generateActionProposals(projectId); } catch { /* ignore in readonly/best-effort */ }
          const digest = await this.attentionTracker.readChange(projectId);
          if (digest && (digest.blockerCount > 0 || digest.atRiskCount > 0 || digest.needsConfirmation > 0)) {
            const projectName = this.projectService.get(projectId)?.name ?? "项目";
            const detail = [
              digest.blockerCount > 0 ? `${digest.blockerCount} 个阻塞` : "",
              digest.atRiskCount > 0 ? `${digest.atRiskCount} 个风险` : "",
              digest.needsConfirmation > 0 ? `${digest.needsConfirmation} 项待确认` : "",
            ].filter(Boolean).join(" · ");
            this.notificationService?.post({
              type: "project.attention",
              level: digest.blockerCount > 0 ? "error" : "warning",
              title: "项目需要关注",
              body: `${projectName}${detail ? ` · ${detail}` : ""}`,
              sourceType: "project",
              sourceId: projectId,
              projectId,
              dedupeKey: `project:${projectId}:attention:${digest.fingerprint}`,
            });
            notifiedProjects.push(projectId);
          }
        }
        return { status: "completed", result: { cycle, trigger, checkedProjects: projectIds.length, notifiedProjects } };
      }
      case "trash_purge": {
        if (!this.taskLifecycle) {
          return { status: "failed", errorMessage: "CAPABILITY_UNAVAILABLE: taskLifecycle not initialized" };
        }
        const aligned = trigger === "startup" ? await this.taskLifecycle.alignTrashRetention() : 0;
        const results = await this.taskLifecycle.purgeExpired();
        const purgedTaskIds = results.filter(r => r.removedTaskRow).map(r => r.taskId);
        return { status: "completed", result: { cycle, trigger, aligned, purgedCount: purgedTaskIds.length, purgedTaskIds } };
      }
      case "snapshot_compaction": {
        const migrated = (await this.db?.runtimeAuditReader?.compactSnapshots()) ?? 0;
        return { status: "completed", result: { cycle, trigger, migrated } };
      }
      default:
        return { status: "failed", errorMessage: `Unsupported maintenance cycle: ${cycle || "(empty)"}` };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.offReconnect?.();
    this.offReconnect = undefined;
    this.offPatch?.();
    this.offPatch = undefined;
    this.reportersByTask.clear();
    this.platformRpc?.dispose();
    this.platformRpc = undefined;
    await this.dotsDiscovery?.close().catch(() => undefined);
    await this.dotsGoogleMonitor?.close().catch(() => undefined);
    await this.dotsProactiveDelivery?.close().catch(() => undefined);
    await this.dotsActions?.closeFileWatches().catch(() => undefined);
    try { this.dotsDelegations?.close(); } catch { /* ignore */ }
    this.cronService?.stop();
    await this.gadgetRuntime?.disposeAll().catch(() => undefined);
    this.terminalHost?.dispose();
    await this.bridge?.close().catch(() => undefined);
    this.bridge = undefined;
    try {
      this.agentService?.dispose();
    } catch { /* ignore */ }
    await this.agentService?.closeAuditWrites().catch(() => undefined);
    this.agentService = undefined;
    await this.libraryService?.stopSemanticIndexing().catch(() => undefined);
    await this.libraryService?.flushWrites().catch(() => undefined);
    this.libraryService = undefined;
    this.projectService = undefined;
    this.attentionTracker = undefined;
    this.workGraphService = undefined;
    this.taskLifecycle = undefined;
    await this.db?.runtimeAuditReader?.close().catch(() => undefined);
    this.db?.close();
    this.db = undefined;
  }
}
