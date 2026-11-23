import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readBenchmarkAttempt(run) {
  if (run.state === "planned" || run.state === "running") return { status: run.state };
  let result;
  try {
    result = JSON.parse(readFileSync(join(run.out, "results.json"), "utf8"));
  } catch (error) {
    return { status: "missing-report", error: run.error ?? String(error) };
  }
  const test = Array.isArray(result?.cases) && result.cases.length === 1 ? result.cases[0] : undefined;
  if (run.case === "screenshot") {
    const hasChecks = Array.isArray(result?.results) && result.results.length > 0;
    const status = run.exitCode !== 0 || result?.error || result?.status === "failed" ? "failed"
      : hasChecks && typeof result.at === "string" ? "passed" : "invalid-report";
    return { status, result, error: result?.error ?? run.error };
  }
  if (result?.modelId !== run.model || result?.variant !== run.variant) {
    return { status: "invalid-report", error: result?.error ?? "Report does not match the planned model, variant and case" };
  }
  if (!result.cases?.length && result.status === "failed") return { status: "failed", result, error: result.error ?? run.error };
  if (test?.id !== run.case) return { status: "invalid-report", error: "Report does not match the planned case" };
  const status = run.exitCode !== 0 && test.status === "passed" ? "process-failed-after-case"
    : result.error || test.error || result.status === "failed" || test.status === "failed" ? "failed"
    : run.exitCode === 0 && result.status === "passed" && test.status === "passed" ? "passed" : "incomplete";
  return { status, result, test, error: test.error ?? result.error ?? run.error };
}
