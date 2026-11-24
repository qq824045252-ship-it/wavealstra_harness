import { useEffect, useId, useState } from "react";
import type { ModelInfoDto, SubagentConfigDto } from "@shared/agent-ipc";
import { PSTACK_SKILLS, PSTACK_PLAYBOOKS, PSTACK_ROLES, pstackExcludedModels, resolvePstackRole, type PstackSettings } from "@shared/pstack";
import { CheckField, ParameterFields, RoleFields, ThermosFields } from "./PstackSettingsFields";
import { PstackHostSettings, RoleAvailability } from "./PstackHostSettings";
import "./PstackSettings.css";

type Section = "skills" | "playbooks" | "roles" | "thermos";
type Skill = typeof PSTACK_SKILLS[number];
type Playbook = typeof PSTACK_PLAYBOOKS[number];
type Item = { id: string; label: string; description: string };
type GoTo = (section: Section, id?: string) => void;
const sections: Record<Section, string> = { skills: "技能与原则", playbooks: "流程", roles: "模型角色", thermos: "Thermos 审查" };
const kinds = { method: "方法", principle: "原则", review: "审查" } as const;

function pickItem<T extends Item>(items: T[], selection: string): T | undefined {
  return items.find(item => item.id === selection) ?? items[0];
}

function Stages({ stages, go }: { stages: Playbook["stages"]; go: GoTo }) {
  return <>
    <h3>执行阶段</h3>
    <ol className="pstack-stages">{stages.map(stage => <li key={stage.id}>
      <details className="pstack-rules"><summary>{stage.label}</summary>
        <div>{stage.instructions}</div>
        <div className="pstack-related">
          {stage.skillIds.map(id => <button type="button" key={id} onClick={() => go("skills", id)}>
            {PSTACK_SKILLS.find(skill => skill.id === id)?.label ?? id}</button>)}
          {stage.roleId && <button type="button" onClick={() => go("roles", stage.roleId)}>
            {PSTACK_ROLES.find(role => role.id === stage.roleId)?.label ?? stage.roleId}</button>}
        </div>
      </details>
    </li>)}</ol>
  </>;
}

function SkillDetail({ item, config, change, go }: {
  item: Skill; config: PstackSettings["skills"][string]; change: (value: PstackSettings["skills"][string]) => void; go: GoTo;
}) {
  return <>
    <CheckField label={item.kind === "principle" ? "启用此原则" : "启用此技能"}
      checked={config.enabled} onChange={enabled => change({ ...config, enabled })} />
    <ParameterFields definitions={item.parameters} values={config.parameters} onChange={parameters => change({ ...config, parameters })} />
    {item.roleIds.length > 0 && <div className="pstack-related"><span>配套角色</span>
      {item.roleIds.map(id => <button type="button" key={id} onClick={() => go("roles", id)}>
        {PSTACK_ROLES.find(role => role.id === id)?.label ?? id}</button>)}</div>}
    {item.kind === "review" && <button type="button" className="pstack-link" onClick={() => go("thermos")}>编辑 Thermos 条件与条款</button>}
    <details className="pstack-rules" key={item.id} open={item.parameters.length === 0}>
      <summary>{item.kind === "principle" ? "原则内容" : "执行规则"}</summary>
      <div>{item.instructions}</div>
    </details>
    {item.stages?.length ? <Stages stages={item.stages} go={go} /> : null}
  </>;
}

function PlaybookDetail({ item, config, change, go }: {
  item: Playbook; config: PstackSettings["playbooks"][string]; change: (value: PstackSettings["playbooks"][string]) => void; go: GoTo;
}) {
  return <>
    <CheckField label="启用此流程" checked={config.enabled} onChange={enabled => change({ ...config, enabled })} />
    <ParameterFields definitions={item.parameters} values={config.parameters} onChange={parameters => change({ ...config, parameters })} />
    <Stages stages={item.stages} go={go} />
  </>;
}

export default function PstackSettingsEditor({ value, enabled, saving, models, change }: {
  value: PstackSettings; enabled: boolean; saving: boolean; models: ModelInfoDto[];
  change: (settings: PstackSettings, enabled: boolean) => void;
}) {
  const [section, setSection] = useState<Section>("skills");
  const [selection, setSelection] = useState("");
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState("");
  const [host, setHost] = useState<SubagentConfigDto>();
  const [hostError, setHostError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (section !== "roles") return;
    let live = true;
    setHostError("");
    const read = async () => {
      const next = await window.api?.agent?.getSubagentConfig?.();
      if (!next) throw Error("子代理配置接口不可用。");
      if (live) setHost(next);
    };
    void read().catch(error => { if (live) { setHost(undefined); setHostError(String(error)); } });
    return () => { live = false; };
  }, [section, refresh]);
  const id = useId();
  const go: GoTo = (next, selected = "") => {
    setSection(next); setSelection(selected); setFilter(""); setKind("");
  };
  const query = filter.trim().toLowerCase();
  function matches(item: Item, extra: string[] = []) {
    return [item.id, item.label, item.description, ...extra].some(text => text.toLowerCase().includes(query));
  }
  const skills = section === "skills" ? PSTACK_SKILLS.filter(item => (!kind || kind === item.kind) &&
    matches(item, item.parameters.flatMap(p => [p.label, p.id]))) : [];
  const playbooks = section === "playbooks" ? PSTACK_PLAYBOOKS.filter(item =>
    matches(item, [...item.stages.map(stage => stage.label), ...item.parameters.flatMap(p => [p.label, p.id])])) : [];
  const roles = section === "roles" ? PSTACK_ROLES.filter(item => matches(item, [value.roles[item.id].model])) : [];
  const items: Item[] = [...skills, ...playbooks, ...roles];
  const skill = pickItem(skills, selection);
  const book = pickItem(playbooks, selection);
  const role = pickItem(roles, selection);
  const selected = skill ?? book ?? role;
  const effectiveRole = role && resolvePstackRole(value, role.id);
  const excluded = pstackExcludedModels(value);
  const eligible = section === "roles" ? models.filter(m => m.kind !== "image-generation" && m.enabled !== false && m.available !== false &&
    !excluded.has(m.id) && (!host?.allowedModels || host.allowedModels.includes(m.id))) : [];
  const counts = { skills: PSTACK_SKILLS.length, playbooks: PSTACK_PLAYBOOKS.length, roles: PSTACK_ROLES.length };
  const review = PSTACK_SKILLS.find(item => item.kind === "review");

  return <fieldset className="pstack-settings" aria-label="内置工作流设置" disabled={saving}>
    <div className="pstack-top">
      <CheckField label="启用 pstack 工作流" checked={enabled} onChange={checked => change(value, checked)}
        help="作用于所有代码开发任务。启用后，可由 poteto 根据任务目标选择流程。" />
      {review && <CheckField label="启用 Thermos 深度质量评审" checked={value.skills[review.id].enabled}
        onChange={checked => change({ ...value, skills: { ...value.skills, [review.id]: { ...value.skills[review.id], enabled: checked } } }, enabled)}
        help="关闭并保存后，新任务跳过 Thermos，保留 pstack 流程与验证；已有工作流继续使用启动时的设置。" />}
    </div>
    <nav className="pstack-tabs" aria-label="工作流配置分类">
      {(Object.keys(sections) as Section[]).map(key => <button type="button" key={key} aria-label={sections[key]}
        aria-pressed={section === key} onClick={() => go(key)}>{sections[key]}
        {key !== "thermos" && <span>{counts[key]}</span>}</button>)}
    </nav>
    {section === "thermos" ? <>
      <ThermosFields value={value.thermos} onChange={thermos => change({ ...value, thermos }, enabled)} inspectRole={id => go("roles", id)} />
    </> : <>
      <div className="pstack-filter">
        <input type="search" aria-label="搜索当前分类" placeholder={`搜索${sections[section]}…`}
          value={filter} onChange={e => setFilter(e.currentTarget.value)} />
        {section === "skills" && <select aria-label="技能类别" value={kind} onChange={e => setKind(e.currentTarget.value)}>
          <option value="">全部类别</option>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>}
      </div>
      {selected ? <div className="pstack-browser">
        <nav aria-label="配置项目" className="pstack-list">
          {items.map(item => <button type="button" aria-current={item.id === selected.id ? "true" : undefined} title={item.id}
            key={item.id} onClick={() => setSelection(item.id)}>{item.label}</button>)}
        </nav>
        <article className="pstack-detail" key={selected.id} aria-labelledby={id}>
          <header><h3 id={id}>{selected.label}</h3>
            {selected.label !== selected.id && <code>{selected.id}</code>}
            <p>{selected.description}</p>
          </header>
          {skill && <SkillDetail item={skill} config={value.skills[skill.id]} go={go}
            change={config => change({ ...value, skills: { ...value.skills, [skill.id]: config } }, enabled)} />}
          {book && <PlaybookDetail item={book} config={value.playbooks[book.id]} go={go}
            change={config => change({ ...value, playbooks: { ...value.playbooks, [book.id]: config } }, enabled)} />}
          {role && effectiveRole && <>
            <RoleFields id={role.id} models={eligible} role={value.roles[role.id]} policy={host} inheritedEffort={effectiveRole.effort}
              onChange={config => change({ ...value, roles: { ...value.roles, [role.id]: config } }, enabled)} />
            {host && <RoleAvailability id={role.id} role={effectiveRole} config={host} models={eligible} />}
          </>}
        </article>
      </div> : <p className="pstack-empty" role="status">没有匹配的{sections[section]}。</p>}
      {section === "roles" && (host ? <PstackHostSettings config={host} models={models} onSaved={setHost} /> :
        hostError ? <p className="pstack-note" role="alert">{hostError} <button className="btn" type="button" onClick={() => setRefresh(n => n + 1)}>重新读取</button></p> :
          <p className="pstack-note" role="status">正在读取子代理候选模型与并行限制…</p>)}
    </>}
  </fieldset>;
}
