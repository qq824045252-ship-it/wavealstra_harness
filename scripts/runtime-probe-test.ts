import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { RuntimeProbeService } from "../src/main/capabilities/RuntimeProbeService";

class FakeWebContents extends EventEmitter {
  id = 42;
  destroyed = false;
  crashed = false;
  loading = false;
  url = "file:///mybuddy/index.html";
  title = "MyBuddy";
  pid = 4242;

  isDestroyed(): boolean { return this.destroyed; }
  isCrashed(): boolean { return this.crashed; }
  isLoading(): boolean { return this.loading; }
  getURL(): string { return this.url; }
  getTitle(): string { return this.title; }
  getOSProcessId(): number { return this.pid; }
  async executeJavaScript(script: string): Promise<unknown> {
    if (script.includes("document.activeElement")) {
      return {
        readyState: "complete",
        visibility: "visible",
        hasFocus: true,
        focused: { tag: "button", id: "save", role: "button", name: "Save", text: "Save" },
      };
    }
    return "installed";
  }
}

class HangingWebContents extends FakeWebContents {
  override async executeJavaScript(): Promise<unknown> {
    return await new Promise<unknown>(() => undefined);
  }
}

async function main(): Promise<void> {
  const service = new RuntimeProbeService();
  const fake = new FakeWebContents();
  const wc = fake as unknown as WebContents;

  service.attach("app", wc);
  assert.equal(service.available("app"), true);

  const status = await service.execute({ action: "status", target: "app" });
  assert.equal(status.state?.available, true);
  assert.equal(status.state?.rendererPid, 4242);
  assert.equal(status.state?.documentHasFocus, true);
  assert.equal(status.state?.focusedElement?.id, "save");
  assert.equal(status.state?.documentObservation, "ready");

  const mark = await service.execute({ action: "mark", target: "app" });
  assert.equal(typeof mark.marker, "number");
  const marker = mark.marker ?? 0;

  fake.emit("console-message", {
    message: "plain warning",
    level: "warning",
    lineNumber: 12,
    sourceId: "app.js",
  }, 2, "legacy warning", 12, "app.js");
  fake.emit("console-message", {
    message: "[MYBUDDY_RUNTIME_ERROR] click exploded",
    level: "error",
    lineNumber: 99,
    sourceId: "ui.js",
  }, 3, "legacy error", 99, "ui.js");
  fake.emit("did-navigate", {}, "file:///mybuddy/settings");
  fake.emit("did-fail-load", {}, -3, "ERR_ABORTED", "file:///ignored", true);
  fake.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "https://bad.invalid", true);
  fake.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 });

  const after = await service.execute({
    action: "read",
    target: "app",
    afterSequence: marker,
    levels: ["warning", "error", "info"],
    limit: 20,
  });
  const events = after.events ?? [];
  assert(events.some((event) => event.kind === "console" && event.message === "plain warning"));
  assert(events.some((event) => event.kind === "runtime-error" && event.message.includes("click exploded")));
  assert(events.some((event) => event.kind === "navigation" && event.url === "file:///mybuddy/settings"));
  assert(!events.some((event) => event.url === "file:///ignored"), "ERR_ABORTED must not be reported as a load failure");
  assert(events.some((event) => event.kind === "load" && event.detail?.errorCode === -105));
  assert(events.some((event) => event.kind === "process" && event.detail?.exitCode === 9));

  const onlyRuntimeErrors = await service.execute({
    action: "read",
    target: "app",
    afterSequence: marker,
    kinds: ["runtime-error"],
  });
  assert.equal(onlyRuntimeErrors.events?.length, 1);

  service.detach("app", wc);
  assert.equal(service.available("app"), false);
  const detached = await service.execute({ action: "status", target: "app" });
  assert.equal(detached.state?.available, false);

  const hanging = new HangingWebContents();
  const hangingWc = hanging as unknown as WebContents;
  service.attach("browser", hangingWc);
  const started = Date.now();
  const partial = await service.execute({ action: "mark", target: "browser" });
  const elapsed = Date.now() - started;
  assert(elapsed >= 900 && elapsed < 1_800, `hanging renderer observation should time out promptly, got ${elapsed}ms`);
  assert.equal(partial.state?.available, true);
  assert.equal(partial.state?.documentObservation, "unavailable");
  assert.equal(typeof partial.marker, "number");
  service.detach("browser", hangingWc);

  console.log("runtime probe: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
