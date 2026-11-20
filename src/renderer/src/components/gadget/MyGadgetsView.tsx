import GadgetSection from "./GadgetSection";
import { useDesktopSectionState, useDesktopShell } from "@/components/desktop/DesktopSection";
import "@/components/pages/desktop-secondary.css";

export default function MyGadgetsView(): React.JSX.Element {
  const desktop = useDesktopShell();
  const [selectedId, onSelect] = useDesktopSectionState<string | null>("workbench-selection", null);
  const [query, onQueryChange] = useDesktopSectionState("workbench-search", "");

  return (
    <main className={`gadget-page${desktop ? " desktop-workbench" : ""}`}>
      <header className={desktop ? "desktop-secondary-heading" : "gadget-page-header"}>
        <h1>我的工作台</h1>
      </header>
      <div className="gadget-page-body">
        <GadgetSection scope={{ type: "global" }} title="个人工具"
          workbench={desktop ? { selectedId, onSelect, query, onQueryChange } : undefined} />
      </div>
    </main>
  );
}
