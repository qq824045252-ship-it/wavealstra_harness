import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppDatabase } from "../../db/AppDatabase";
import type { HookDraft } from "../../../shared/native-hooks";
import type { ChildReviewEvidence, ImprovementChild, ImprovementItem, ImprovementReport, ObservationSource } from "../../../shared/native-improvement";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openDurablePassiveStorage } from "../durable/DurableStorage";
import { readImprovementChild } from "./ImprovementChildHistory";
import { cards, fingerprint, improvementDraft } from "./ImprovementDecisions";
import { freshHistory, scanImprovementHistory } from "./ImprovementHistory";
import type { HistoryState, Observation } from "./ImprovementHistory";
import type { NativeHookStore } from "./NativeHookStore";
import { parseReflection, reflectionEvidence, type Reviewer } from "./ImprovementReflection";
import { ReadRecoveryHints, type ReadMapping } from "./ReadRecoveryHints";
import { ImprovementPackages } from "./ImprovementPackages";
import type { ImprovementKnowledge } from "./ImprovementKnowledge";
import type { DeliveryContract } from "./DeliveryContract";
import { writeImprovementWeek } from "./ImprovementWeeklyReport";
import { settleImprovementUses } from "./ImprovementAcceptance";
import { replayOriginalDelivery, UnverifiedOriginalDelivery } from "./ImprovementOriginalReplay";
import { improvementSourceContext } from "./ImprovementSourceContext";
import { rankImprovementCandidate } from "./ImprovementDecisions";

import { ImprovementReviewStore, type ImprovementGroup, type ManagedImprovement, type ReviewSnapshot } from "./ImprovementReviewStore";

type IndexedChild = { directory: string; conversation: number; childId: string; immutable: boolean };
type ReviewSample = { source: string; replay: string; task: string };
const day = 86400000;
function weekOf(time: number): string {
  const date = new Date(time);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - ((date.getUTCDay() + 6) % 7) * day).toISOString().slice(0, 10);
}
function scoped(source: Observation, task: { projectId?: string | null; spaceId?: string | null }): HookDraft["scope"] {
  if (source.project && source.project === task.projectId) return { kind: "project", id: source.project };
  if (!task.projectId && source.workspace && source.workspace === task.spaceId) return { kind: "workspace", id: source.workspace };
  return { kind: "task", id: source.source.taskId };
}

export class NativeImprovementService {
  private readonly ledger: ImprovementReviewStore;
  readonly readHints: ReadRecoveryHints;
  readonly packages: ImprovementPackages;
  private readonly output:string;
  private progress = {phase:"idle",done:0,total:0};
  private flight?: Promise<boolean>;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly abort = new AbortController();
  constructor(private readonly app: AppDatabase, private readonly hooks: NativeHookStore, profileDirectory: string, private readonly now = Date.now, private readonly reviewer?: Reviewer,
    readonly knowledge:()=>ImprovementKnowledge|undefined = ()=>undefined, private readonly flushDiagnostics?: () => Promise<void>) {
    this.ledger = new ImprovementReviewStore(app.runtimeAuditReader);
    this.readHints = new ReadRecoveryHints(this.app.runtimeAuditReader);
    this.packages = new ImprovementPackages(app.runtimeAuditReader, hooks, now, knowledge, async (draft, target) => {
      const source = await this.ledger.binding(draft.source.taskId);
      if (!source) throw new UnverifiedOriginalDelivery("原始任务绑定已不可用");
      return replayOriginalDelivery(source.directory, draft, target);
    });
    this.output=join(profileDirectory,"improvement");
  }
  start() {
    if (this.timer || this.stopping) return;
    const due = () => {
      if (!this.timer || this.stopping || this.flight) return;
      void this.run(true).catch(e => console.warn("[NativeImprovement]", e));
    };
    this.timer = setInterval(due, 60 * 60 * 1000);
    this.timer.unref();
    setImmediate(due);
  }
  stopSchedule() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  async close() {
    this.stopping = true;
    this.abort.abort();
    this.stopSchedule();
    await this.flight?.catch(() => undefined);
  }
  async review(): Promise<ImprovementReport> {
    if (!await this.flight) await this.run();
    return this.report();
  }
  async source(key: string, task: string, conversation: string, entry: number) {
    const [src, binding] = await Promise.all([
      this.ledger.read<string | null>({ kind: "source", key, task, conversation, entry }), this.ledger.binding(task),
    ]);
    if (!src || !binding) throw new Error("原始来源已不可用");
    return this.evidence(binding.directory, JSON.parse(src));
  }
  async child(task: string, conversation: number): Promise<ChildReviewEvidence> {
    if (!Number.isSafeInteger(conversation)) throw new Error("找不到这次子代理交接");
    const binding = await this.ledger.binding(task);
    if (!binding) throw new Error("找不到这次子代理交接");
    const dir = binding.directory;
    const children = await this.ledger.read<IndexedChild[]>({ kind: "children", task });
    const indexed = children.find(child => child.directory === dir && child.conversation === conversation)?.childId;
    if (!indexed) throw new Error("找不到这次子代理交接");
    const storage = await openDurablePassiveStorage(dir,ctx);
    if (!storage) throw new Error("无法读取原始会话");
    try {
      const c = await storage.conversation(conversation as ConversationId,ctx);
      const evidence = c && await readImprovementChild(storage,task,c,true);
      if (!evidence || evidence.child.childId !== indexed) throw new Error("子代理原始身份已变化");
      await this.flushDiagnostics?.();
      return { ...evidence, ...await this.childContext(task,String(conversation)) };
    } finally { await storage.close(ctx); }
  }
  private async childContext(task: string, id: string) {
    const diagnostics = this.app.connection.prepare(`
        WITH requests AS (SELECT record_json AS r FROM task_request_diagnostics WHERE task_id=@task
          AND json_extract(record_json,'$.sourceKind')='subagent' AND json_extract(record_json,'$.executionScope')=@task
          AND json_extract(record_json,'$.conversationId')=@id),
        execution_ids AS (
          SELECT COALESCE(json_extract(r,'$.executionId'),'durable:'||@task||':'||@id||':'||json_extract(r,'$.generationTaskId')) FROM requests
          UNION SELECT json_extract(record_json,'$.executionId') FROM task_tool_diagnostics
            WHERE task_id=@task AND json_extract(record_json,'$.sourceKind')='subagent' AND json_extract(record_json,'$.conversationId')=@id),
        waits AS (SELECT i.* FROM conversation_interactions i WHERE i.task_id=@task AND i.execution_id IN execution_ids)
        SELECT count(*) requests,
          CASE WHEN count(json_extract(r,'$.usage.input'))=count(*) THEN sum(json_extract(r,'$.usage.input')) END inputTokens,
          CASE WHEN count(json_extract(r,'$.usage.output'))=count(*) THEN sum(json_extract(r,'$.usage.output')) END outputTokens,
          CASE WHEN count(json_extract(r,'$.usage.cacheRead'))=count(*) THEN sum(json_extract(r,'$.usage.cacheRead')) END cacheReadTokens,
          (SELECT count(*) FROM waits) waits, (SELECT count(*) FROM waits WHERE status='resolved') answered,
          (SELECT sum(max(0,resolved_at-created_at)) FROM waits WHERE resolved_at IS NOT NULL) waitMs FROM requests`)
        .get({task,id}) as ChildReviewEvidence["diagnostics"];
    return {diagnostics, hooks:await this.hooks.childReviewReceipts(task,id)};
  }
  private async evidence(directory: string, source: ObservationSource) {
    const raw = await reflectionEvidence(directory,source);
    if (raw.length) {
      await this.flushDiagnostics?.();
      const context=await improvementSourceContext(this.app.connection,directory,source,this.hooks);
      raw[0]!.content.push({role:"原始决策的诊断、能力和验收凭据",text:JSON.stringify(context)});
      const used=await this.packages.sourceUses(source);
      if(used.length)raw[0]!.content.push({role:"本次交付实际获得的改进资产及结果",text:JSON.stringify(used)});
    }
    return raw;
  }
  private run(scheduled = false): Promise<boolean> {
    if (this.stopping) return Promise.reject(new Error("自我改进服务已关闭"));
    return this.flight ??= this.runOwned(scheduled).finally(() => { this.flight = undefined; this.progress={phase:"idle",done:0,total:0}; });
  }

  private async runOwned(scheduled: boolean) {
    const owner = randomUUID();
    const now = this.now(), week = weekOf(now);
    if (!await this.ledger.command<boolean>({ kind: "begin", owner, week, at: now, scheduled })) return false;

    const lease = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, lease.signal]);
    let renewal: Promise<void> | undefined;
    const timer = setInterval(() => {
      renewal ??= this.ledger.command<boolean>({ kind: "renew", owner }).then(valid => {
        if (!valid) lease.abort(new Error("改进复盘所有权已失效"));
      }).catch(error => lease.abort(error)).finally(() => { renewal = undefined; });
    }, 30_000);
    timer.unref();
    try {
      await this.cycle(owner, week, now, signal);
      return true;
    } finally {
      clearInterval(timer);
      await renewal;
      await this.ledger.command({ kind: "release", owner });
    }
  }

  private sortedGroups<T extends ImprovementGroup>(rows: T[]): T[] {
    const score = (group: T) => rankImprovementCandidate(group.kind, group.total, JSON.parse(group.scope).kind, group.cost ?? 0);
    return rows.sort((a, b) => score(b) - score(a) || a.key.localeCompare(b.key));
  }

  private async cycle(owner: string, week: string, now: number, signal: AbortSignal) {
    const started = Date.now();
    this.progress={phase:"回填上期",done:0,total:0};
    signal.throwIfAborted();
    await this.packages.followup(week,now);
    const issues: string[] = [];
    const managed = await this.ledger.read<ManagedImprovement[]>({ kind: "managed" });
    for (const m of managed) {
      signal.throwIfAborted();
      const { hook, version, triggers, errors, repaired } = await this.hooks.improvement(m.hook, m.revision);
      if (hook && version) await this.ledger.write(owner, { kind: "followup", week, key: m.key, metrics: JSON.stringify({
        title: version.draft.title, scope: hook.draft.scope.kind === "global" ? "全局" : hook.draft.scope.id,
        triggers, errors, repaired }) });
      if (hook?.enabled && hook.generation === 1 && errors) {
        signal.throwIfAborted();
        await this.hooks.activate(hook.id, hook.generation, hook.revision, false);
      }
    }
    for (const { hint, ...metrics } of await this.readHints.list()) {
      signal.throwIfAborted();
      await this.ledger.write(owner, { kind: "followup", week, key: hint.key, metrics: JSON.stringify({
        title: cards.readPath[0], scope: hint.task, ...metrics }) });
    }
    const bindings = await this.ledger.bindings();
    this.progress={phase:"读取原生会话和子代理",done:0,total:bindings.length};
    for (const { taskId, directory } of bindings) {
      signal.throwIfAborted();
      try {
        const seen = new Set<number>();
        const children = await this.ledger.read<IndexedChild[]>({ kind: "children", task: taskId });
        const indexed = new Map(children.map(child => [child.conversation, child]));
        await scanImprovementHistory(taskId, directory, async identity => {
          const state = await this.ledger.read<string | null>({ kind: "checkpoint", task: taskId, conversation: identity.conversationId });
          return state === null ? freshHistory() : JSON.parse(state) as HistoryState;
        }, async (identity, state, observations, scanned) => {
          signal.throwIfAborted();
          const task = await this.ledger.binding(taskId);
          if (!task || task.directory !== directory) throw new Error("原始任务绑定已变化");
          for (const observation of observations) {
            signal.throwIfAborted();
            if (observation.kind === "deliveryContract") await this.packages.correction(observation.source);
          }
          const rows = observations.map(o => {
            const scope = o.kind === "readPath" ? { kind: "task", id: taskId } : scoped(o, task);
            const key = o.kind === "readPath" ? fingerprint([o.kind,scope,o.replay]) : (o.kind === "correction" || o.kind === "oscillation" || o.kind === "sequence") ? fingerprint([o.kind, scope, o.replay.pattern ?? [taskId,identity.conversationId,o.source.entry]]) : fingerprint([o.kind, scope]);
            return { key, kind: o.kind, scope: JSON.stringify(scope), entry: o.source.entry, source: JSON.stringify(o.source),
              replay: JSON.stringify(o.replay), generation: o.priorGeneration };
          });
          await this.ledger.write(owner, { kind: "saveScan", week, task: taskId, conversation: identity.conversationId,
            state: JSON.stringify(state), observations: rows, scanned });
        }, () => signal.aborted, {
          needsRead: (conversation, childId) => {
            seen.add(conversation);
            const child = indexed.get(conversation);
            return !(child?.directory === directory && child.childId === childId && child.immutable);
          },
          save: (child, immutable) => this.ledger.write(owner, { kind: "saveChild", task: taskId, directory, conversation: child.conversation,
            childId: child.childId, immutable, summary: JSON.stringify(child) }),
        }, async (identity, inputs) => {
          signal.throwIfAborted();
          await this.packages.indexInputs(taskId, identity.conversationId, identity.actor, inputs.map(input => ({ ...input, eligible: input.contract })));
        });
        signal.throwIfAborted();
        await settleImprovementUses(this.packages, taskId, directory);
        await this.ledger.write(owner, { kind: "pruneChildren", task: taskId, seen: [...seen] });
      } catch (error) {
        signal.throwIfAborted();
        issues.push(taskId + " · " + String(error instanceof Error ? error.message : error).slice(0, 240));
      }
      this.progress.done++;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const candidates = this.sortedGroups(await this.ledger.read<ImprovementGroup[]>({ kind: "groups" }));
    const managedKeys = new Set(managed.map(item => item.key));
    this.progress={phase:"验证和发布改进",done:0,total:candidates.length};
    for (const g of candidates) {
      this.progress.done++;
      signal.throwIfAborted();
      if (managedKeys.has(g.key)) continue;
      const scope: HookDraft["scope"] = JSON.parse(g.scope);
      if(g.kind==="deliveryContract" && scope.kind!=="global"){
        if(await this.packages.current(g.key) || !this.knowledge()) continue;
        const [row] = await this.ledger.read<ReviewSample[]>({ kind: "samples", key: g.key });
        if (!row || await this.ledger.read<boolean>({ kind: "unverified", key: g.key, source: row.source })) continue;
        const source = JSON.parse(row.source) as ObservationSource;
        const sourceTask = await this.ledger.binding(source.taskId);
        if(!sourceTask || (await this.packages.sourceUses(source)).length ||
          await this.packages.select({taskId:source.taskId,projectId:sourceTask.projectId,workspaceId:sourceTask.spaceId}))continue;
        const contract=JSON.parse(JSON.parse(row.replay).contract) as DeliveryContract;
        const reserved = await this.ledger.write<string | null>(owner, { kind: "reserveSlot", key: g.key, week });
        if(!reserved)continue;
        try {
          const draft=await this.packages.createDraft(g.key,scope,source,contract,reserved);
          signal.throwIfAborted();
          const hash = await this.packages.stage(draft);
          signal.throwIfAborted();
          const currentTask = await this.ledger.binding(source.taskId);
          if(!currentTask || currentTask.directory !== sourceTask.directory || scope.kind==="project" && scope.id!==currentTask.projectId || scope.kind==="workspace" && scope.id!==currentTask.spaceId)
            throw new Error("来源任务范围已变化");
          await this.packages.activate(hash,0);
        } catch(e) {
          signal.throwIfAborted();
          if (!await this.packages.current(g.key)) await this.ledger.write(owner, { kind: "releaseSlot", key: g.key, week: reserved });
          if(e instanceof UnverifiedOriginalDelivery){
            await this.ledger.write(owner, { kind: "unverified", key: g.key, source: row.source, reason: e.message });
          }else issues.push(cards.deliveryContract[0]+" · "+String(e).slice(0,240));
        }
        continue;
      }
      if (g.kind === "readPath" && scope.kind === "task" && !await this.readHints.state(g.key)) {
        const sample = (await this.ledger.read<ReviewSample[]>({ kind: "samples", key: g.key })).at(-1);
        if (!sample) continue;
        try {
          const mapping = JSON.parse(sample.replay) as ReadMapping;
          const current = await this.ledger.binding(scope.id);
          if (current?.cwd !== mapping.cwd) continue;
          const reserved = await this.ledger.write<string | null>(owner, { kind: "reserveSlot", key: g.key, week });
          signal.throwIfAborted();
          if (reserved && !await this.readHints.publish(g.key, scope.id, mapping, reserved) && !await this.readHints.state(g.key)) {
            await this.ledger.write(owner, { kind: "releaseSlot", key: g.key, week: reserved });
          }
        } catch (error) {
          signal.throwIfAborted();
          issues.push(cards.readPath[0] + " · " + String(error).slice(0,240));
        }
        continue;
      }
      const draft = improvementDraft(g.kind, scope);
      if (!draft) continue;
      try {
        const samples = await this.ledger.read<ReviewSample[]>({ kind: "samples", key: g.key });
        const candidateBindings = await Promise.all(samples.map(sample => this.ledger.binding(sample.task)));
        const actual = samples.find((_sample, index) => {
          const t = candidateBindings[index];
          return t && (scope.kind === "task" || scope.kind === "project" && t.projectId === scope.id || scope.kind === "workspace" && t.spaceId === scope.id);
        });
        if (!actual) continue;
        // The pre-decision evidence must actually trigger the proposed action, in addition to the maintained controls.
        const replay = JSON.parse(actual.replay);
        const reserved = await this.ledger.write<string | null>(owner, { kind: "reserveSlot", key: g.key, week });
        if (!reserved) continue;
        if (await this.hooks.check(draft, replay) !== draft.cases[0].expected) throw new Error("原始决策输入未复现");
        signal.throwIfAborted();
        const h = await this.hooks.installImprovement({ ...draft, cases: [{ input: replay, expected: draft.cases[0].expected }, ...draft.cases] }, "improvement-" + g.key);
        await this.ledger.write(owner, { kind: "saveManaged", key: g.key, hook: h.id, revision: 1, installed: this.now(), week: reserved });
      } catch (error) {
        signal.throwIfAborted();
        issues.push(cards[g.kind][0] + " · " + String(error instanceof Error ? error.message : error).slice(0, 240));
      }
    }
    this.progress={phase:"核对归因和验收结果",done:0,total:1};
    signal.throwIfAborted();
    if (this.reviewer) await this.assess(owner, week, this.reviewer, signal);
    signal.throwIfAborted();
    await this.ledger.write(owner, { kind: "finishScan", week, at: now, duration: Date.now() - started, issues: JSON.stringify(issues) });

    this.progress={phase:"保存周报和验证回执",done:0,total:1};
    const unfinished = await this.ledger.read<{ week: string }[]>({ kind: "unfinished", through: week });
    for (const w of [...new Set([...unfinished.map(row => row.week), ...await this.packages.dirtyWeeks(week)])].sort()) {
      signal.throwIfAborted();
      const tokens = await this.packages.followup(w, now);
      const [report, replays] = await Promise.all([this.report(w), this.packages.replays(w)]);
      signal.throwIfAborted();
      await writeImprovementWeek(this.output, report, w, replays);
      signal.throwIfAborted();
      await this.packages.acknowledgeWeek(w, tokens);
      if (w === week || !issues.length) await this.ledger.write(owner, { kind: "markExported", week: w, finished: !issues.length });
    }
    if (!issues.length) await this.ledger.write(owner, { kind: "sealReview", week });
  }

  private async assess(owner: string, week: string, reviewer: Reviewer, signal: AbortSignal) {
    const pending = await this.ledger.read<{ key: string; source: string }[]>({ kind: "assessmentCandidates", week });
    for (const candidate of pending) {
      signal.throwIfAborted();
      const s = JSON.parse(candidate.source) as ObservationSource;
      const stamp = reviewer.scope(s.taskId);
      const binding = await this.ledger.binding(s.taskId);
      if (!stamp || !binding) continue;
      const reserved = await this.ledger.write<boolean>(owner, { kind: "reserveAssessment", ...candidate, week });
      if (!reserved) continue;
      try {
        const input = await this.evidence(binding.directory, s);
        signal.throwIfAborted();
        if (reviewer.scope(s.taskId) !== stamp) continue;
        await this.ledger.write(owner, { kind: "assessmentStarted", week });
        const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
        const analysis = parseReflection(await reviewer.complete(s.taskId, input, reviewSignal), input);
        signal.throwIfAborted();
        if (reviewer.scope(s.taskId) !== stamp) continue;
        await this.ledger.write(owner, { kind: "assessmentResult", ...candidate, week, assessment: JSON.stringify(analysis) });
      } catch (error) {
        signal.throwIfAborted();
        if (reviewer.scope(s.taskId) !== stamp) continue;
        await this.ledger.write(owner, { kind: "assessmentResult", ...candidate, week, error: String(error instanceof Error ? error.message : error).slice(0, 240) });
      }
    }
  }

  async report(exportWeek?:string): Promise<ImprovementReport> {
    const [paths, catalog, review] = await Promise.all([
      this.readHints.list(), this.packages.report(), this.ledger.read<ReviewSnapshot>({ kind: "report", exportWeek }),
    ]);
    const pathByKey = new Map(paths.map(item => [item.hint.key, item]));
    const pathsByWeek = new Map<string, number>();
    for (const { hint } of paths) pathsByWeek.set(hint.week, (pathsByWeek.get(hint.week) ?? 0) + 1);
    for (const version of catalog.versions) pathsByWeek.set(version.week, (pathsByWeek.get(version.week) ?? 0) + 1);
    const managed = new Map(review.managed.map(m => [m.key, m]));
    const packages=catalog.packages;
    const active=new Map(packages.map(p=>[p.id,p]));
    const items: ImprovementItem[] = [];
    for (const g of this.sortedGroups(review.items)) {
      const m = managed.get(g.key);
      const path = g.kind === "readPath" ? pathByKey.get(g.key) : undefined;
      const hint = path?.hint;
      const [title,cause,change,proof] = cards[g.kind];
      const scope = JSON.parse(g.scope) as { kind: string; id: string };
      const sources = g.sources.map(row => JSON.parse(row.source) as ObservationSource);
      const bundle = active.get(g.key);
      const pendingReason = !bundle && g.kind === "deliveryContract" ? g.pendingReason : null;
      const assessment = g.assessment;
      const metrics = m ? await this.hooks.improvement(m.hook, m.revision, g.feedback) : undefined;
      const hook = metrics?.hook;
      items.push({ key: g.key,title,cause,change,proof,scope: ({ task: "任务", project: "项目", workspace: "工作空间" }[scope.kind] ?? scope.kind) + " " + scope.id,
        count: g.total,sources,hookId: hook?.id,generation: bundle?.generation ?? (hint ? 1 : hook?.generation),revision: bundle?.revision ?? (hint ? 1 : m?.revision),recurrences: metrics?.recurrences ?? 0,
        ...(pendingReason ? {pendingReason}:{}), ...(hint ? { pathHint: hint.missing + " → " + hint.found } : {}),
        ...(assessment ? {assessment: {...JSON.parse(assessment.assessment),source: JSON.parse(assessment.source)}} : {}),
        state: bundle ? (bundle.enabled?"watching":"disabled") : hint ? hint.enabled ? "watching" : "disabled" : !m ? "candidate" : !hook?.enabled ? "disabled" : hook.revision !== m.revision ? "changed" : "watching",
        triggers: path?.triggers ?? metrics?.triggers ?? 0, repaired: path?.repaired ?? metrics?.repaired ?? 0,
        errors: path?.errors ?? metrics?.errors ?? 0 });
    }
    const bindings = new Map((await this.ledger.bindings()).map(row => [row.taskId, row.directory]));
    const children = review.children.filter(row => bindings.get(row.task) === row.directory).map(row => JSON.parse(row.summary) as ImprovementChild);
    const weeklyMetrics = await Promise.all(review.runs.map(async ({ week }) => {
      const start = Date.parse(week + "T00:00:00Z"), end = start + 7 * day;
      const [{ eligibleInputs, ...metrics }, stats] = await Promise.all([
        this.packages.metrics(week),
        this.ledger.read<{ durationMs: number; modelRequests: number; corrections: number }>({ kind: "weeklyStats", week, start, end }),
      ]);
      return { ...metrics, ...stats, opportunities: eligibleInputs };
    }));
    return { items, children, packages, outcomes: catalog.outcomes, versionEvidence: catalog.versions, weeklyMetrics, progress: { ...this.progress },
      runs: review.runs.map(({ issues, assessmentErrors, followup, ...run }) => ({
        ...run, issues: [...JSON.parse(issues), ...assessmentErrors.map(({ error }) => "AI 归因 · " + error)],
        published: run.published + (pathsByWeek.get(run.week) ?? 0),
        followup: followup.map(row => JSON.parse(row.metrics)),
      })),
    };
  }
  async disable(key: string, generation: number): Promise<ImprovementReport> {
    if(await this.packages.current(key)){await this.packages.disable(key,generation);return this.report();}
    if (generation === 1 && await this.readHints.state(key)) { await this.readHints.disable(key); return this.report(); }
    const m = (await this.ledger.read<ManagedImprovement[]>({ kind: "managed" })).find(item => item.key === key);
    if (!m) throw new Error("找不到此改进");
    const h = await this.hooks.find(m.hook);
    if (!h || h.revision !== m.revision) throw new Error("版本已变化，请在执行钩子中管理当前版本");
    await this.hooks.activate(h.id, generation, h.revision, false);
    return this.report();
  }
}
