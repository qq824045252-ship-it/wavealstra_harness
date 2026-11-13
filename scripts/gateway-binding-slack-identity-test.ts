import assert from "node:assert/strict";
import { GatewayRouter } from "../src/main/gateway/GatewayRouter";
async function main() {
  let key: string | undefined = "a".repeat(64);
  const events: any[] = [];
  const router = new GatewayRouter({
    adapters: new Map([["slack", { workConnectionKey: () => key }]]),
    isStopping: () => false, slackId: () => "slack", outboundFilter: () => (value: string) => value,
    emitEvent: (event: any) => events.push(event),
  } as any);
  const input = { channelId: "slack", chatId: "chat", text: "fixture", taskId: "task", userMessageId: "user", assistantMessageId: "assistant", sender: { id: "owner" }, slackHistory: { status: "unavailable", errorCode: "missing_scope" }, reply: async () => {} } as any;
  await router.handler()(input);
  assert.equal(events.find(event => event.direction === "in")?.bindingConnectionKey, key);
  assert.equal(events.find(event => event.direction === "in")?.senderId, "owner");
  events.length = 0;
  await assert.rejects(router.handler()({ ...input, workTarget: { connectionKey: "b".repeat(64) } }), /账号已改变/);
  assert.equal(events.length, 0, "mismatched account must not publish sender suggestions");
  key = undefined;
  await assert.rejects(router.handler()(input), /已认证账号身份/);
  assert.equal(events.length, 0, "unknown identity must not publish sender suggestions");
  console.log("gateway Slack binding sender identity PASS");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
