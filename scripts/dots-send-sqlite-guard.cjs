// Runs before both the isolated desktop test and the detached Pi Node Host.
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
process.env.MYBUDDY_SQLITE_ATTEMPTS ??= join(require("node:os").tmpdir(), "dots-send-sqlite-" + require("node:crypto").randomUUID() + ".log");
require("./no-sqlite-open-guard.cjs");

// Pi returns a structured failure without its local stack. Preserve the actual
// synchronous repository caller even when the service catches this exception.
Error.stackTraceLimit = 60;
globalThis.Error = new Proxy(Error, {
  construct(target, args, newTarget) {
    const error = Reflect.construct(target, args, newTarget);
    if (String(args[0]).includes("此操作仍依赖本地 SQLite")) {
      appendFileSync(process.env.MYBUDDY_SQLITE_ATTEMPTS, error.stack + "\n");
      console.error(error.stack);
    }
    return error;
  },
});
