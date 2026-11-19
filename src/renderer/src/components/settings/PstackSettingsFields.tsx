import { useId, type ReactNode } from "react";
import type { ModelInfoDto, SubagentConfigDto } from "@shared/agent-ipc";
import {
  PSTACK_EFFORTS, PSTACK_ROLES, PSTACK_ROLE_COUNT_MAX, pstackRoleMinimumCount, THERMOS_CRITERIA, THERMOS_PARAMETERS, THERMOS_REVIEWER_ROLES,
  type PstackParameter, type PstackSettings,
} from "@shared/pstack";

type ParameterValues = PstackSettings["skills"][string]["parameters"];
type Role = PstackSettings["roles"][string];
type Thermos = PstackSettings["thermos"];

export function CheckField({ label, checked, onChange, help }: {
  label: string; checked: boolean; onChange: (value: boolean) => void; help?: string;
}) {
  return <label className="pstack-check">
    <input type="checkbox" aria-label={label} checked={checked} onChange={e => onChange(e.currentTarget.checked)} />
    <span>{label}{help && <small>{help}</small>}</span>
  </label>;
}

export function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return <label className="pstack-field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}

export function NumberInput({ label, value, min, max, set }: {
  label: string; value: number; min?: number; max?: number; set: (value: number) => void;
}) {
  return <input type="number" aria-label={label} required min={min} max={max} step={1}
    value={Number.isFinite(value) ? value : ""} onChange={e => set(e.currentTarget.valueAsNumber)} />;
}

export function ParameterFields({ definitions, values, onChange }: {
  definitions: readonly PstackParameter[]; values: ParameterValues; onChange: (next: ParameterValues) => void;
}) {
  return <>{definitions.map(p => {
    const set = (value: ParameterValues[string]) => onChange({ ...values, [p.id]: value });
    const value = values[p.id];
    if (p.type === "boolean") return <CheckField key={p.id} label={p.label} checked={value === true} onChange={set} help={p.description} />;
    return <Field key={p.id} label={p.label} help={p.description}>
      {p.type === "number" ? <NumberInput label={p.label} min={p.min} max={p.max} value={Number(value)} set={set} /> :
        p.type === "select" ? <select aria-label={p.label} value={String(value)} onChange={e => set(e.currentTarget.value)}>
          {p.options?.map(option => <option key={option}>{option}</option>)}
        </select> :
        p.multiline ? <textarea rows={4} aria-label={p.label} value={String(value ?? "")} onChange={e => set(e.currentTarget.value)} /> :
          <input aria-label={p.label} type="text" value={String(value ?? "")} onChange={e => set(e.currentTarget.value)} />}
    </Field>;
  })}</>;
}

export function RoleFields({ id, role, models, policy, inheritedEffort, onChange }: {
  id: string; role: Role; models: ModelInfoDto[]; policy?: SubagentConfigDto; inheritedEffort: string; onChange: (value: Role) => void;
}) {
  const listId = useId();
  const judge = id === "arena-cross-judge", countLabel = judge ? "裁判候选池大小" : "代理数量";
  const options = new Set(["default", "inherit-parent", "fast", "strong", "diverse", ...Object.keys(policy?.roles ?? {}), ...models.map(m => m.id)]);
  return <>
    <Field label="模型选择" help="选择模型策略、子代理角色，或填写完整的 provider/model。">
      <input aria-label="模型选择" type="text" required list={listId} value={role.model}
        onChange={e => onChange({ ...role, model: e.currentTarget.value })} />
    </Field>
    <datalist id={listId}>{Array.from(options, option => <option key={option} value={option} />)}</datalist>
    <Field label={countLabel} help={judge ? "按已配置顺序取最多此数量的合格候选，实际派一名匿名裁判。受控评估要求裁判与全部作者的模型家族不同，普通 Arena 优先选与主模型不同的家族。" : undefined}>
      <NumberInput label={countLabel} value={role.count} min={pstackRoleMinimumCount(id, role.model)} max={PSTACK_ROLE_COUNT_MAX} set={count => onChange({ ...role, count })} />
    </Field>
    <Field label="推理预算">
      <select aria-label="推理预算" value={role.effort} onChange={e => onChange({ ...role, effort: e.currentTarget.value as Role["effort"] })}>
        {PSTACK_EFFORTS.map(effort => <option key={effort} value={effort}>{effort === "default" ? `跟随流程预算${role.effort === "default" && inheritedEffort !== "default" ? " · " + inheritedEffort : ""}` : effort}</option>)}
      </select>
    </Field>
    {judge ? <Field label="工作目录隔离"><output aria-label="工作目录隔离">只读独立文档空间（宿主固定）</output></Field> :
    <Field label="工作目录隔离" help={id === "arena-runners" ? "普通 Arena 使用此设置，受控评估始终给每位作者分配独立文档空间。" :
      "独立 Git 工作树需要干净的本地 Git 仓库。流程查询远端工单或拉取请求时才需要托管方权限；GitHub 使用 gh，Cursor Origin 使用 origin。"}>
      <select aria-label="工作目录隔离" value={role.isolation} onChange={e => onChange({ ...role, isolation: e.currentTarget.value as Role["isolation"] })}>
        <option value="auto">按任务选择</option><option value="shared">共享工作目录</option><option value="worktree">独立 Git 工作树</option>
      </select>
    </Field>}
  </>;
}

export function ThermosFields({ value, onChange, inspectRole }: {
  value: Thermos; onChange: (value: Thermos) => void; inspectRole: (id: string) => void;
}) {
  const { criteria, reviewerRole, ...controls } = value;
  return <div className="pstack-detail">
    <h3>触发审查的条件</h3>
    <ParameterFields definitions={THERMOS_PARAMETERS} values={controls} onChange={next => onChange({ ...value, ...next })} />
    <Field label="审查角色">
      <select aria-label="审查角色" value={reviewerRole} onChange={e => onChange({ ...value, reviewerRole: e.currentTarget.value })}>
        {THERMOS_REVIEWER_ROLES.map(id => <option value={id} key={id}>{PSTACK_ROLES.find(role => role.id === id)?.label ?? id}</option>)}
      </select>
    </Field>
    <button type="button" className="pstack-link" onClick={() => inspectRole(reviewerRole)}>查看审查角色的模型与人数</button>
    <h3>审查条款</h3>
    {THERMOS_CRITERIA.map(item => <CheckField key={item.id} label={item.label} help={item.description}
      checked={criteria[item.id]} onChange={checked => onChange({ ...value, criteria: { ...criteria, [item.id]: checked } })} />)}
  </div>;
}
