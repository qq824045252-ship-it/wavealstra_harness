import type { WorkCriterionDto } from "@shared/bot-work";

const normalized = (value?: string) => value?.trim().toLowerCase() ?? "";

/** Environment names remain exact evidence requirements, never aliases inferred
 * from similar model-written descriptions. Group selection is a user action. */
export function WorkEnvironmentGroups({ criteria, selectedIds, disabled, onSelect, onBring }: {
  criteria: WorkCriterionDto[]; selectedIds: string[]; disabled: boolean;
  onSelect: (ids: string[], environment: string) => void; onBring: (environment: string) => void;
}): React.JSX.Element {
  const groups = new Map<string, { environment: string; items: WorkCriterionDto[] }>();
  for (const item of criteria) {
    const key = normalized(item.requiredEnvironment);
    const group = groups.get(key) ?? { environment: item.requiredEnvironment?.trim() ?? "", items: [] };
    group.items.push(item); groups.set(key, group);
  }
  const selected = criteria.filter(item => selectedIds.includes(item.id));
  const required = [...new Map<string, string>(selected.filter(item => normalized(item.requiredEnvironment))
    .map(item => [normalized(item.requiredEnvironment), item.requiredEnvironment!.trim()])).values()];
  return <section aria-label="实测环境分组">
    {!!required.length && <>
      <p>所选验收项要求环境：{required.join("；")}</p>
      <button type="button" disabled={disabled || required.length !== 1}
        onClick={() => { if (required.length === 1) onBring(required[0]); }}>带入要求环境</button>
    </>}
    {required.length > 1 && <p role="status">所选条件要求不同环境，请按环境分批提交。下面列出差异，可一键选择同环境条件，无需手抄名称。</p>}
    {groups.size > 1 && <ul>{[...groups.entries()].map(([key, group]) => <li key={key || "unspecified"}>
      <strong>{group.environment || "未指定要求环境"}</strong>
      <ul>{group.items.map(item => <li key={item.id}>{item.text}{selectedIds.includes(item.id) ? "（已选）" : ""}</li>)}</ul>
      <button type="button" disabled={disabled} aria-label={`选择环境组 ${group.environment || "未指定要求环境"}`}
        onClick={() => onSelect(group.items.map(item => item.id), group.environment)}>
        选择此组并带入环境：{group.environment || "自行填写实测环境"}
      </button>
    </li>)}</ul>}
    <p>仅在你确实使用此环境完成验证时带入名称；这不会自动记录实测通过。具体系统和验证过程可填在验证说明中。</p>
  </section>;
}
