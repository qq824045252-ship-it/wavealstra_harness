import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkActor, WorkDto, WorkGoalSourceDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

export interface AuthoritativeWorkSource {
  inputSnapshotId: string;
  sources: WorkGoalSourceDto[];
}

/** Source events are wakeups; only a fresh authoritative read can change the target. */
export class WorkSourceObserver {
  constructor(private readonly work: WorkService) {}

  /** Reads configured real sources. Unknown providers remain an explicit host blocker. */
  async readCurrent(work:WorkDto):Promise<AuthoritativeWorkSource> {
    const sources:WorkGoalSourceDto[]=[];
    for(const source of work.goalSources) {
      if(source.sourceType==="external_input" && source.sourceRef.startsWith("work-event:"))continue;
      let current:WorkGoalSourceDto;
      if(source.sourceType==="file") current={...source,inputSnapshotId:`sha256:${createHash("sha256").update(await readFile(source.sourceRef)).digest("hex")}`,observedAt:Date.now()};
      else if(source.sourceType==="git_commit") current={...source,...await readGitSource(source.sourceRef)};
      else throw Error(`来源尚无可信回读适配：${source.sourceType} ${source.sourceRef}`);
      sources.push(current.inputSnapshotId===source.inputSnapshotId?source:current);
    }
    if(!sources.length)throw Error("事项未绑定可回读的文件或 Git 来源，等待配置真实来源");
    return {inputSnapshotId:sources.length===1?sources[0].inputSnapshotId:sourceSnapshot(sources),sources};
  }

  async refresh(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string,
    readCurrent: () => Promise<AuthoritativeWorkSource>) {
    const before = this.work.getWork(workId);
    if (!before || before.userId !== actor.userId) return { ok: false as const, code: "not_found" as const, message: "找不到 Work" };
    // No database transaction spans file/network I/O. Late observations must re-evaluate.
    const current = await readCurrent();
    const observed = current.sources.map(source => {
      const prior = before.goalSources.find(previous => previous.sourceType === source.sourceType
        && previous.sourceRef === source.sourceRef && previous.inputSnapshotId === source.inputSnapshotId);
      return prior ?? source;
    });
    const observedKeys = new Set(observed.map(source => JSON.stringify([source.sourceType,source.sourceRef])));
    const sources = [...before.goalSources.filter(source => !observedKeys.has(JSON.stringify([source.sourceType,source.sourceRef]))), ...observed];
    const snapshot = sources.length === 1 ? current.inputSnapshotId : sourceSnapshot(sources);
    return this.work.amendWork(actor, { operationId, workId, inputSnapshotId: snapshot,
      goalSources: sources, versionGuard: { expectedStateVersion: before.stateVersion,
        expectedIntentRevision: before.intentRevision, expectedOwnerEpoch: before.ownerEpoch } });
  }

  file(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string, path: string) {
    return this.refresh(actor, workId, operationId, async () => {
      const sourceRef = resolve(path);
      const inputSnapshotId = `sha256:${createHash("sha256").update(await readFile(sourceRef)).digest("hex")}`;
      return { inputSnapshotId, sources: [{ sourceType: "file", sourceRef, inputSnapshotId, observedAt: Date.now() }] };
    });
  }

  /** Trusted host capability; hooks supply wakeups, never a forged user or a target snapshot. */
  async observeFiles(workId:string,operationId:string,paths:string[]) {
    const before=this.work.getWork(workId);
    if(!before) return {ok:false as const,code:"not_found" as const,message:"找不到 Work"};
    const observed=await Promise.all([...new Set(paths.map(path=>resolve(path)))].sort().map(async sourceRef=>({sourceType:"file" as const,sourceRef,
      inputSnapshotId:`sha256:${createHash("sha256").update(await readFile(sourceRef)).digest("hex")}`,observedAt:Date.now()})));
    const keys=new Set(observed.map(source=>JSON.stringify([source.sourceType,source.sourceRef])));
    const sources=[...before.goalSources.filter(source=>!keys.has(JSON.stringify([source.sourceType,source.sourceRef]))),...observed.map(source=>before.goalSources.find(previous=>previous.sourceType===source.sourceType && previous.sourceRef===source.sourceRef && previous.inputSnapshotId===source.inputSnapshotId) ?? source)];
    return this.work.applyObservedSources(workId,operationId,before,{inputSnapshotId:sources.length===1?sources[0].inputSnapshotId:sourceSnapshot(sources),sources});
  }

  files(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string, paths: string[]) {
    return this.refresh(actor,workId,operationId,async () => {
      const sources = await Promise.all([...new Set(paths.map(path => resolve(path)))].sort().map(async sourceRef => ({ sourceType: "file" as const,
        sourceRef, inputSnapshotId: `sha256:${createHash("sha256").update(await readFile(sourceRef)).digest("hex")}`, observedAt: Date.now() })));
      return { inputSnapshotId: sourceSnapshot(sources), sources };
    });
  }

  git(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string, cwd: string) {
    return this.refresh(actor,workId,operationId,async () => {
      const source=await readGitSource(cwd);
      return { inputSnapshotId:source.inputSnapshotId, sources:[source] };
    });
  }
}

async function readGitSource(cwd:string):Promise<WorkGoalSourceDto> {
  const git=promisify(execFile);
  const head=(await git("git",["rev-parse","HEAD"],{cwd})).stdout.trim();
  const names=(await git("git",["ls-files","-z","--cached","--others","--exclude-standard"],{cwd,maxBuffer:16*1024*1024})).stdout.split("\0").filter(Boolean);
  const entries:Array<[string,string]>=[];
  for(const name of [...new Set(names)].sort()) {
    try{entries.push([name,createHash("sha256").update(await readFile(resolve(cwd,name))).digest("hex")]);}
    catch{entries.push([name,"missing-or-unreadable"]);}
  }
  return {sourceType:"git_commit",sourceRef:resolve(cwd),inputSnapshotId:`git-workspace:${createHash("sha256").update(JSON.stringify([head,entries])).digest("hex")}`,observedAt:Date.now()};
}

export function sourceSnapshot(sources: WorkGoalSourceDto[]): string {
  return `sources:${createHash("sha256").update(JSON.stringify(sources.map(source => [source.sourceType,source.sourceRef,source.inputSnapshotId]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex")}`;
}
