import type { SubagentSteerReceipt } from "./subagent-steer";
import type { SubagentStopRequestSource } from "./agent-ipc";

export const NativeImprovementIpc = {
  report: "native-improvement:report",
  review: "native-improvement:review",
  disable: "native-improvement:disable",
  source: "native-improvement:source",
  child: "native-improvement:child",
} as const;

export type ImprovementKind = "scope" | "retry" | "readback" | "redundant" | "handoff" | "correction" | "recovery" | "readPath" | "childDelivery" | "childSteer" | "deliveryContract" | "oscillation" | "progress" | "sequence";
export interface ObservationSource {
  taskId: string; conversationId: string; actor: "main" | "subagent"; parent?: string;
  entry: number; trigger: number; input: number; at: number; baseline?: number;
  childReceipt?: "assignment" | "steer";
}
export interface ImprovementItem {
  key: string; title: string; cause: string; change: string; proof: string; scope: string;
  count: number; sources: ObservationSource[]; hookId?: string; generation?: number; revision?: number;
  pathHint?: string;
  pendingReason?: string;
  state: "candidate" | "watching" | "disabled" | "changed";
  triggers: number; repaired: number; recurrences: number; errors: number;
  assessment?: { route: string; finding: string; reason: string; change: string; acceptance: string; evidence: number[]; source: ObservationSource };
}
export interface ImprovementRun {
  week: string; at: number; scanned: number; added: number; published: number; issues: string[];
  followup: { title: string; scope: string; triggers: number; repaired: number; errors: number }[];
}
export interface ImprovementChild {
  taskId: string; conversation: number; parent: number; ownerTask: number; childId: string; role: string;
  startedAt: number; model: string; assignments: number; steers: number; unansweredSteers: number;
  tools: number; toolFailures: number; status: "completed" | "failed" | "timedout" | "cancelled" | "blocked" | "unknown";
  durationMs?: number;
  stopRequest?: SubagentStopRequestSource;
}
export interface ChildHistoryEvidence {
  child: ImprovementChild;
  assignment: string;
  roleFingerprint?: string;
  parentSubmissions?: number[];
  parentCallId?: string;
  parentReturnEntry?: number;
  returnDiagnostic?: string;
  submissions: { id: number; requestId: string; status: string; entry?: number; answer?: number; reason?: string }[];
  steers: SubagentSteerReceipt[];
  tools: { task: number; name?: string; callId?: string; nested: boolean; status: string; resultEntry?: number }[];
  answer?: { entry: number; text: string };
}
export interface ChildReviewEvidence extends ChildHistoryEvidence {
  diagnostics: { requests: number; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
    waits: number; answered: number; waitMs: number | null };
  hooks: { id: string; revision: number; executions: number }[];
}
export type ImprovementAssetKind = "hook" | "tool" | "skill" | "convention" | "memory";
export type ImprovementScope = {kind:"task" | "workspace" | "project"; id:string};
export interface ImprovementPackage {
  id:string; revision:number; generation:number; scope:ImprovementScope; enabled:boolean; week:string; hash:string;
  previous:number | null; source:ObservationSource; assets:{kind:ImprovementAssetKind;hash:string}[];
}
export interface ImprovementOutcome {
  week:string; packageId:string; revision:number; state:"effective"|"ineffective"|"pending"|"regressed";
  opportunities:number; accepted:number; corrections:number; errors:number;
  assets?:{kind:ImprovementAssetKind;state:ImprovementOutcome["state"];opportunities:number;used:number;accepted:number;corrections:number;errors:number}[];
}
export interface ImprovementVersionEvidence {
  source?:ObservationSource;
  hash?:string;scope?:ImprovementScope;assets?:ImprovementPackage["assets"];
  packageId:string;revision:number;active:boolean;retired:boolean;week:string;previous:number|null;
  cases:{name:string;passed:boolean}[];useCount:number;
  uses:{actor:string;task:string;conversation:string;run:string;kind:ImprovementAssetKind;event:string;at:number}[];
}
export interface ImprovementWeeklyMetrics {
  week:string; opportunities:number; accepted:number; corrections:number; unassisted:number; recurrences:number;
  exposed:number; used:number; errors:number; falseTriggers:number|null; durationMs:number; modelRequests:number; toolCalls:number; userInputs:number;
}
export interface ImprovementReport {
  runs:ImprovementRun[]; items:ImprovementItem[]; children:ImprovementChild[]; packages:ImprovementPackage[]; outcomes:ImprovementOutcome[];
  progress:{phase:string;done:number;total:number}; weeklyMetrics:ImprovementWeeklyMetrics[];
  versionEvidence?:ImprovementVersionEvidence[];
}
export interface ImprovementExcerpt {
  id: number; kind: string; content: { role: string; text?: string; name?: string; failed?: boolean }[];
}
export interface NativeImprovementApi {
  report(): Promise<ImprovementReport>;
  review(): Promise<ImprovementReport>;
  disable(key: string, generation: number): Promise<ImprovementReport>;
  source(key: string, task: string, conversation: string, entry: number): Promise<ImprovementExcerpt[]>;
  child(task: string, conversation: number): Promise<ChildReviewEvidence>;
}
