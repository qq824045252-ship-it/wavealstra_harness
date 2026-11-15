import { readWorkFileSource, withWorkSourceRead, type WorkSourceReadOptions } from "./WorkFileEventSource";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { WorkActor, WorkDto, WorkGoalSourceDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

export interface AuthoritativeWorkSource {
  inputSnapshotId: string;
  sources: WorkGoalSourceDto[];
}

// Resource limits apply to one authoritative observation. Exceeding them is an
// explicit retryable read failure, never an invented "unchanged" snapshot.
export const MAX_WORK_GIT_FILES = 25_000;
export const MAX_WORK_GIT_BYTES = 256 * 1024 * 1024;

/** Source events are wakeups; only a fresh authoritative read can change the target. */
export class WorkSourceObserver {
  constructor(private readonly work: WorkService) {}

  /** Reads configured real sources. Unknown providers remain an explicit host blocker. */
  readCurrent(work:WorkDto, options:WorkSourceReadOptions = {}):Promise<AuthoritativeWorkSource> {
    return withWorkSourceRead(async signal => {
      const sources:WorkGoalSourceDto[]=[];
      for(const source of work.goalSources) {
        signal.throwIfAborted();
        if(source.sourceType==="external_input" && source.sourceRef.startsWith("work-event:"))continue;
        let current:WorkGoalSourceDto;
        if(source.sourceType==="file") current=await readWorkFileSource(source.sourceRef,{signal,awaitSettlement:options.awaitSettlement});
        else if(source.sourceType==="git_commit") current={...source,...await readGitSource(source.sourceRef,signal)};
        else throw Error(`来源尚无可信回读适配：${source.sourceType} ${source.sourceRef}`);
        signal.throwIfAborted();
        sources.push(current.inputSnapshotId===source.inputSnapshotId?source:current);
      }
      if(!sources.length)throw Error("事项未绑定可回读的文件或 Git 来源，等待配置真实来源");
      return {inputSnapshotId:sources.length===1?sources[0].inputSnapshotId:sourceSnapshot(sources),sources};
    }, options);
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
      const source = await readWorkFileSource(resolve(path));
      return { inputSnapshotId: source.inputSnapshotId, sources: [source] };
    });
  }

  /** Trusted host capability; hooks supply wakeups, never a forged user or a target snapshot. */
  async observeFiles(workId:string,operationId:string,paths:string[]) {
    const before=this.work.getWork(workId);
    if(!before) return {ok:false as const,code:"not_found" as const,message:"找不到 Work"};
    const observed=await withWorkSourceRead(signal => readFiles(paths,signal));
    const keys=new Set(observed.map(source=>JSON.stringify([source.sourceType,source.sourceRef])));
    const sources=[...before.goalSources.filter(source=>!keys.has(JSON.stringify([source.sourceType,source.sourceRef]))),...observed.map(source=>before.goalSources.find(previous=>previous.sourceType===source.sourceType && previous.sourceRef===source.sourceRef && previous.inputSnapshotId===source.inputSnapshotId) ?? source)];
    return this.work.applyObservedSources(workId,operationId,before,{inputSnapshotId:sources.length===1?sources[0].inputSnapshotId:sourceSnapshot(sources),sources});
  }

  files(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string, paths: string[]) {
    return this.refresh(actor,workId,operationId,async () => {
      const sources = await withWorkSourceRead(signal => readFiles(paths,signal));
      return { inputSnapshotId: sourceSnapshot(sources), sources };
    });
  }

  git(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string, cwd: string) {
    return this.refresh(actor,workId,operationId,async () => {
      const source=await withWorkSourceRead(signal => readGitSource(cwd,signal));
      return { inputSnapshotId:source.inputSnapshotId, sources:[source] };
    });
  }
}

async function readFiles(paths:string[],signal:AbortSignal):Promise<WorkGoalSourceDto[]> {
  const sources:WorkGoalSourceDto[]=[];
  for(const path of [...new Set(paths.map(path=>resolve(path)))].sort()) {
    signal.throwIfAborted();
    sources.push(await readWorkFileSource(path,{signal}));
  }
  return sources;
}

async function readGitSource(cwd:string,signal:AbortSignal):Promise<WorkGoalSourceDto> {
  signal.throwIfAborted();
  const git=promisify(execFile);
  const head=(await git("git",["rev-parse","HEAD"],{cwd,signal})).stdout.trim();
  signal.throwIfAborted();
  const names=(await git("git",["ls-files","-z","--cached","--others","--exclude-standard"],{cwd,signal,maxBuffer:16*1024*1024})).stdout.split("\0").filter(Boolean);
  signal.throwIfAborted();
  const paths=[...new Set(names)].sort();
  if(paths.length>MAX_WORK_GIT_FILES)throw Error(`Git 来源读取上限为 ${MAX_WORK_GIT_FILES} 个文件，保留原事件等待缩小来源范围`);
  const entries:Array<[string,string]>=[];
  let totalBytes=0;
  const account=(bytes:number)=>{
    totalBytes+=bytes;
    if(totalBytes>MAX_WORK_GIT_BYTES)throw Error(`Git 来源读取上限为 ${MAX_WORK_GIT_BYTES} 字节，保留原事件等待缩小来源范围`);
  };
  for(const name of paths) {
    signal.throwIfAborted();
    const path=resolve(cwd,name);
    let before:Awaited<ReturnType<typeof lstat>>;
    try { before=await lstat(path); }
    catch(error) {
      signal.throwIfAborted();
      // A confirmed deletion is an observable state; permissions, cancellation
      // and I/O failures cannot be represented as a successful content hash.
      if((error as NodeJS.ErrnoException).code==="ENOENT") { entries.push([name,"missing"]);continue; }
      throw error;
    }
    signal.throwIfAborted();
    const digest=createHash("sha256");
    if(before.isSymbolicLink()) {
      const target=await readlink(path);
      signal.throwIfAborted();
      account(Buffer.byteLength(target));
      digest.update("symlink\0").update(target);
    } else {
      if(!before.isFile())throw Error(`Git 来源只支持常规文件或符号链接：${name}`);
      if(totalBytes+before.size>MAX_WORK_GIT_BYTES)throw Error(`Git 来源读取上限为 ${MAX_WORK_GIT_BYTES} 字节，保留原事件等待缩小来源范围`);
      const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0));
      try {
        signal.throwIfAborted();
        const opened=await file.stat();
        signal.throwIfAborted();
        if(!opened.isFile() || opened.ino!==before.ino || opened.size!==before.size)
          throw Error(`Git 来源读取期间发生变化：${name}`);
        const stream=file.createReadStream({signal,autoClose:false});
        let length=0;
        for await(const chunk of stream) {
          signal.throwIfAborted();
          const bytes=chunk as Buffer;
          account(bytes.length);length+=bytes.length;digest.update(bytes);
        }
        if(length!==before.size)throw Error(`Git 来源读取期间发生变化：${name}`);
      } finally { await file.close(); }
    }
    signal.throwIfAborted();
    const after=await lstat(path);
    signal.throwIfAborted();
    if(after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs || after.ino!==before.ino)
      throw Error(`Git 来源读取期间发生变化：${name}`);
    entries.push([name,digest.digest("hex")]);
  }
  signal.throwIfAborted();
  return {sourceType:"git_commit",sourceRef:resolve(cwd),inputSnapshotId:`git-workspace:${createHash("sha256").update(JSON.stringify([head,entries])).digest("hex")}`,observedAt:Date.now()};
}

export function sourceSnapshot(sources: WorkGoalSourceDto[]): string {
  return `sources:${createHash("sha256").update(JSON.stringify(sources.map(source => [source.sourceType,source.sourceRef,source.inputSnapshotId]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex")}`;
}
