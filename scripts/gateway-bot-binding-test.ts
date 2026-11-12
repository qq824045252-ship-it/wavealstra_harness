import assert from "node:assert/strict";
import { configureGatewayBotBinding } from "../src/main/gateway/GatewayBotBindingSettings";
import { isMainAppWindowRequest } from "../src/main/AppWindowIpc";

const account = "a".repeat(64);
const nextAccount = "b".repeat(64);
const other = { botId: "other-bot", connectionKey: account, ownerSenderIds: ["other-owner"] };
const dependencies = {
  current: { "discord-default": other },
  connectedIdentity: (id: string) => id === "qq-default" ? { connectionKey: account } : undefined,
  ownsActiveBot: (id: string) => id === "bot-A",
};
const input = { action: "bind", channelId: "qq-default", botId: "bot-A", ownerSenderIds: ["owner", "owner"] };
const bound = configureGatewayBotBinding(input, dependencies);
assert.deepEqual(bound, {
  "discord-default": other,
  "qq-default": { botId: "bot-A", connectionKey: account, ownerSenderIds: ["owner"] },
});
assert.deepEqual(dependencies.current, { "discord-default": other }, "caller state is immutable");
assert.throws(() => configureGatewayBotBinding({ ...input, connectionKey: nextAccount }, dependencies));
assert.throws(() => configureGatewayBotBinding({ ...input, ownerSenderIds: [] }, dependencies));
assert.throws(() => configureGatewayBotBinding({ ...input, ownerSenderIds: [" "] }, dependencies));
assert.throws(() => configureGatewayBotBinding({ ...input, botId: "another-users-bot" }, dependencies), /不可用或不属于/);
assert.throws(() => configureGatewayBotBinding({ ...input, channelId: "offline" }, dependencies), /先连接/);
const rebound = configureGatewayBotBinding(input, { ...dependencies, current: bound,
  connectedIdentity: () => ({ connectionKey: nextAccount }) });
assert.equal(rebound["qq-default"].connectionKey, nextAccount, "explicit binding freezes the current verified account");
assert.equal(bound["qq-default"].connectionKey, account, "old account authorization is not silently rewritten");
const removed = configureGatewayBotBinding({ action: "unbind", channelId: "qq-default" }, { ...dependencies, current: rebound });
assert.deepEqual(removed, { "discord-default": other });
assert.deepEqual(configureGatewayBotBinding({ action: "unbind", channelId: "qq-default" }, { ...dependencies, current: removed }), removed);
const frame = { url: "http://localhost:5173/#settings" };
const sender = { isDestroyed: () => false, mainFrame: frame };
const window = { isDestroyed: () => false, webContents: sender };
assert.equal(isMainAppWindowRequest({ sender, senderFrame: frame }, window, "http://localhost:5173/"), true);
assert.equal(isMainAppWindowRequest({ sender, senderFrame: { ...frame } }, window, frame.url), false, "iframe cannot pair identities");
assert.equal(isMainAppWindowRequest({ sender: { ...sender }, senderFrame: frame }, window, frame.url), false, "another renderer cannot pair identities");
assert.equal(isMainAppWindowRequest({ sender, senderFrame: frame }, null, frame.url), false);
assert.equal(isMainAppWindowRequest({ sender, senderFrame: frame }, window, "https://another-origin.invalid"), false);
console.log("gateway-bot-binding: paired owner/account, Bot ownership, malformed inputs and idempotent removal passed");
