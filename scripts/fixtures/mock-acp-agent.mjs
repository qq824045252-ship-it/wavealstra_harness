import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// Behavior is selected per spawned process so one fixture can exercise the
// whole ExternalAgentRuntime matrix without extra files.
const behavior = process.env.MOCK_ACP_BEHAVIOR || "default";
const state = { authed: false, cancelled: false, cancelResolve: null };

const capabilities = behavior === "load"
  ? { loadSession: true }
  : behavior === "neither"
    ? {}
    : { loadSession: false, sessionCapabilities: { resume: {} } };

const authMethods = behavior === "auth"
  ? [{ id: "mock-oauth", name: "Mock OAuth", description: "fixture auth method" }]
  : [];

// Session config options (model select + boolean toggle) advertised by every
// session-open response; set_config_option validates and mutates them in place.
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "mock/model-a",
    options: [
      { value: "mock/model-a", name: "Mock Model A" },
      { value: "mock/model-b", name: "Mock Model B" },
    ],
  },
  {
    id: "tier",
    name: "Tier",
    type: "select",
    currentValue: "mock/tier-x",
    // ACP spec: options is either all values or all groups — exercise the group shape.
    options: [
      {
        group: "g1",
        name: "Group One",
        options: [
          { value: "mock/tier-x", name: "Tier X" },
          { value: "mock/tier-y", name: "Tier Y" },
        ],
      },
    ],
  },
  { id: "fast", name: "Fast", type: "boolean", currentValue: false },
];

const app = acp.agent({ name: "mybuddy-mock-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: capabilities,
    authMethods,
  }))
  .onRequest(acp.methods.agent.authenticate, (ctx) => {
    if (ctx.params.methodId === "mock-oauth") state.authed = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, () => {
    if (behavior === "auth" && !state.authed) throw new Error("Authentication required");
    return { sessionId: "mock-session-1", configOptions };
  })
  .onRequest(acp.methods.agent.session.resume, () => ({ configOptions }))
  .onRequest(acp.methods.agent.session.load, () => ({ configOptions }))
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => {
    const { configId, value } = ctx.params;
    const option = configOptions.find((item) => item.id === configId);
    if (!option) throw new Error(`unknown config option ${configId}`);
    if (option.type === "boolean") {
      option.currentValue = ctx.params.type === "boolean" && value === true;
    } else {
      const flat = option.options.flatMap((item) => item.options ?? [item]);
      if (!flat.some((item) => item.value === value)) throw new Error(`invalid value ${value}`);
      option.currentValue = value;
    }
    return { configOptions };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    if (behavior === "crash") {
      console.error("mock-crash-signal");
      process.exit(3);
    }
    if (behavior === "hang") {
      await new Promise((resolve) => {
        if (state.cancelled) return resolve();
        state.cancelResolve = resolve;
      });
      return { stopReason: "cancelled" };
    }

    const notify = (update) => ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update,
    });

    // Exercise the Devin diagnostics shim end-to-end; a real non-Devin client
    // would reject this extension method.
    let diag = "diag-miss";
    try {
      await ctx.client.request("_cognition.ai/request_diagnostics", {});
      diag = "diag-ok";
    } catch { /* client does not implement the extension */ }
    await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `mock-chunk ${diag}` } });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: ` model=${configOptions.find((item) => item.id === "model")?.currentValue},fast=${configOptions.find((item) => item.id === "fast")?.currentValue}`,
      },
    });

    if (behavior === "toolcall") {
      await notify({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "Mock tool",
        kind: "execute",
        status: "in_progress",
        rawInput: { cmd: "echo hi" },
      });
      await notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        rawOutput: { out: "hi" },
      });
      return { stopReason: "end_turn" };
    }

    if (behavior !== "default" && behavior !== "auth") {
      return { stopReason: "end_turn" };
    }

    const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
      sessionId: ctx.params.sessionId,
      toolCall: {
        toolCallId: "permission-tool",
        title: "Permission tool",
        name: "mock-tool",
        kind: "execute",
      },
      options: [
        { kind: "allow_once", name: "Allow once", optionId: "allow" },
        { kind: "reject_once", name: "Reject once", optionId: "reject" },
      ],
    });

    await notify({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: permission.outcome.outcome === "selected"
          ? ` permission-selected-${permission.outcome.optionId}`
          : " permission-cancelled",
      },
    });
    if (state.authed) {
      await notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " authed-via-mock" } });
    }
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, () => {
    state.cancelled = true;
    state.cancelResolve?.();
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
app.connect(stream);
