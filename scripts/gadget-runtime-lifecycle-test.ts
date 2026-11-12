/** Real owned child processes, normal lifecycle first; no production data. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import type { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import type { GadgetDescriptor, GadgetRuntimeState } from "../src/shared/gadget-types";

async function main(): Promise<void> {
  const fixtureBase = join(process.cwd(), "out/tests");
  mkdirSync(fixtureBase, { recursive: true });
  const root = mkdtempSync(join(fixtureBase, "gadget-runtime-lifecycle-"));
  writeFileSync(join(root, "index.html"), "<body>isolated runtime fixture</body>");
  const registry = new GadgetRegistry();
  const events: GadgetRuntimeState[] = [];
  const storage = {
    materializeLegacyLocalHtmlRedirect: () => false,
    readManifest: () => ({ entry: "index.html" }),
    paths: () => ({ sourcePath: root }),
  } as unknown as GadgetStorage;
  const runtime = new GadgetRuntime(storage, registry, state => events.push(state));
  const descriptor = { id: "fixture-runtime" } as GadgetDescriptor;
  const guard = setTimeout(() => { console.error("Lifecycle test exceeded deadline"); process.exit(1); }, 30_000);
  try {
    const starts = await Promise.all(Array.from({ length: 8 }, () => runtime.start(descriptor)));
    assert(starts.every(state => state.status === "running"));
    assert.equal(new Set(starts.map(state => state.pid)).size, 1, "concurrent opens share a process");
    const first = starts[0];
    assert.match(await (await fetch(first.url!)).text(), /isolated runtime fixture/);
    assert.equal((await runtime.health(descriptor.id)).pid, first.pid);
    const stopped = await runtime.stop(descriptor.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.url, undefined);
    assert.equal(stopped.diagnostics?.reason, "explicit_stop");
    assert(stopped.diagnostics?.exitCode === 0 ||
      stopped.diagnostics?.signal === "SIGTERM" || stopped.diagnostics?.signal === "SIGKILL");
    assert.equal(stopped.diagnostics?.url, first.url);
    assert(stopped.diagnostics?.exitedAt);
    const reopened = await runtime.start(descriptor);
    assert.equal(reopened.status, "running");
    assert.notEqual(reopened.pid, first.pid);
    assert.equal(reopened.diagnostics?.pid, first.pid);
    console.log("PASS normal concurrent open, health, graceful stop, reopen");

    // Invocation order must be linearizable; restart cannot allow a parallel
    // open to leave an untracked server behind or wait on its own queue.
    const [restarted, opened, restopped, last] = await Promise.all([
      runtime.restart(descriptor), runtime.start(descriptor),
      runtime.stop(descriptor.id), runtime.start(descriptor),
    ]);
    assert.equal(restarted.status, "running");
    assert.equal(opened.pid, restarted.pid);
    assert.equal(restopped.status, "stopped");
    assert.equal(last.status, "running");
    assert.notEqual(last.pid, opened.pid);
    assert.equal((await runtime.health(descriptor.id)).pid, last.pid);
    const [one, two] = await Promise.all([runtime.stop(descriptor.id), runtime.stop(descriptor.id)]);
    assert.equal(one.status, "stopped"); assert.equal(two.status, "stopped");
    assert(!events.some(state => state.status === "error"), "normal lifecycle must not report a crash");
    console.log("PASS serialized restart/open/stop/open and duplicate stop");

    // Normal lifecycle evidence is complete above. Terminate only the child
    // just created by this fixture; both clean and signal exits are unexpected
    // unless requested through the runtime itself.
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const owned = await runtime.start(descriptor);
      assert.equal(owned.status, "running");
      assert(owned.pid);
      process.kill(owned.pid, signal);
      const deadline = Date.now() + 3000;
      while (registry.runtime(descriptor.id).status !== "error" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const exited = registry.runtime(descriptor.id);
      assert.equal(exited.status, "error");
      assert.equal(exited.url, undefined);
      assert.equal(exited.diagnostics?.reason, "unexpected_exit");
      assert.equal(exited.diagnostics?.pid, owned.pid);
      assert.equal(exited.diagnostics?.url, owned.url);
      // Windows process.kill uses TerminateProcess: the child reports an exit code, not a POSIX signal.
      if (process.platform === "win32") {
        assert.equal(exited.diagnostics?.signal, null);
        assert.equal(typeof exited.diagnostics?.exitCode, "number");
      } else {
        assert.equal(exited.diagnostics?.signal, exited.diagnostics?.exitCode === 0 ? null : signal);
        assert(exited.diagnostics?.exitCode === 0 || exited.diagnostics?.exitCode === null);
      }
      assert.equal((await runtime.health(descriptor.id)).status, "error");
      const recovered = await runtime.start(descriptor);
      assert.equal(recovered.status, "running");
      assert.notEqual(recovered.pid, owned.pid);
      await runtime.stop(descriptor.id);
    }
    console.log("PASS unexpected clean/signal exit diagnostics, health, and reopen");

    // The built-in host always returns healthy. Redirect only this fixture's
    // in-memory probe route to a real 404 to exercise degraded-live recovery.
    // No production process, source, or server endpoint is modified.
    const live = await runtime.start(descriptor);
    const internals = runtime as unknown as { instances: Map<string, { state: GadgetRuntimeState }> };
    internals.instances.get(descriptor.id)!.state.url = `${live.url}missing/`;
    const unhealthy = await runtime.health(descriptor.id);
    assert.equal(unhealthy.status, "error");
    assert.equal(unhealthy.url, undefined);
    assert.equal(unhealthy.diagnostics?.reason, "health_failure");
    const repaired = await runtime.start(descriptor);
    assert.equal(repaired.status, "running", "degraded-live reopen must not await its own start");
    assert.notEqual(repaired.pid, live.pid);
    assert.equal(repaired.diagnostics?.reason, "health_failure");
    assert(repaired.diagnostics?.exitedAt);
    assert.match(await (await fetch(repaired.url!)).text(), /isolated runtime fixture/);
    await runtime.stop(descriptor.id);
    console.log("PASS failed HTTP health reaps live child and reopens without deadlock");

    registry.setRuntime({ gadgetId: "orphan-fixture", status: "running", url: "http://127.0.0.1:1/", pid: 1 });
    const orphan = await runtime.health("orphan-fixture");
    assert.equal(orphan.status, "error");
    assert.equal(orphan.url, undefined);
    assert.equal(orphan.diagnostics?.reason, "health_failure");
    console.log("PASS health rejects registry state without an owned process");

    // A manifest error occurs before spawn and must not borrow the previous
    // normal stop's PID, URL, successful exit code, or exit timestamp.
    const previousStop = registry.runtime(descriptor.id);
    assert(previousStop.diagnostics?.pid);
    assert(previousStop.diagnostics?.exitedAt);
    const readManifest = storage.readManifest;
    storage.readManifest = () => { throw new Error("fixture invalid manifest"); };
    try {
      const failed = await runtime.start(descriptor);
      assert.equal(failed.status, "error");
      assert.equal(failed.diagnostics?.reason, "startup_failure");
      assert.equal(failed.diagnostics?.error, "fixture invalid manifest");
      for (const field of ["pid", "url", "exitedAt", "exitCode", "signal", "stderr"] as const) {
        assert.equal(failed.diagnostics?.[field], undefined, `pre-spawn failure inherited ${field}`);
      }
    } finally { storage.readManifest = readManifest; }
    assert.equal((await runtime.start(descriptor)).status, "running");
    await runtime.stop(descriptor.id);
    console.log("PASS pre-spawn failure does not inherit previous exit diagnostics");

    // Startup failure uses an invalid fixture path, never a production process.
    const invalidStorage = { ...storage, paths: () => ({ sourcePath: join(root, "missing") }) } as unknown as GadgetStorage;
    const invalid = new GadgetRuntime(invalidStorage, new GadgetRegistry());
    try {
      const failed = await invalid.start({ id: "invalid-fixture" } as GadgetDescriptor);
      assert.equal(failed.status, "error");
      assert.equal(failed.url, undefined);
      assert.equal(failed.diagnostics?.reason, "startup_failure");
      assert.match(failed.error!, /ENOENT/);
      assert(failed.diagnostics?.exitedAt);
    } finally { await invalid.disposeAll(); }
    console.log("PASS structured startup failure and child cleanup");
  } finally {
    await runtime.disposeAll();
    clearTimeout(guard);
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
