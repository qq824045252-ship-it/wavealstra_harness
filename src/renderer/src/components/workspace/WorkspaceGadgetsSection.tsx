import GadgetSection from "@/components/gadget/GadgetSection";

export default function WorkspaceGadgetsSection({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  return (
    <div className="workspace-gadgets">
      <GadgetSection scope={{ type: "workspace", workspaceId }} includeInherited title="Current" />
    </div>
  );
}
