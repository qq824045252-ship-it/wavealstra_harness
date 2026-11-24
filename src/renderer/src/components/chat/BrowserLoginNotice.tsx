import { useTaskBrowserTabs } from "@/lib/useTaskBrowserTabs";
import { useAppStore } from "@/store/appStore";

export default function BrowserLoginNotice({ taskId }: { taskId: string }): React.JSX.Element | null {
  const tabs = useTaskBrowserTabs(taskId);
  if (!tabs.some(tab => tab.control === "login")) return null;
  return (
    <div className="durable-bot-state" role="status">
      <button type="button" className="btn" onClick={() => {
        useAppStore.setState({ browserSpace: "task" });
        useAppStore.getState().showBrowser();
      }}>打开登录页面</button>
    </div>
  );
}
