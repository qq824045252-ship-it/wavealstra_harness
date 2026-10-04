import type { ProjectTemplateDefinition } from "@shared/project-template";

interface Props {
  template: ProjectTemplateDefinition;
  onPick: () => void;
}

/** 首页「从模板创建」卡片：只展示 icon + 名称 + 描述，不展示能力数量。 */
export default function ProjectTemplateCard({ template, onPick }: Props): React.JSX.Element {
  return (
    <button
      type="button"
      className="project-template-card"
      onClick={onPick}
      aria-label={`从「${template.name}」模板创建项目`}
    >
      <span className="project-template-card-icon" aria-hidden>
        {template.icon ?? "▫"}
      </span>
      <span className="project-template-card-copy">
        <span className="project-template-card-name">{template.name}</span>
        <span className="project-template-card-desc">{template.description}</span>
      </span>
    </button>
  );
}
