/** Deterministic regression: executeTool()-era Code Mode logs carry nested calls in tool-result details.calls. */
import { procedureExecution } from "../src/main/memory/MemoryProcedureEvidence";
import assert from "node:assert/strict";
import { durableCompletedTurns } from "../src/main/agent/durable/DurableTurnProjection";
import { durableInputAuditSchema } from "../src/main/agent/durable/DurableSkillProjection";
import { DOTS_TASK_ID } from "../src/shared/dots";

const entries: any[] = [
  { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "BOT_EVIDENCE" }], timestamp: 1 }] },
  { id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "call-codemode", name: "codemode", arguments: { code: "await tools.write({}); await tools.bash({});" } }], stopReason: "toolUse", timestamp: 2 }] },
  { id: 3, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "call-codemode", toolName: "codemode", content: [{ type: "text", text: "script done" }], isError: false, timestamp: 3,
    details: { calls: [
      { id: "nested-write", name: "write", args: { path: "proof.txt", content: "x" }, status: "ok", output: "written" },
      { id: "nested-bash", name: "bash", args: { command: "printf EVIDENCE" }, status: "ok", output: "EVIDENCE" },
    ] } }] },
  { id: 4, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 4 }] },
];

const turns = durableCompletedTurns("task-evidence", "7", entries);
assert.equal(turns.length, 1, "one completed turn");
const tools = procedureExecution(turns[0].metadata ?? {})?.tools ?? [];
const names = tools.map((tool: any) => tool.name);
assert(names.includes("bash") && names.includes("write"), "nested calls become procedure evidence: " + JSON.stringify(names));
assert(tools.filter((tool: any) => tool.name === "bash" || tool.name === "write").every((tool: any) => tool.result.length > 0), "nested output is retained");
assert.equal(turns[0].userText, "BOT_EVIDENCE");
const audit = durableInputAuditSchema.parse({ userMessageId: "private-input", assistantMessageId: "private-output", cwd: ".", skills: [],
  recommendation: { query: "private", mode: "general", context: { memoryIds: [], scenarioIds: [], profileIds: [] }, capabilities: [] },
  skipMemoryCapture: true });
const privateTurns = durableCompletedTurns(DOTS_TASK_ID, "7", entries, new Map(), new Map([[1, { audit, text: "private" }]]));
assert.equal(privateTurns.length, 1);
assert.equal(privateTurns[0].skipCapture, true);
assert.equal(privateTurns[0].userText, "");
assert.equal(procedureExecution(privateTurns[0].metadata ?? {}), undefined);
console.log("durable turn evidence test passed");
