import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PermissionMode, WelcomeMode } from "../../shared/agent-ipc";
import type { ExternalWriteApprovalRequest, ExternalWriteDecision } from "../../shared/external-write";
import { AppDatabase } from "../db/AppDatabase";
import type { GadgetService } from "../gadget/GadgetService";
import { createGadgetAgentExtension } from "../gadget/gadget-agent-extension";
import { createMemoryExtension } from "../memory/memory-extension";
import type { MemoryService } from "../memory/MemoryService";
import { createProjectAutopilotExtension } from "../project/project-autopilot-extension";
import { createProjectNotesExtension } from "../project/project-notes-extension";
import { ProjectNotesService } from "../project/ProjectNotesService";
import { createProjectContextExtension } from "../project/project-context-extension";
import { createProjectEventExtension } from "../project/project-event-extension";
import { createProjectKnowledgeExtension } from "../project/project-knowledge-extension";
import { createProjectPlanExtension } from "../project/project-plan-extension";
import { ProjectDocumentImporter } from "../project/ProjectDocumentImporter";
import { ProjectEventIngestor } from "../project/ProjectEventIngestor";
import { ProjectEventPromoter } from "../project/ProjectEventPromoter";
import { ProjectKnowledgeRetrieval } from "../project/ProjectKnowledgeRetrieval";
import type { ProjectService } from "../project/ProjectService";
import { MANAGED_RUNTIME_DANGEROUS_TOOLS } from "../security/McpSideEffectPolicy";
import type { TaskFileAccessPolicy } from "../security/TaskFileAccessPolicy";
import { createBuiltinCapabilityExtension } from "../capabilities/builtin-capability-extension";
import { createLibraryExtension } from "../library/library-extension";
import { createWorkspaceNotesExtension } from "../workspace/workspace-notes-extension";
import { WorkspaceNotesService } from "../workspace/WorkspaceNotesService";
import { createWorkspaceResourceLocatorExtension } from "../workspace/workspace-resource-locator-extension";
import { WorkGraphService } from "../workgraph/WorkGraphService";
import { createWorkGraphAgentExtension } from "../workgraph/work-graph-agent-extension";
import type { McpRuntimeService } from "../mcp/McpRuntimeService";
import { createConversationRuntimeExtension } from "./conversation-runtime-extension";
import type { ConversationGoalService } from "./ConversationGoalService";
import type { ConversationInteractionService } from "./ConversationInteractionService";
import { createMcpSideEffectExtension } from "./mcp-side-effect-extension";
import { createPermissionExtension } from "./permission-extension";
import type { LibraryWorkspaceContextService } from "./LibraryWorkspaceContextService";
import type { ExecutionAttemptRepository } from "./ExecutionAttemptRepository";
import type { ExecutionFailureRepository } from "./ExecutionFailureRepository";
import { currentDurableExecutionContext, currentDurableExecutionCwd, currentDurableInvocation, currentDurableRunId } from "./durable/DurableExecutionContext";

export type SessionApprovalRequest = Parameters<Parameters<typeof createPermissionExtension>[0]["requestApproval"]>[0];
export type SessionBuiltinCapabilityBridge = Omit<
  Parameters<typeof createBuiltinCapabilityExtension>[0],
  "taskId" | "taskRoot" | "shellVerification" | "computerRecovery" | "uiRecovery" | "browserRecovery" | "skillAuthoringRecovery"
>;

type McpInlineOptions = NonNullable<Parameters<McpRuntimeService["getInlineExtensions"]>[0]>;

export interface SessionExtensionAssemblerDependencies {
  db: AppDatabase;
  memory: MemoryService;
  project: ProjectService;
  libraryWorkspace: LibraryWorkspaceContextService;
  conversationInteractions: ConversationInteractionService;
  conversationGoals: ConversationGoalService;
  executionAttempts: ExecutionAttemptRepository;
  executionFailures: ExecutionFailureRepository;
  mcpRuntime: McpRuntimeService;
  onProjectEventsChanged?: (projectId: string) => void;
}

export interface SessionExtensionAssemblyInput {
  taskId: string;
  taskRoot: string;
  welcomeMode: WelcomeMode;
  modePresetId?: string | null;
  memoryEnabled: boolean;
  subagentEnabled: boolean;
  sessionPolicy: TaskFileAccessPolicy;
  getPermissionMode: () => PermissionMode;
  requestExternalWriteApproval: (request: ExternalWriteApprovalRequest) => Promise<ExternalWriteDecision>;
  requestApproval: (request: SessionApprovalRequest) => Promise<boolean>;
  resolveConversationContext: Parameters<typeof createConversationRuntimeExtension>[0]["resolveContext"];
  builtinCapability: SessionBuiltinCapabilityBridge;
  mcp: Pick<McpInlineOptions, "mcpPolicy" | "mcpFilter"> & {
    providerIds: string[];
    ensureRuntimeReady: (providerId: string) => Promise<void>;
  };
  gadgetService: GadgetService | null;
  extraFactories?: InlineExtension[];
}

export type DurableExtensionAssemblyInput = Pick<SessionExtensionAssemblyInput,
  "taskId" | "taskRoot" | "memoryEnabled" | "gadgetService" | "getPermissionMode" | "requestApproval" | "builtinCapability">;

/**
 * Single owner for main-session extension registration and ordering.
 * AgentService supplies live bridges; this class owns factory construction and domain wiring.
 */
export class SessionExtensionAssembler {
  private projectEventPromoter: ProjectEventPromoter | null = null;
  private projectEventIngestor: ProjectEventIngestor | null = null;
  private projectDocumentImporter: ProjectDocumentImporter | null = null;

  constructor(private readonly deps: SessionExtensionAssemblerDependencies) {}

  domainExtensions(taskId: string, memoryEnabled: boolean, gadgetService: GadgetService | null,
    policy: Pick<SessionExtensionAssemblyInput, "getPermissionMode" | "requestApproval">): InlineExtension[] {
    return this.domainFactories({ taskId, memoryEnabled, gadgetService, ...policy }, () => this.deps.db.getTask(taskId)?.projectId ?? null,
    () => this.deps.db.getTask(taskId)?.spaceId ?? null);
  }

  /** Product operations and evidence use native call identity; Durable owns their lifecycle. */
  durableExtensions(input: DurableExtensionAssemblyInput): InlineExtension[] {
    return [
      ...this.conversationCapabilityFactories({ ...input, resolveConversationContext: currentDurableExecutionContext }, true),
      ...this.domainExtensions(input.taskId, input.memoryEnabled, input.gadgetService, input),
    ];
  }

  async build(input: SessionExtensionAssemblyInput): Promise<InlineExtension[]> {
    const resolveProjectId = () => this.deps.db.getTask(input.taskId)?.projectId ?? null;
    const resolveWorkspaceId = () => this.deps.db.getTask(input.taskId)?.spaceId ?? null;

    return [
      ...this.conversationCapabilityFactories(input),
      ...this.mcpPermissionFactories(input),
      ...this.domainFactories(input, resolveProjectId, resolveWorkspaceId),
      ...(input.extraFactories ?? []),
    ];
  }

  private conversationCapabilityFactories(input: Pick<SessionExtensionAssemblyInput,
    "taskId" | "taskRoot" | "resolveConversationContext" | "builtinCapability">, durable = false): InlineExtension[] {
    return [
      createConversationRuntimeExtension({
        resolveContext: input.resolveConversationContext,
        interaction: this.deps.conversationInteractions,
        goal: this.deps.conversationGoals,
        ...(durable ? { requestInteraction: async (context, request, signal, toolCallId) => {
          const active = currentDurableInvocation();
          if (!active || active.execution.taskId !== input.taskId) throw new Error("交互缺少当前任务的持久执行身份");
          const answer = this.deps.conversationInteractions.requestDurable(context, request, {
            key: toolCallId, signal,
            onPending: interaction => { void active.native.details({ interactionId: interaction.id, waitingForInput: true }, active.context).catch(() => {}); },
          });
          return answer;
        } } : {}),
      }),
      createBuiltinCapabilityExtension({
        taskId: input.taskId,
        get taskRoot() { return durable ? currentDurableExecutionCwd() ?? input.taskRoot : input.taskRoot; },
        ...input.builtinCapability,
        ...(durable ? { getExecutionRunId: currentDurableRunId } : {}),
        shellVerification: { resolveContext: input.resolveConversationContext, attempts: this.deps.executionAttempts, failures: this.deps.executionFailures },
        computerRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures },
        uiRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures },
        browserRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures },
        skillAuthoringRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures },
      }),
    ];
  }

  private mcpPermissionFactories(input: SessionExtensionAssemblyInput): InlineExtension[] {
    return [
      ...this.deps.mcpRuntime.getInlineExtensions({
        welcomeMode: input.welcomeMode,
        mcpPolicy: input.mcp.mcpPolicy,
        mcpFilter: input.mcp.mcpFilter,
        sessionLabel: input.taskId,
      }),
      createMcpSideEffectExtension({
        taskId: input.taskId,
        taskRoot: input.taskRoot,
        providerIds: input.mcp.providerIds,
        getPermissionMode: input.getPermissionMode,
        getPolicy: () => input.sessionPolicy,
        requestExternalWriteApproval: input.requestExternalWriteApproval,
        requestApproval: input.requestApproval,
        ensureRuntimeReady: input.mcp.ensureRuntimeReady,
        dangerousTools: MANAGED_RUNTIME_DANGEROUS_TOOLS,
        resolveExecutionContext: input.resolveConversationContext,
        executionFailures: this.deps.executionFailures,
      }),
      createPermissionExtension({
        getPermissionMode: input.getPermissionMode,
        requestApproval: input.requestApproval,
      }),
    ];
  }

  private domainFactories(
    input: Pick<SessionExtensionAssemblyInput, "taskId" | "memoryEnabled" | "gadgetService" | "getPermissionMode" | "requestApproval">,
    resolveProjectId: () => string | null,
    resolveWorkspaceId: () => string | null,
  ): InlineExtension[] {
    return [
      ...(input.gadgetService
        ? [createGadgetAgentExtension({
            taskId: input.taskId,
            resolveWorkspaceId,
            service: input.gadgetService,
            getPermissionMode: input.getPermissionMode,
            requestApproval: input.requestApproval,
          })]
        : []),
      ...(input.memoryEnabled
        ? [createMemoryExtension({
            taskId: input.taskId,
            service: this.deps.memory,
            getPermissionMode: input.getPermissionMode,
            resolveProjectId,
            resolveWorkspaceId,
          })]
        : []),
      ...this.projectFactories(input, resolveProjectId),
      createWorkspaceNotesExtension({
        service: new WorkspaceNotesService(this.deps.db),
        resolveWorkspaceId,
        getPermissionMode: input.getPermissionMode,
      }),
      createLibraryExtension({
        service: this.deps.libraryWorkspace.library(),
        taskId: input.taskId,
        resolveProjectId,
        getPermissionMode: input.getPermissionMode,
      }),
      createWorkspaceResourceLocatorExtension({
        locator: this.deps.libraryWorkspace.resourceLocator(),
        taskId: input.taskId,
      }),
      createWorkGraphAgentExtension(new WorkGraphService(this.deps.db)),
      createProjectKnowledgeExtension({
        taskId: input.taskId,
        retrieval: new ProjectKnowledgeRetrieval(
          this.deps.db,
          this.deps.libraryWorkspace.library(),
          this.deps.project,
        ),
      }),
    ];
  }

  private projectFactories(
    input: Pick<SessionExtensionAssemblyInput, "taskId" | "getPermissionMode">,
    resolveProjectId: () => string | null,
  ): InlineExtension[] {
    if (!resolveProjectId()) return [];
    return [
      createProjectPlanExtension({
        taskId: input.taskId,
        resolveProjectId,
        service: this.deps.project,
        getPermissionMode: input.getPermissionMode,
      }),
      createProjectNotesExtension({
        service: new ProjectNotesService(this.deps.db),
        resolveProjectId,
        getPermissionMode: input.getPermissionMode,
      }),
      createProjectContextExtension({
        taskId: input.taskId,
        projectService: this.deps.project,
        libraryService: this.deps.libraryWorkspace.library(),
        getPermissionMode: input.getPermissionMode,
      }),
      createProjectAutopilotExtension({
        taskId: input.taskId,
        resolveProjectId,
        projectService: this.deps.project,
        getPermissionMode: input.getPermissionMode,
      }),
      createProjectEventExtension({
        taskId: input.taskId,
        resolveProjectId,
        service: this.deps.project,
        promoter: (this.projectEventPromoter ??= new ProjectEventPromoter(
          this.deps.project,
          this.deps.libraryWorkspace.library(),
        )),
        ingestor: this.projectEventIngestorInstance(),
        importer: (this.projectDocumentImporter ??= new ProjectDocumentImporter(
          this.deps.project,
          this.deps.libraryWorkspace.library(),
          this.projectEventIngestorInstance(),
        )),
        getPermissionMode: input.getPermissionMode,
      }),
    ];
  }

  private projectEventIngestorInstance(): ProjectEventIngestor {
    return (this.projectEventIngestor ??= new ProjectEventIngestor(this.deps.project, {
      onIngested: (projectId) => this.deps.onProjectEventsChanged?.(projectId),
    }));
  }
}
