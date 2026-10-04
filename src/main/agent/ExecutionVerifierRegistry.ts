import type { ExecutionVerificationResult } from "../../shared/execution-verification";

export interface VerifierRequest {
  taskId: string;
  executionId: string;
  assistantMessageId: string;
  attemptId: string;
  verifierId: string;
  verifierVersion: number;
  target: string;
  canonicalTarget: string;
  expected: Record<string, unknown>;
  observation?: Record<string, unknown>;
}
type Observation = Pick<ExecutionVerificationResult, "status" | "observed" | "causeCode">;
type Verifier = (request: VerifierRequest, assertActive: () => void) => Promise<Observation>;

/** Only main-process adapters register code. Tool arguments cannot register or execute verifier code. */
export class ExecutionVerifierRegistry {
  private readonly verifiers = new Map<string, Verifier>();
  register(id: string, version: number, verifier: Verifier): void {
    const key = `${id}@${version}`;
    if (this.verifiers.has(key)) throw new Error(`Verifier already registered: ${key}`);
    this.verifiers.set(key, verifier);
  }
  async run(request: VerifierRequest, assertActive: () => void): Promise<ExecutionVerificationResult> {
    let result: Observation;
    try {
      assertActive();
      const verifier = this.verifiers.get(`${request.verifierId}@${request.verifierVersion}`);
      result = verifier ? await verifier(request, assertActive) : { status: "not_run", causeCode: "verifier-unavailable" };
      assertActive();
      if (!result || !["passed", "failed", "inconclusive", "not_run"].includes(result.status)
        || (result.status === "passed" && (!result.observed || Object.keys(result.observed).length === 0))) {
        result = { status: "inconclusive", causeCode: "invalid-verifier-result" };
      }
    } catch (error) {
      const causeCode = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "target-missing"
        : ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "") ? "access-denied" : "verifier-error";
      result = { status: "inconclusive", causeCode };
    }
    return { ...result, verifierId: request.verifierId, verifierVersion: request.verifierVersion,
      attemptId: request.attemptId, taskId: request.taskId, executionId: request.executionId, assistantMessageId: request.assistantMessageId,
      target: request.target, canonicalTarget: request.canonicalTarget,
      expected: request.expected, checkedAt: Date.now() };
  }
}

export function createExecutionVerifierRegistry(): ExecutionVerifierRegistry {
  const registry = new ExecutionVerifierRegistry();
  registry.register("process-exit-code", 1, async (request) => {
    const expectedExitCode = request.expected.exitCode;
    const observedExitCode = request.observation?.exitCode;
    if (typeof expectedExitCode !== "number" || !Number.isSafeInteger(expectedExitCode)
      || typeof observedExitCode !== "number" || !Number.isSafeInteger(observedExitCode)) {
      return { status: "inconclusive", causeCode: "invalid-process-exit-observation" };
    }
    return observedExitCode === expectedExitCode
      ? { status: "passed", observed: { exitCode: observedExitCode } }
      : { status: "failed", causeCode: "exit-code-mismatch", observed: { exitCode: observedExitCode } };
  });
  return registry;
}

const defaultRegistry = createExecutionVerifierRegistry();
export async function verifyObservedProcessExit(request: {
  taskId: string;
  executionId: string;
  assistantMessageId: string;
  attemptId: string;
  target: string;
  exitCode: number;
}, assertActive: () => void): Promise<ExecutionVerificationResult> {
  return defaultRegistry.run({
    ...request,
    canonicalTarget: request.target,
    verifierId: "process-exit-code",
    verifierVersion: 1,
    expected: { exitCode: 0 },
    observation: { exitCode: request.exitCode },
  }, assertActive);
}
