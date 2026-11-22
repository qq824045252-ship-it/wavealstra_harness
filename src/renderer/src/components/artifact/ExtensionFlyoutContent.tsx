import type { PanelMode } from "@/store/appStore";
import ExtensionFlyout from "./ExtensionFlyout";
import OverviewView from "./OverviewView";
import ArtifactsView from "./ArtifactsView";
import WorkspaceFilesView from "./WorkspaceFilesView";
import ChangesView from "./ChangesView";
import { useCodeReviewTaskId } from "./code-review/useCodeReviewTaskId";
import TaskGadgetsView from "./TaskGadgetsView";

interface Props {
  view: PanelMode;
  wsSearch?: string;
}

export default function ExtensionFlyoutContent({ view, wsSearch = "" }: Props): React.JSX.Element {
  const reviewTaskId = useCodeReviewTaskId();
  let body: React.JSX.Element;
  switch (view) {
    case "workspace":
      body = <WorkspaceFilesView query={wsSearch} floating />;
      break;
    case "changes":
      body = <ChangesView key={reviewTaskId ?? "no-task"} taskId={reviewTaskId} />;
      break;
    case "artifacts":
      body = <ArtifactsView floating />;
      break;
    case "gadgets":
      body = <TaskGadgetsView floating />;
      break;
    case "overview":
    default:
      body = <OverviewView floating />;
      break;
  }

  return <ExtensionFlyout>{body}</ExtensionFlyout>;
}
