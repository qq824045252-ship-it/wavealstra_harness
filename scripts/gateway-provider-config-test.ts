import assert from "node:assert/strict";
import { validateGatewayProviderConfig, sealGatewayProviderConfig, openGatewayProviderConfig,
  gatewayProviderConfigView } from "../src/main/gateway/GatewayProviderConfig";
import { setEncryptionAvailable } from "./gateway-electron-stub";
import { gatewayWorkTarget } from "../src/main/gateway/work-outbound";
import { GatewayService } from "../src/main/gateway/GatewayService";
import { DiscordGatewayAdapter } from "../src/main/gateway/DiscordGatewayAdapter";
import type { GatewayInboundHandler } from "../src/main/gateway/channels";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [type, config, secret] of [
  ["dingtalk", { clientId: "client", clientSecret: "ding-secret", corpId: "corp", robotCode: "robot", allowUsers: ["staff"] }, "clientSecret"],
  ["discord", { applicationId: "123", botToken: "discord-secret", guildIds: ["456"], allowDirectMessages: false, allowUsers: ["789"] }, "botToken"],
] as const) {
  const valid = validateGatewayProviderConfig(type, { ...config, allowUsers: [...config.allowUsers], malicious: "never persist" });
  assert.equal(valid.malicious, undefined);
  assert.throws(() => validateGatewayProviderConfig(type, { ...valid, allowUsers: [] }));
  assert.throws(() => validateGatewayProviderConfig(type, { ...valid, [secret]: "••••••" }));
  const stored = sealGatewayProviderConfig(type, valid);
  assert.equal(stored[secret], undefined);
  const view = gatewayProviderConfigView(type, stored);
  assert.equal(view[secret], "••••••"); assert.equal(view.encryptedSecrets, undefined);
  assert.equal(openGatewayProviderConfig(type, stored)[secret], config[secret]);
  setEncryptionAvailable(false);
  assert.throws(() => sealGatewayProviderConfig(type, valid));
  assert.throws(() => openGatewayProviderConfig(type, stored));
  setEncryptionAvailable(true);
  assert.equal(gatewayWorkTarget({ version: 1, channelId: `${type}-default`, channelType: type,
    connectionKey: "a".repeat(64), chatId: "chat", senderId: "sender", address: { chatId: "chat" } }), undefined);
}
assert.throws(() => validateGatewayProviderConfig("discord", { applicationId: "123", botToken: "token", allowUsers: ["123"], guildIds: [], allowDirectMessages: false }));

class TestDiscord extends DiscordGatewayAdapter {
  live = false; active = false; handler?: GatewayInboundHandler;
  override setInboundHandler(handler: GatewayInboundHandler): void { this.handler = handler; }
  override async connect(): Promise<void> { this.live = true; }
  override activate(): void { this.active = true; }
  override async disconnect(): Promise<void> { this.live = false; this.active = false; }
  override isConnected(): boolean { return this.live; }
  override workConnectionKey(): string | undefined { return this.live && this.active ? "a".repeat(64) : undefined; }
}
const root = mkdtempSync(join(tmpdir(), "gateway-providers-"));
const db = new AppDatabase(join(root, "test.db"));
const adapter = new TestDiscord("discord-default", "Discord");
let turns = 0;
const service = new GatewayService(db, { runGatewayTurn: async () => { turns++; throw new Error("unused"); } }, undefined,
  { adapters: { discord: adapter } });
try {
  assert.deepEqual(service.listChannels().map(c => c.type).sort(), ["dingtalk", "discord", "feishu", "slack", "telegram", "wechat", "wecom"]);
  const config = { applicationId: "123", botToken: "secret-token", guildIds: ["456"], allowDirectMessages: false, allowUsers: ["789"] };
  await service.connect("discord-default", config);
  assert.equal(adapter.active, true);
  assert.equal((service as unknown as { webhookServer: unknown }).webhookServer, null);
  assert.equal(service.getChannelConfig("discord-default").config.botToken, "••••••");
  assert.equal(JSON.parse(db.listGatewayChannels().find(c => c.id === "discord-default")!.configJson).botToken, undefined);
  await adapter.handler!({ channelId: adapter.id, chatId: "456", sender: { id: "not-allowed" }, text: "ignored", reply: async () => {} });
  assert.equal(turns, 0);
  await service.connect("discord-default", { ...config, botToken: "••••••" });
  await service.stop();
  await service.restoreChannels();
  assert.equal(adapter.active, true);
  assert.equal((service as unknown as { webhookServer: unknown }).webhookServer, null);
  await service.disconnect("discord-default");
  assert.equal(service.getChannelConfig("discord-default").config.botToken, "••••••");
  assert.equal(adapter.live, false);
  await assert.rejects(() => adapter.handler!({ channelId: adapter.id, chatId: "456", sender: { id: "789" }, text: "stale", reply: async () => {} }));
} finally { await service.stop(); db.close(); rmSync(root, { recursive: true, force: true }); }
console.log("gateway provider configuration and registration: PASS");
