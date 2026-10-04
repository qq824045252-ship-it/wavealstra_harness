import { IconBook } from "@/components/common/icons";

interface Props {
  title: string;
  description: string;
  phase: string;
}

export default function PlaceholderPage({ title, description, phase }: Props): React.JSX.Element {
  return (
    <div className="page-scroll">
      <div className="page-container placeholder-center">
        <div className="placeholder-icon">
          <IconBook size={36} />
        </div>
        <div className="page-title">{title}</div>
        <div className="page-sub">{description}</div>
        <div className="placeholder-phase">{phase}</div>
      </div>
    </div>
  );
}
