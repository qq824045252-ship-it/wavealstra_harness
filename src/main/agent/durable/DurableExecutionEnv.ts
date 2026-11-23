import { withAbortSignal } from "@earendil-works/chord/context";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BashInactivityError, runBashWithInactivityTimeout } from "../../platform/bash-inactivity";

export class DurableExecutionEnv extends NodeExecutionEnv {
  override async exec(...[command, options, context]: Parameters<NodeExecutionEnv["exec"]>): ReturnType<NodeExecutionEnv["exec"]> {
    // Pi runs Bash through the configured shell. PowerShell and direct executables use argv.
    if (typeof command !== "string") return super.exec(command, options, context);
    try {
      return await runBashWithInactivityTimeout(context.abortSignal, (signal, onOutput) => super.exec(command, {
        ...options,
        onOutput: (chunk, outputContext, info) => {
          if (signal.aborted) return;
          if (chunk) onOutput();
          options?.onOutput?.(chunk, outputContext, info);
        },
      }, withAbortSignal(signal, context)));
    } catch (error) {
      if (!(error instanceof BashInactivityError)) throw error;
      return { ok: false, error: new ExecutionError("unknown", error.message, error) };
    }
  }
}
