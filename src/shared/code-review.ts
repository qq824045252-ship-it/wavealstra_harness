export const CodeReviewIpc = {
  pendingCount: "codeReview:pendingCount",
  changed: "codeReview:changed",
  list: "codeReview:list",
  detail: "codeReview:detail",
  decide: "codeReview:decide",
  gitRefs: "codeReview:gitRefs",
  gitList: "codeReview:gitList",
  gitDetail: "codeReview:gitDetail",
} as const;

export interface CodeReviewFile {
  id: string;
  name: string;
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  statsAvailable?: boolean;
  status: "pending" | "accepted" | "rejected";
  canReject: boolean;
  reason?: string;
}

export interface CodeReviewDetail extends CodeReviewFile {
  before: string | null;
  after: string | null;
  patch?: string;
}

export type CodeReviewGitComparison = { mode: "uncommitted" } | {
  mode: "compare";
  base: string;
  compare: string;
  threeDot?: boolean;
};

export interface CodeReviewGitRefs {
  branch: string | null;
  head: string | null;
  defaultBase: string;
  refs: string[];
}

export interface CodeReviewGitFile extends CodeReviewFile {
  section: "staged" | "unstaged" | "compare";
  version: string;
  oldPath?: string;
  comparison: CodeReviewGitComparison;
  oldRevision?: string;
  newRevision?: string;
  untracked?: boolean;
}

export interface CodeReviewGitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  relativeTime: string;
  author: string;
  subject: string;
}

export interface CodeReviewGitList {
  files: CodeReviewGitFile[];
  comparison: CodeReviewGitComparison;
  baseSha?: string;
  compareSha?: string;
  commits: CodeReviewGitCommit[];
  truncated: boolean;
}

export interface CodeReviewDecisionRequest {
  taskId: string;
  ids: string[];
  action: "accept" | "reject";
}

export interface CodeReviewDecisionResult {
  files: CodeReviewFile[];
  results: {
    id: string;
    status: "accepted" | "rejected" | "conflict" | "unavailable";
    reason?: string;
  }[];
}

export interface CodeReviewChangedEvent {
  taskId: string;
  pendingCount: number;
}

export interface CodeReviewApi {
  pendingCount(taskId: string): Promise<number>;
  onChanged(listener: (event: CodeReviewChangedEvent) => void): () => void;
  list(taskId: string): Promise<CodeReviewFile[]>;
  detail(taskId: string, id: string): Promise<CodeReviewDetail | null>;
  decide(request: CodeReviewDecisionRequest): Promise<CodeReviewDecisionResult>;
  gitRefs(taskId: string): Promise<CodeReviewGitRefs | null>;
  gitList(taskId: string, comparison?: CodeReviewGitComparison): Promise<CodeReviewGitList | null>;
  gitDetail(taskId: string, file: CodeReviewGitFile): Promise<CodeReviewDetail | null>;
}
