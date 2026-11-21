import { useState } from "react";
import type { ImprovementItem, ImprovementVersionEvidence } from "@shared/native-improvement";
import { improvementOutcomeLabels } from "@shared/improvement-report-format";
import { IconAlert, IconBot, IconCalendar, IconChevronRight, IconCircleCheck, IconFileText, IconGitBranch, IconList, IconPlay, IconRotate, IconSearch, IconTarget } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import { ImprovementChildren } from "./ImprovementChildren";
import { Disclosure, OutcomeDetails, ReviewEmpty, ReviewFacts, SourceExcerpt, VersionDetails, WeeklyMetrics, scopeLabels, shortTime, weekRange } from "./ImprovementEvidence";
import { useImprovementReport } from "./useImprovementReport";
import "./NativeImprovement.css";

const states = { candidate: "待归因", watching: "观察中", disabled: "已停用", changed: "已修订" };
const sections = [
  { id: "findings", label: "改进发现", icon: IconList },
  { id: "versions", label: "发布版本", icon: IconGitBranch },
  { id: "children", label: "子代理交接", icon: IconBot },
  { id: "weeks", label: "历史周报", icon: IconCalendar },
] as const;
type Section = typeof sections[number]["id"];

export default function NativeImprovementTab() {
  const { api, report, error, busy, status, update } = useImprovementReport();
  const tasks = useAppStore(s => s.tasks);
  const projects = useAppStore(s => s.projects);
  const spaces = useAppStore(s => s.spaces);
  const [section, setSection] = useState<Section>("findings");
  const [selectedWeek, setSelectedWeek] = useState("");
  const [filter, setFilter] = useState("");
  const latest = report?.runs[0];
  const week = report?.runs.find(r => r.week === selectedWeek) ?? latest;
  const metrics = report?.weeklyMetrics.find(m => m.week === week?.week);
  const latestMetrics = report?.weeklyMetrics.find(m => m.week === latest?.week);
  const items = report?.items ?? [];
  const versions: ImprovementVersionEvidence[] = report?.versionEvidence ?? report?.packages.map(p => ({
    packageId: p.id, revision: p.revision, active: p.enabled, retired: false, week: p.week, previous: p.previous,
    source: p.source, scope: p.scope, assets: p.assets, hash: p.hash, cases: [], uses: [], useCount: 0,
  })) ?? [];
  const counts = {findings:items.length, versions:versions.length, children:report?.children.length ?? 0, weeks:report?.runs.length ?? 0};
  function scopeName(label: string) {
    const [kind, ...parts] = label.split(" ");
    const id = parts.join(" ");
    const title = kind === "任务" ? tasks.find(t => t.id === id)?.title
      : kind === "项目" ? projects.find(p => p.id === id)?.name : kind === "工作空间" ? spaces.find(s => s.id === id)?.name : undefined;
    return title ? kind + " · " + title : label;
  }
  const nameFor = (key: string) => items.find(i => i.key === key)?.title ?? "交付检查";
  const visibleItems = items.filter(i => [i.title,scopeName(i.scope),states[i.state]].join(" ").toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));

  function finding(item: ImprovementItem) {
    const Icon = item.state === "watching" ? IconCircleCheck : item.state === "candidate" ? IconSearch : IconFileText;
    const outcome = report?.outcomes.find(o => o.packageId === item.key && o.revision === item.revision);
    const verdict = item.state === "watching" && outcome?.state;
    const tone = verdict === "regressed" || verdict === "ineffective" ? "is-alert" : verdict === "effective" ? "is-good"
      : item.state === "candidate" || verdict === "pending" ? "is-pending" : "";
    return <details className="review-record" key={item.key} data-finding={item.key}>
      <summary><span className="review-glyph"><Icon size={18}/></span><span className="review-record-name"><strong>{item.title}</strong>
        <small>{scopeName(item.scope)} · {item.count} 次观察{item.revision && " · v" + item.revision}</small></span>
        <span className={"review-status " + tone}>{verdict ? improvementOutcomeLabels[verdict] : states[item.state]}</span><IconChevronRight size={15}/></summary>
      <div className="review-record-body">
        <ReviewFacts rows={[["发现原因",item.cause],["应用改进",item.change],["验证方法",item.proof]]}/>
        {item.assessment && <Disclosure title="归因分析" meta={item.assessment.route}><ReviewFacts rows={[
          ["现象",item.assessment.finding],["原因",item.assessment.reason],["改动",item.assessment.change],
          ["复验条件",item.assessment.acceptance],["依据",item.assessment.source.taskId + " / " + item.assessment.source.conversationId + " · #" + item.assessment.evidence.join("、#")],
        ]}/></Disclosure>}
        {item.pendingReason && <p>待核实 · {item.pendingReason}</p>}
        {item.pathHint && <p>{item.pathHint} · 提供路径 {item.triggers} 次 · 后续实际读取 {item.repaired} 轮</p>}
        {item.hookId && <p>检查触发 {item.triggers} 次 · 补回读 {item.repaired} 轮 · 复发 {item.recurrences} 次 · 异常 {item.errors} 次</p>}
        {item.state === "watching" && !item.repaired && (!verdict || verdict === "pending") && <p className="review-meta">后续改善尚待验证。</p>}
        <Disclosure title="原始来源" meta={item.sources.length + " 条"}>
          {item.sources.map(s => <SourceExcerpt key={[s.taskId,s.conversationId,s.entry].join("/")} source={s} itemKey={item.key} api={api!}/>)}
        </Disclosure>
        {item.state === "watching" && item.generation !== undefined && <button className="review-link review-stop" disabled={busy}
          onClick={() => void update(() => api!.disable(item.key,item.generation!))}>停用这项改进</button>}
      </div>
    </details>;
  }
  if (!api) return <ReviewEmpty>自我改进服务尚未就绪。</ReviewEmpty>;
  return <div className="weekly-review">
    <header className="review-header"><div><div className="review-period"><IconCalendar size={15}/>{latest ? latest.week.slice(0,4) + " 年 · " + weekRange(latest.week) : "每周运行"}</div>
      <h2>每周复盘</h2><p>{latest ? "最近运行于 " + shortTime(latest.at) : report ? "运行首次复盘，查看主会话和子代理中的改进机会。" : "正在读取复盘记录…"}</p></div>
      <button className="review-primary" disabled={busy || Boolean(status) || !report && !error} onClick={() => void update(api.review)}>
        {status ? <IconRotate size={15}/> : <IconPlay size={15}/>} {status ? "处理中…" : "立即复盘"}
      </button></header>
    {status && <div className="review-notice" role="status"><IconRotate size={15}/>{status}</div>}
    {error && <div className="review-notice" role="alert"><IconAlert size={15}/>{error}</div>}
    {report && <><div className="review-stats">
      <div><span><IconSearch size={15}/>本期新线索</span><strong>{latest?.added.toLocaleString() ?? "—"}</strong><small>{latest ? "已检查 " + latest.scanned.toLocaleString() + " 条记录" : "等待首次复盘"}</small></div>
      <div><span><IconGitBranch size={15}/>本期发布</span><strong>{latest?.published.toLocaleString() ?? "—"}</strong><small>每周最多 5 项</small></div>
      <div><span><IconTarget size={15}/>独立验收通过</span><strong>{latestMetrics?.opportunities ? <>{latestMetrics.unassisted.toLocaleString()} <em>/ {latestMetrics.opportunities.toLocaleString()}</em></> : "—"}</strong><small>{latestMetrics?.opportunities ? "无需纠正 / 适用任务" : latestMetrics ? "暂无适用任务" : "暂无指标"}</small></div>
    </div>
    <nav className="review-nav" aria-label="复盘视图">{sections.map(s => <button key={s.id} aria-label={s.label} aria-pressed={section === s.id}
      onClick={() => setSection(s.id)}><s.icon size={15}/>{s.label}<small>{counts[s.id]}</small></button>)}</nav>
    <section className="review-content" aria-label={sections.find(s => s.id === section)?.label}>
      {section === "findings" && <><div className="review-tools"><h3>全部发现</h3>{items.length > 0 && <label className="review-search"><IconSearch size={14}/>
        <input aria-label="搜索改进发现" placeholder="搜索名称或作用范围" value={filter} onChange={e => setFilter(e.target.value)}/></label>}</div>
        {visibleItems.length ? <div className="review-list">{visibleItems.map(finding)}</div> : <ReviewEmpty>{filter ? "没有匹配的改进。" : "尚未发现有原始记录支持的改进机会。"}</ReviewEmpty>}</>}
      {section === "versions" && <><div className="review-tools"><h3>版本记录</h3></div>{versions.length ? <div className="review-list">{versions.map(v => {
        const current = report.packages.find(p => p.id === v.packageId && p.revision === v.revision);
        return <VersionDetails key={v.packageId + "/" + v.revision} version={v} name={nameFor(v.packageId)} disabled={Boolean(current && !current.enabled)}
          scope={v.scope ? scopeName(scopeLabels[v.scope.kind] + " " + v.scope.id) : "已发布改进"} api={api}
          outcomes={report.outcomes.filter(o => o.packageId === v.packageId && o.revision === v.revision)}/>;
      })}</div> : <ReviewEmpty>通过回放验证的版本会出现在这里。</ReviewEmpty>}</>}
      {section === "children" && <ImprovementChildren api={api}>{report.children}</ImprovementChildren>}
      {section === "weeks" && (week ? <><div className="review-tools"><h3>周期指标</h3><select aria-label="选择复盘周期" value={week.week} onChange={e => setSelectedWeek(e.target.value)}>
        {report.runs.map(r => <option key={r.week} value={r.week}>{r.week.slice(0,4)} 年 · {weekRange(r.week)}</option>)}</select></div>
        <p className="review-meta">最近检查于 {shortTime(week.at)} · 读取 {week.scanned} 条 · 新线索 {week.added} 条 · 发布 {week.published} 项</p>
        {metrics ? <WeeklyMetrics metrics={metrics}/> : <p>此周期未保存指标。</p>}
        {week.issues.map((issue,i) => <p key={i} className="review-notice"><IconAlert size={15}/>{issue}</p>)}
        {report.outcomes.filter(o => o.week === week.week).map(o => <OutcomeDetails key={o.packageId + "/" + o.revision} outcome={o} name={nameFor(o.packageId)}/>)}
        {!!week.followup.length && <Disclosure title="之前改进的回填" meta={week.followup.length + " 项"}>{week.followup.map((m,i) =>
          <p key={i}><strong>{m.title}</strong> · {scopeName(m.scope)} · 累计触发 {m.triggers} 次，补回读 {m.repaired} 轮，异常 {m.errors} 次</p>)}</Disclosure>}
      </> : <ReviewEmpty>首次运行后可以在这里查看周期指标。</ReviewEmpty>)}
    </section></>}
  </div>;
}
