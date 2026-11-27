import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HookDraft } from "../../../shared/native-hooks";
import type { ImprovementAssetKind, ImprovementOutcome, ImprovementPackage, ImprovementScope, ImprovementVersionEvidence, ImprovementWeeklyMetrics, ObservationSource } from "../../../shared/native-improvement";
import { parseDeliveryContract, verifyDeliveryContract, type DeliveryContract } from "./DeliveryContract";
import { deliveryTool, executeDeliveryTool } from "./DeliveryTool";
import { canonicalImprovementJson, fingerprint } from "./ImprovementDecisions";
import type { ImprovementKnowledge, ImprovementKnowledgeTask, PreparedImprovementKnowledge } from "./ImprovementKnowledge";
import type { NativeHookStore } from "./NativeHookStore";
import type { NativePersistenceReply, RuntimeAuditReader } from "../../platform/runtime-audit";

export interface ReleaseDraft {
  id:string; week:string; scope:ImprovementScope; source:ObservationSource; contract:DeliveryContract;
  knowledge:PreparedImprovementKnowledge[]; convention:string; tool:typeof deliveryTool; hook:HookDraft;
}
export interface ImprovementUse {
  task:string; conversation:string; actor:"main"|"subagent"; run:string; kind:ImprovementAssetKind;
  event:string; generation?:number|string; detail?:string; at?:number;
}
type Replay = {name:string;expected:unknown;observed:unknown;passed:boolean};
type VersionRow = { id: string; revision: number; generation: number; enabled: boolean; previous: number | null; hash: string; draft: string };
type StoredUse = ImprovementUse & { id: string; revision: number };
type Run = Pick<ImprovementUse, "task" | "conversation" | "run">;
type ReportVersion = Pick<VersionRow, "id" | "revision" | "previous" | "hash" | "draft"> & {
  active: boolean; retired: number; replays: string; useCount: number; uses: string;
};
type IndexedInput = { entry: number; at: number; eligible: boolean; project?: string; workspace?: string };

export type ImprovementPackageQuery =
  | { kind: "current" | "regressionInputs"; id: string }
  | { kind: "version" | "uses"; id: string; revision: number }
  | { kind: "select"; task: string; project?: string | null; workspace?: string | null }
  | { kind: "rollbackCandidates"; id: string; beforeRevision: number }
  | { kind: "pendingAcceptance"; task: string }
  | { kind: "sourceUses"; run: Run }
  | { kind: "staged"; hash: string }
  | { kind: "replays"; week: string }
  | { kind: "list" | "report" }
  | { kind: "metrics"; start: number; end: number }
  | { kind: "dirtyWeeks"; through: string };

export type ImprovementPackageMutation =
  | { kind: "stage"; id: string; hash: string; draft: string; replays: string; regressionSeq: number }
  | { kind: "activate"; id: string; hash: string; generation: number; at: number }
  | { kind: "disable"; id: string; generation: number; at: number }
  | { kind: "revert"; id: string; generation: number; fallback: number[]; at: number }
  | { kind: "record"; id: string; revision: number; usage: ImprovementUse & { generation: string; detail: string; at: number };
      regression?: { hash: string; input: string }; fallback: number[]; decisionAt: number }
  | { kind: "correction"; run: Run; actor: ImprovementUse["actor"]; generation: string; at: number }
  | { kind: "indexInputs"; task: string; conversation: string; actor: ImprovementUse["actor"]; inputs: IndexedInput[] }
  | { kind: "followup"; week: string; start: number; end: number; now: number }
  | { kind: "acknowledgeWeek"; week: string; tokens: number[] };

const weekMs = 7 * 86400000;
const reminder = "交付检查还缺少：";
const unknown = "交付检查无法核实本轮产物。请检查文件和本轮生成凭据。";
function assets(d:ReleaseDraft): ImprovementPackage["assets"] {
  return [{kind:"hook",hash:fingerprint(d.hook)}, {kind:"tool",hash:fingerprint(d.tool)}, {kind:"convention",hash:fingerprint(d.convention)},
    ...d.knowledge.map(a=>({kind:a.kind,hash:a.version}))];
}
function decode(row:VersionRow) {
  const draft = JSON.parse(row.draft) as ReleaseDraft;
  if (fingerprint(draft)!==row.hash) throw new Error("改进版本校验失败");
  const release:ImprovementPackage = {id:row.id,revision:row.revision,generation:row.generation,enabled:Boolean(row.enabled),
    previous:row.previous,hash:row.hash,week:draft.week,scope:draft.scope,source:draft.source,assets:assets(draft)};
  return {draft,release};
}
function sourceTask(d:ReleaseDraft): ImprovementKnowledgeTask {
  return {taskId:d.source.taskId, projectId:d.scope.kind==="project"?d.scope.id:undefined,
    workspaceId:d.scope.kind==="workspace"?d.scope.id:undefined,canUseSkill:()=>true};
}
export class ImprovementPackages {
  constructor(private readonly core: Pick<RuntimeAuditReader, "readImprovementPackages" | "writeImprovementPackages"> | undefined,
    private readonly hooks: NativeHookStore, private readonly now: () => number,
    readonly knowledge:()=>ImprovementKnowledge|undefined,
    private readonly original:(d:ReleaseDraft,directory:string)=>Promise<Awaited<ReturnType<typeof verifyDeliveryContract>> & {expectedEvidence:Record<string,string>}>) {
  }

  private data<T>(reply: NativePersistenceReply<T> | undefined): T {
    if (!reply) throw new Error("Core 改进版本账本不可用");
    if (reply.status === "rejected") throw new Error(reply.message);
    return reply.data;
  }

  private async read<T>(query: ImprovementPackageQuery): Promise<T> {
    return this.data(await this.core?.readImprovementPackages<T>(query));
  }

  private async write<T>(mutation: ImprovementPackageMutation): Promise<T> {
    return this.data(await this.core?.writeImprovementPackages<T>(mutation));
  }
  async createDraft(id:string,scope:ImprovementScope,source:ObservationSource,contract:DeliveryContract,week:string):Promise<ReleaseDraft> {
    const knowledge = this.knowledge();
    if (!knowledge) throw new Error("缺少本机记忆服务");
    return {id,scope,source,contract,week,knowledge:await knowledge.prepareDelivery(scope,source),tool:structuredClone(deliveryTool),
      convention:"本轮用户明确要求 Markdown 章节或附件时，按本轮要求检查实际文件。用户调整或取消交付要求时随之更新。",
      hook:{title:"结束前核对明确的交付要求",event:"beforeFinish",actor:"all",tool:"",scope,
        script:'return event.status === "passed" ? true : event.status === "missing" ? '+JSON.stringify(reminder)+' + event.missing.join("、") : '+JSON.stringify(unknown)+';',
        cases:[{input:{status:"passed",missing:[]},expected:true},{input:{status:"missing",missing:["附件"]},expected:reminder+"附件"},
          {input:{status:"unknown",missing:[]},expected:unknown}]}};
  }
  private async validate(d:ReleaseDraft, past: readonly string[]):Promise<Replay[]> {
    const knowledge = this.knowledge(), t = sourceTask(d);
    if (!knowledge || !d.id || fingerprint(d.tool)!==fingerprint(deliveryTool) || !d.convention.trim() || d.convention.length>2000 ||
      d.hook.event!=="beforeFinish" || d.hook.actor!=="all" || d.hook.tool || fingerprint(d.hook.scope)!==fingerprint(d.scope) ||
      d.knowledge.length!==2 || new Set(d.knowledge.map(a=>a.kind)).size!==2 ||
      !d.knowledge.some(a=>a.kind==="skill") || !d.knowledge.some(a=>a.kind==="memory") ||
      d.knowledge.some(a=>fingerprint(a.scope)!==fingerprint(d.scope)) ||
      !(await Promise.all(d.knowledge.map(a=>knowledge.resolve(a,t)))).every(Boolean)) throw new Error("五项资产或依赖的来源不完整");
    if (d.hook.script.length>16000 || d.hook.cases.length>12) throw new Error("检查脚本超过范围");
    const cases:Replay[]=[];
    // The oracle lives in the host. A candidate cannot choose its acceptance cases.
    const observe=(name:string,expected:unknown,observed:unknown) => {
      const passed=fingerprint(expected)===fingerprint(observed);
      cases.push({name,expected,observed,passed});
      if (!passed) throw new Error("独立回放未通过："+name);
    };
    const controls=[...d.hook.cases,{input:{status:"unknown",missing:[]},expected:unknown}];
    for (const test of controls) observe("检查脚本",test.expected,await this.hooks.check(d.hook,test.input));
    for(const raw of past){
      const input=JSON.parse(raw) as Awaited<ReturnType<typeof verifyDeliveryContract>>;
      const expected=input.status==="passed"?true:input.status==="missing"?reminder+input.missing.join("、"):unknown;
      observe("已撤回版本的失败输入",expected,await this.hooks.check(d.hook,input));
    }
    const root=await mkdtemp(join(tmpdir(),"mybuddy-delivery-"));
    try {
      for (const [i,c] of [d.contract,{document:"variant.md",headings:["Results"],attachments:["support.csv"]}].entries()) {
        if (!/\.md$/i.test(c.document) || !c.headings.length&&!c.attachments.length || c.headings.length+c.attachments.length>50 ||
          [c.document,...c.attachments].some(p=>!p || p.length>220 || p.split(/[\\/]/).some(s=>!s || s==="." || s==="..") || /[:\0]/.test(p))) throw new Error("超出本地交付契约的验证范围");
        const cwd=join(root,String(i)); await mkdir(cwd);
        if(i===0) {
          const history=join(root,"historical");await mkdir(history);
          const actual=await this.original(d,history);
          observe("原始保存版本与用户指出的缺项",reminder+actual.missing.join("、"),await this.hooks.check(d.hook,actual));
          observe("原始交付物指纹",actual.expectedEvidence,actual.evidence);
        }
        const write=async (file:string,value:string)=>{const path=join(cwd,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,value);};
        await write(c.document,"# Draft\n");
        const bad=await executeDeliveryTool(d.tool,cwd,c);
        const missing=[...c.headings.map(h=>h==="\0citations"?"引用来源":"标题: "+h),...c.attachments];
        observe(i?"变体漏项":"原契约漏项",missing,bad.missing);
        observe("反馈具体缺项",reminder+missing.join("、"),await this.hooks.check(d.hook,bad));
        await write(c.document,c.headings.map(h=>h==="\0citations"?"[证据](https://example.org/source)":"## "+h).join("\n")+"\n");
        for (const p of c.attachments) await write(p,"sample\n");
        const fixed=await executeDeliveryTool(d.tool,cwd,c);
        observe("修复后独立读回","passed",fixed.status);
        observe("完整交付放行",true,await this.hooks.check(d.hook,fixed));
      }
      observe("无关请求不触发",false,Boolean(parseDeliveryContract("请解释这份文档的含义。")));
      observe("用户取消要求不触发",false,Boolean(parseDeliveryContract("不要生成 report.md 或提供附件。")));
      return cases;
    } finally {await rm(root,{recursive:true,force:true});}
  }
  async stage(input: ReleaseDraft): Promise<string> {
    const draft = structuredClone(input);
    const { seq, inputs } = await this.read<{ seq: number; inputs: string[] }>({ kind: "regressionInputs", id: draft.id });
    const replays = await this.validate(draft, inputs);
    return this.write({
      kind: "stage", id: draft.id, hash: fingerprint(draft),
      draft: canonicalImprovementJson(draft), replays: JSON.stringify(replays), regressionSeq: seq,
    });
  }

  async activate(hash: string, expectedGeneration: number): Promise<ImprovementPackage> {
    const raw = await this.read<string | null>({ kind: "staged", hash });
    if (raw === null) throw new Error("没有已验证的暂存版本");
    const draft = JSON.parse(raw) as ReleaseDraft;
    const knowledge = this.knowledge();
    if (fingerprint(draft) !== hash || !knowledge || !draft.knowledge.every(asset => knowledge.isCurrent(asset, sourceTask(draft)))) {
      throw new Error("发布依赖已改变");
    }
    const row = await this.write<VersionRow>({ kind: "activate", id: draft.id, hash, generation: expectedGeneration, at: this.now() });
    return decode(row).release;
  }

  async publish(draft: ReleaseDraft, expectedGeneration: number): Promise<ImprovementPackage> {
    return this.activate(await this.stage(draft), expectedGeneration);
  }

  async current(id: string) {
    const row = await this.read<VersionRow | null>({ kind: "current", id });
    return row ? decode(row) : undefined;
  }

  async draft(id: string) {
    return (await this.current(id))?.draft;
  }

  async version(id: string, revision: number) {
    const row = await this.read<VersionRow | null>({ kind: "version", id, revision });
    return row ? decode(row) : undefined;
  }

  async list(): Promise<ImprovementPackage[]> {
    return (await this.read<VersionRow[]>({ kind: "list" })).map(row => decode(row).release);
  }

  async select(task: { taskId: string; projectId?: string | null; workspaceId?: string | null }) {
    const row = await this.read<VersionRow | null>({
      kind: "select", task: task.taskId, project: task.projectId, workspace: task.workspaceId,
    });
    return row ? decode(row) : undefined;
  }

  private async rollbackCandidates(id: string, revision: number): Promise<number[]> {
    const candidates = await this.read<VersionRow[]>({ kind: "rollbackCandidates", id, beforeRevision: revision });
    const knowledge = this.knowledge();
    if (!knowledge) return [];
    return candidates.flatMap(row => {
      const { draft } = decode(row);
      return draft.knowledge.every(asset => knowledge.isCurrent(asset, sourceTask(draft))) ? [row.revision] : [];
    });
  }

  async revert(id: string, generation: number): Promise<ImprovementPackage> {
    const current = (await this.current(id))?.release;
    if (!current?.enabled || current.generation !== generation) throw new Error("基础版本已变化，请刷新");
    const fallback = await this.rollbackCandidates(id, current.revision);
    return decode(await this.write<VersionRow>({ kind: "revert", id, generation, fallback, at: this.now() })).release;
  }

  async disable(id: string, generation: number): Promise<void> {
    await this.write({ kind: "disable", id, generation, at: this.now() });
  }

  async regression(id: string, revision: number, input: Awaited<ReturnType<typeof verifyDeliveryContract>>, usage: ImprovementUse): Promise<void> {
    await this.record(id, revision, usage, { hash: fingerprint(input), input: canonicalImprovementJson(input) });
  }

  async runHook(draft: ReleaseDraft, fields: Record<string, unknown>) {
    const result = await this.hooks.check(draft.hook, fields);
    return result === true ? "" : result;
  }

  async record(id: string, revision: number, use: ImprovementUse, regression?: { hash: string; input: string }): Promise<void> {
    const fallback = use.event === "error" || use.event === "falseTrigger" ? await this.rollbackCandidates(id, revision) : [];
    await this.write({
      kind: "record", id, revision, fallback, regression, decisionAt: this.now(),
      usage: { ...use, run: String(use.run), generation: String(use.generation ?? ""), detail: use.detail?.slice(0, 1500) ?? "",
        at: use.at ?? this.now() },
    });
  }

  uses(id: string, revision: number): Promise<StoredUse[]> {
    return this.read({ kind: "uses", id, revision });
  }

  pendingAcceptance(task: string): Promise<StoredUse[]> {
    return this.read({ kind: "pendingAcceptance", task });
  }

  async correction(source: ObservationSource): Promise<void> {
    await this.write({
      kind: "correction", run: { task: source.taskId, conversation: source.conversationId, run: String(source.input) },
      actor: source.actor, at: source.at, generation: String(source.entry),
    });
  }

  sourceUses(source: ObservationSource): Promise<Pick<StoredUse, "id" | "revision" | "kind" | "event" | "generation">[]> {
    return this.read({ kind: "sourceUses", run: { task: source.taskId, conversation: source.conversationId, run: String(source.input) } });
  }

  async indexInputs(task: string, conversation: string, actor: ImprovementUse["actor"], inputs: IndexedInput[]): Promise<void> {
    await this.write({ kind: "indexInputs", task, conversation, actor, inputs });
  }

  async replays(week: string) {
    const rows = await this.read<{ id: string; revision: number; hash: string; draft: string; replays: string }[]>({ kind: "replays", week });
    return rows.map(row => ({ packageId: row.id, revision: row.revision, hash: row.hash,
      source: (JSON.parse(row.draft) as ReleaseDraft).source, cases: JSON.parse(row.replays) as Replay[] }));
  }

  async report(): Promise<{ packages: ImprovementPackage[]; versions: ImprovementVersionEvidence[]; outcomes: ImprovementOutcome[] }> {
    const rows = await this.read<{ packages: VersionRow[]; versions: ReportVersion[]; outcomes: { result: string }[] }>({ kind: "report" });
    const versions = rows.versions.map(row => {
      const draft = JSON.parse(row.draft) as ReleaseDraft;
      return { packageId: row.id, revision: row.revision, previous: row.previous, active: row.active, retired: Boolean(row.retired),
        week: draft.week, source: draft.source, hash: row.hash, scope: draft.scope, assets: assets(draft),
        cases: (JSON.parse(row.replays) as Replay[]).map(({ name, passed }) => ({ name, passed })),
        useCount: row.useCount, uses: JSON.parse(row.uses) as ImprovementVersionEvidence["uses"] };
    });
    return { packages: rows.packages.map(row => decode(row).release), versions,
      outcomes: rows.outcomes.map(row => JSON.parse(row.result) as ImprovementOutcome) };
  }

  followup(week: string, now = this.now()): Promise<number[]> {
    const end = Date.parse(week + "T00:00:00Z");
    return this.write({ kind: "followup", week, start: end - weekMs, end, now });
  }

  async dirtyWeeks(through: string): Promise<string[]> {
    return (await this.read<{ week: string }[]>({ kind: "dirtyWeeks", through })).map(row => row.week);
  }

  async acknowledgeWeek(week: string, tokens: number[]): Promise<void> {
    if (tokens.length) await this.write({ kind: "acknowledgeWeek", week, tokens });
  }

  async metrics(week: string): Promise<ImprovementWeeklyMetrics & { eligibleInputs: number }> {
    const start = Date.parse(week + "T00:00:00Z");
    const { rows, executions, inputs, eligibleInputs } = await this.read<{
      rows: { accepted: boolean; corrected: boolean; error: boolean; falseTrigger: boolean; used: boolean; checked: boolean }[];
      executions: number; inputs: number; eligibleInputs: number;
    }>({ kind: "metrics", start, end: start + weekMs });
    return { week, opportunities: rows.length, accepted: rows.filter(r => r.accepted).length, corrections: rows.filter(r => r.corrected).length,
      unassisted: rows.filter(r => r.accepted && !r.corrected && !r.error).length, recurrences: rows.filter(r => r.corrected).length,
      exposed: rows.length, used: rows.filter(r => r.used).length, errors: rows.filter(r => r.error).length,
      falseTriggers: rows.some(r => r.checked || r.falseTrigger) ? rows.filter(r => r.falseTrigger).length : null,
      durationMs: 0, modelRequests: 0, toolCalls: executions, userInputs: inputs, eligibleInputs };
  }
}
