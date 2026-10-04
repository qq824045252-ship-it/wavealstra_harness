import AutomationPage from "@/components/pages/AutomationPage";

interface Props {
  projectId: string;
  startInForm: boolean;
  onClose: () => void;
}

/** 项目配置里的自动化：复用本地 AutomationPage，套一层弹窗 */
export default function ProjectAutomationModal({
  projectId,
  startInForm,
  onClose,
}: Props): React.JSX.Element {
  return (
    <div className="modal-overlay" role="presentation">
      <div
        className="project-auto-modal"
        role="dialog"
        aria-modal="true"
        aria-label="自动化任务"
        onClick={(event) => event.stopPropagation()}
      >
        <AutomationPage
          projectId={projectId}
          variant="modal"
          startInForm={startInForm}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
