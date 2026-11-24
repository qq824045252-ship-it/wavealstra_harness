import type { GadgetBackend, GadgetBackendContext, GadgetJson, GadgetValues } from "../../shared/gadget-backend";
import type { GadgetCommandRunner } from "../platform/gadget-commands";

/** Serialized into the Gadget host. All protocol state belongs to this process instance. */
export async function startGadgetProcessBackend(
  { child, stop }: ReturnType<GadgetCommandRunner["open"]>,
  operate: (values: GadgetValues, input: Record<string, unknown>) => Promise<unknown>,
  onFailure: (message: string) => void,
): Promise<GadgetBackend> {
  const frameLimit = 1024 * 1024 + 16 * 1024;
  const callLimit = 8;
  type Call = {
    context: GadgetBackendContext;
    reject: (error: Error) => void;
    resolve: (value: GadgetJson) => void;
    cancel: () => void;
    usingHost: boolean;
  };
  const pending = new Map<number, Call>();
  const error = (code: string, message: string, status: number) => Object.assign(new Error(message), { code, status });
  const badFrame = () => error("PROCESS_PROTOCOL", "Gadget 后台发送了无效的协议消息", 502);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const frame = Buffer.allocUnsafe(frameLimit);
  let frameBytes = 0;
  let nextCall = 0;
  let stopped = false;
  let started = false;
  let exited = false;
  let ready: (actions: string[]) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const readiness = new Promise<string[]>((resolve, reject) => { ready = resolve; rejectReady = reject; });

  function finish(id: number): Call | undefined {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    call.context.signal.removeEventListener("abort", call.cancel);
    return call;
  }
  function close(reason: Error): void {
    stopped = true;
    clearTimeout(deadline);
    rejectReady(reason);
    for (const id of pending.keys()) finish(id)?.reject(reason);
  }
  function fail(reason: Error): void {
    if (stopped) return;
    close(reason);
    if (started) onFailure(reason.message);
  }
  function send(message: Record<string, unknown>): void {
    const line = JSON.stringify(message) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > frameLimit || child.stdin.writableLength + bytes > frameLimit * callLimit) {
      throw error("PROCESS_FRAME_LIMIT", "Gadget 后台协议消息超过容量限制", 413);
    }
    child.stdin.write(line);
  }
  async function handleHostCall(message: Record<string, unknown>, id: number, call: Call | undefined): Promise<void> {
    const reply = { type: "hostResult", id, call: message.call };
    if (!call || call.context.signal.aborted) {
      send({ ...reply, error: "CANCELLED" });
      return;
    }
    const scope = message.scope;
    if ((scope !== "storage" && scope !== "config") || call.usingHost) {
      send({ ...reply, error: "INVALID_REQUEST" });
      return;
    }
    call.usingHost = true;
    let result: Record<string, unknown>;
    try {
      result = { value: (await operate(call.context[scope], message)) ?? null };
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      result = { error: code === "REVISION_CONFLICT" || code === "INVALID_JSON" ? code : "HOST_CALL_FAILED" };
    } finally {
      call.usingHost = false;
    }
    if (!stopped) send({ ...reply, ...(call.context.signal.aborted ? { error: "CANCELLED" } : result) });
  }
  function receive(frame: Buffer): void {
    const data: unknown = JSON.parse(decoder.decode(frame));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw badFrame();
    const message = data as Record<string, unknown>;
    if (!started) {
      const actions: unknown = message.actions;
      if (message.type !== "ready" || message.version !== 1 || !Array.isArray(actions) || actions.length > 128 ||
        actions.some(name => typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(name)) ||
        new Set(actions).size !== actions.length) throw badFrame();
      started = true;
      clearTimeout(deadline);
      ready(actions);
      return;
    }
    const id = message.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw badFrame();
    if (message.type === "host") {
      if (typeof message.call !== "number" || !Number.isSafeInteger(message.call) || message.call <= 0) throw badFrame();
      void handleHostCall(message, id, pending.get(message.call)).catch(() => fail(badFrame()));
      return;
    }
    if (message.type === "result" && Object.hasOwn(message, "value")) {
      finish(id)?.resolve(message.value as GadgetJson);
    } else if (message.type === "error") {
      finish(id)?.reject(error("PROCESS_ACTION_FAILED", "Gadget 后台操作失败", 422));
    } else {
      throw badFrame();
    }
  }

  const deadline = setTimeout(() => fail(error("PROCESS_NOT_READY", "Gadget 后台未在启动期限内发出 ready 消息", 502)), 5_000);
  child.stderr.resume();
  child.on("error", () => fail(error("PROCESS_SPAWN_FAILED", "无法启动 Gadget 后台程序", 502)));
  child.stdin.on("error", () => fail(error("PROCESS_CHANNEL_CLOSED", "Gadget 后台输入通道已关闭", 502)));
  child.stdout.on("error", () => fail(error("PROCESS_CHANNEL_CLOSED", "Gadget 后台输出通道已关闭", 502)));
  child.once("exit", (code, signal) => {
    exited = true;
    fail(error("PROCESS_EXITED", `Gadget 后台已退出（code=${code}, signal=${signal ?? "none"}）`, 502));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (let offset = 0; !stopped && offset < chunk.length;) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const nextSize = frameBytes + end - offset;
        if (nextSize > frameLimit) throw badFrame();
        chunk.copy(frame, frameBytes, offset, end);
        frameBytes = nextSize;
        if (newline === -1) return;
        receive(frame.subarray(0, frameBytes));
        frameBytes = 0;
        offset = end + 1;
      }
    } catch {
      fail(badFrame());
    }
  });
  try {
    const actions = await readiness;
    if (stopped) throw badFrame();
    return {
      actions: Object.fromEntries(actions.map(action => [action, (input: GadgetJson, context: GadgetBackendContext) => {
        if (stopped) throw error("PROCESS_CHANNEL_CLOSED", "Gadget 后台已关闭", 502);
        if (pending.size >= callLimit) throw error("BUSY", "Gadget 正在处理过多请求，请稍后再试", 429);
        context.signal.throwIfAborted();
        const id = ++nextCall;
        return new Promise<GadgetJson>((resolve, reject) => {
          const cancel = () => {
            // The host watchdog must still see a pending action until the worker acknowledges.
            try { send({ type: "cancel", id }); } catch { fail(badFrame()); }
          };
          pending.set(id, { context, resolve, reject, cancel, usingHost: false });
          context.signal.addEventListener("abort", cancel, { once: true });
          try { send({ type: "call", id, action, input }); }
          catch (cause) { finish(id); reject(cause); }
        });
      }])),
      async dispose() {
        if (!stopped) {
          close(error("STOPPING", "Gadget 已停止", 503));
          if (!exited) {
            try { send({ type: "shutdown" }); } catch { /* Force cleanup still runs below. */ }
            await new Promise<void>(resolve => {
              const done = () => { clearTimeout(timer); child.off("exit", done); resolve(); };
              const timer = setTimeout(done, 150);
              child.once("exit", done);
            });
          }
        }
        await stop();
      },
    };
  } catch (cause) {
    await stop();
    throw cause;
  }
}
