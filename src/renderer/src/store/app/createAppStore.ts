import { guardHistoricalTeamNavigation } from "./runtime/historicalTeamNavigation";
import { create } from "zustand";
import type { AppContext, AppStoreDependencies } from "./context";
import type { AppState } from "./types";
import { createAppRuntimeState } from "./runtime/state";
import { createAppSelectors } from "./selectors";
import { createAppUiState } from "./slices/appUi";
import { createTasksState } from "./slices/tasks";
import { createWorkspacesState } from "./slices/workspaces";
import { createProjectsState } from "./slices/projects";
import { createActiveContextState } from "./slices/activeContext";
import { createComposerState } from "./slices/composer";
import { createArtifactsState } from "./slices/artifacts";
import { createWorkbenchState } from "./slices/workbench";
import { createTerminalState } from "./slices/terminal";
import { createAppConfigState } from "./slices/appConfig";
import { createCapabilitiesState } from "./slices/capabilities";
import { createAppUiActions } from "./slices/appUi";
import { createTasksActions } from "./slices/tasks";
import { createWorkspacesActions } from "./slices/workspaces";
import { createProjectsActions } from "./slices/projects";
import { createActiveContextActions } from "./slices/activeContext";
import { createComposerActions } from "./slices/composer";
import { createArtifactsActions } from "./slices/artifacts";
import { createWorkbenchActions } from "./slices/workbench";
import { createTerminalActions } from "./slices/terminal";
import { createAppConfigActions } from "./slices/appConfig";
import { createCapabilitiesActions } from "./slices/capabilities";
import { createAppNavigationActions } from "./commands/appNavigation";
import { createProjectNavigationActions } from "./commands/projectNavigation";
import { createTaskDraftActions } from "./commands/taskDraft";
import { createTaskActivationActions } from "./commands/taskActivation";
import { createSessionConfigurationActions } from "./commands/sessionConfiguration";
import { createTaskContextActions } from "./commands/taskContext";
import { createComposerInputActions } from "./commands/composerInput";
import { createTerminalTabsActions } from "./commands/terminalTabs";
import { createRelatedTasksActions } from "./commands/relatedTasks";
import { createConversationBranchActions } from "./commands/conversationBranch";
import { createTaskLifecycleActions } from "./commands/taskLifecycle";
import { createSendMessageActions } from "./commands/sendMessage";
import { createMessageRevisionActions } from "./commands/messageRevision";
import { createRunControlActions } from "./commands/runControl";
import { createArtifactPreviewActions } from "./commands/artifactPreview";
import { createArtifactLifecycleActions } from "./commands/artifactLifecycle";
import { createFileArtifactsActions } from "./commands/fileArtifacts";
import { createWorkbenchLayoutActions } from "./commands/workbenchLayout";
import { createBrowserNavigationActions } from "./commands/browserNavigation";
import { createWorkspaceLifecycleActions } from "./commands/workspaceLifecycle";
import { createWorkspaceMovesActions } from "./commands/workspaceMoves";
import { createInitRuntimeActions } from "./runtime/initRuntime";
import { createAgentProjectionActions } from "./runtime/agentProjection";
import { createArtifactProjectionActions } from "./runtime/artifactProjection";
import { createArtifactRenderActions } from "./runtime/artifactRender";

/** One root store; factories make runtime resources and selector caches test-isolated. */
export function createAppStore(dependencies: AppStoreDependencies = {}) {
  const runtime = createAppRuntimeState();
  const appSelectors = createAppSelectors();
  let context!: AppContext;
  const useAppStore = create<AppState>()((set, get) => {
    context = {
      set: ((partial, replace) => {
        const observed = typeof partial === "function" ? (state: AppState) => {
          const patch = guardHistoricalTeamNavigation(state, partial(state));
          if (patch !== state) runtime.botNavigation.observePatch(patch);
          return patch;
        } : guardHistoricalTeamNavigation(get(), partial);
        if (typeof observed !== "function") runtime.botNavigation.observePatch(observed);
        // Preserve Zustand's replace overload while observing explicit page writes.
        if (replace) set(observed as AppState | ((state: AppState) => AppState), true);
        else set(observed, false);
      }) as AppContext["set"],
      get,
      runtime,
      getApi: dependencies.getApi ?? (() => typeof window === "undefined" ? undefined : window.api),
    };
    return {
      ...createAppUiState(),
      ...createTasksState(),
      ...createWorkspacesState(),
      ...createProjectsState(),
      ...createActiveContextState(),
      ...createComposerState(),
      ...createArtifactsState(),
      ...createWorkbenchState(),
      ...createTerminalState(),
      ...createAppConfigState(),
      ...createCapabilitiesState(),
      ...createAppUiActions(context),
      ...createTasksActions(context),
      ...createWorkspacesActions(context),
      ...createProjectsActions(context),
      ...createActiveContextActions(context),
      ...createComposerActions(context),
      ...createArtifactsActions(context),
      ...createWorkbenchActions(context),
      ...createTerminalActions(context),
      ...createAppConfigActions(context),
      ...createCapabilitiesActions(context),
      ...createAppNavigationActions(context),
      ...createProjectNavigationActions(context),
      ...createTaskDraftActions(context),
      ...createTaskActivationActions(context),
      ...createSessionConfigurationActions(context),
      ...createTaskContextActions(context),
      ...createComposerInputActions(context),
      ...createTerminalTabsActions(context),
      ...createRelatedTasksActions(context),
      ...createConversationBranchActions(context),
      ...createTaskLifecycleActions(context),
      ...createSendMessageActions(context),
      ...createMessageRevisionActions(context),
      ...createRunControlActions(context),
      ...createArtifactPreviewActions(context),
      ...createArtifactLifecycleActions(context),
      ...createFileArtifactsActions(context),
      ...createWorkbenchLayoutActions(context),
      ...createBrowserNavigationActions(context),
      ...createWorkspaceLifecycleActions(context),
      ...createWorkspaceMovesActions(context),
      ...createInitRuntimeActions(context),
      ...createAgentProjectionActions(context),
      ...createArtifactProjectionActions(context),
      ...createArtifactRenderActions(context),
    };
  });
  useAppStore.subscribe((state, previous) => {
    if (state.page !== previous.page || state.activeBotId !== previous.activeBotId
      || state.selectedWorkId !== previous.selectedWorkId || state.botIdentities !== previous.botIdentities
      || state.botWorks !== previous.botWorks) runtime.botNavigation.persist(state);
  });
  return { useAppStore, appSelectors, context };
}
