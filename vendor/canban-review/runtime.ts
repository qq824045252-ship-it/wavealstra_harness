import binary from "./canban-review.wasm.json";

export interface CanbanDiffLine {
  kind: " " | "+" | "-" | "\\";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

type HunkHeader = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context: string;
};

export interface CanbanDiffHunk extends HunkHeader {
  entryOld: number;
  entryNew: number;
  exitOld: number;
  exitNew: number;
  endsWithNoNewline: boolean;
  lines: CanbanDiffLine[];
}

export interface CanbanDiff {
  hunks: CanbanDiffHunk[];
  autoFoldReason: "generated" | number | null;
}

export interface CanbanGapExpansion {
  fromTop: number;
  fromBottom: number;
}

export interface CanbanInlineComment {
  path: string;
  section: string;
  line: number;
  side: "LEFT" | "RIGHT";
  snippet: string;
  body: string;
}

export interface CanbanGitStatusFile {
  path: string;
  orig_path?: string | null;
  index_code: string;
  worktree_code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface CanbanGitPatchFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface CanbanReviewRuntime {
  contextStep: number;
  parse(patch: string, filename?: string): CanbanDiff;
  formatHunkHeader(hunk: HunkHeader, expandedAbove: number): string;
  expandGap(
    gap: "leading" | "between" | "trailing",
    length: number,
    expansion: CanbanGapExpansion,
    direction: "up" | "down" | "all",
  ): CanbanGapExpansion;
  formatPendingMarkdown(contextLabel: string, summary: string, comments: readonly CanbanInlineComment[]): string;
  gitStatus(status: string): CanbanGitStatusFile[];
  gitCompareCommand(mode: "STAGED" | "UNSTAGED" | "WORKDIR" | "REVISION", base?: string, compare?: string): string[] | null;
  gitPatchFiles(patch: string): CanbanGitPatchFile[];
}

interface ReviewExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  prepare_request(length: number): number;
  run_request(): number;
  response_length(): number;
  clear_response(): void;
  context_step(): bigint;
}

let runtime: CanbanReviewRuntime | undefined;

export function getCanbanReviewRuntime(): CanbanReviewRuntime {
  if (runtime) return runtime;
  const bytes = Uint8Array.from(atob(binary.base64), (char) => char.charCodeAt(0));
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function invoke<Result>(request: object): Result {
    const wasm = instance.exports as ReviewExports;
    const input = encoder.encode(JSON.stringify(request));
    const pointer = wasm.prepare_request(input.length);
    new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
    const result = wasm.run_request();
    try {
      if (!wasm.response_length()) throw new Error("Canban rejected the review input");
      return JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, result, wasm.response_length())));
    } finally {
      wasm.clear_response();
    }
  }

  runtime = {
    contextStep: Number((instance.exports as ReviewExports).context_step()),
    parse: (patch, filename = "") => invoke({ operation: "parse", patch, filename }),
    formatHunkHeader: ({ header, oldStart, oldCount, newStart, newCount, context }, expandedAbove) =>
      invoke({ operation: "formatHunkHeader", hunk: { header, oldStart, oldCount, newStart, newCount, context }, expandedAbove }),
    expandGap: (gap, length, expansion, direction) => invoke({ operation: "expandGap", gap, length, expansion, direction }),
    formatPendingMarkdown: (contextLabel, summary, comments) =>
      invoke({ operation: "formatPendingMarkdown", contextLabel, summary, comments }),
    gitStatus: (status) => invoke({ operation: "gitStatus", status }),
    gitCompareCommand: (mode, base, compare) => invoke({ operation: "gitCompareCommand", mode, base, compare }),
    gitPatchFiles: (patch) => invoke({ operation: "gitPatchFiles", patch }),
  };
  return runtime;
}
