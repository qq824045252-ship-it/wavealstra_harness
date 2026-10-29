/**
 * 多电脑切换回归测试：两台电脑都要能持久保留、来回切换。
 * 覆盖的正是「切到另一台就切不回来」的根因 —— saveConfig 与旧 saveToken 共用键位互相覆盖。
 */
import { strict as assert } from "node:assert";
import { __prefs } from "./capacitor-stub";
import {
  getActiveServer,
  loadServerConfig,
  removeServer,
  saveServerConfig,
  setActiveServerId,
  upsertServer,
} from "../app/remote/src/api/credentialStore";

const A = { name: "办公室工作站", baseUrl: "https://a.example.com", deviceToken: "token-a" };
const B = { name: "家里主机", baseUrl: "https://b.example.com", deviceToken: "token-b" };

const fresh = await loadServerConfig();
assert.deepEqual(fresh.servers, [], "初始应为空列表");

const first = await upsertServer(A);
assert.equal(first.config.servers.length, 1);
assert.equal(getActiveServer(first.config)?.baseUrl, A.baseUrl);

const second = await upsertServer(B);
assert.equal(second.config.servers.length, 2, "配对第二台后应保留两台");
assert.equal(getActiveServer(second.config)?.baseUrl, B.baseUrl);

// 关键回归点：重新加载（等价于冷启动 / 打开连接设置页刷新）两台都还在
const reloaded = await loadServerConfig();
assert.equal(reloaded.servers.length, 2, "重新加载后不得退化成一台");
assert.deepEqual(reloaded.servers.map((s) => s.baseUrl).sort(), [A.baseUrl, B.baseUrl]);
assert.equal(getActiveServer(reloaded)?.baseUrl, B.baseUrl, "当前电脑应仍是 B");

// 切回 A
const backToA = await setActiveServerId(reloaded.servers.find((s) => s.baseUrl === A.baseUrl)!.id);
assert.equal(getActiveServer(backToA)?.baseUrl, A.baseUrl, "应能切回 A");
assert.equal(backToA.servers.length, 2, "切换不得丢服务器");

// 再切回 B（来回切）
const againB = await loadServerConfig();
const backToB = await setActiveServerId(againB.servers.find((s) => s.baseUrl === B.baseUrl)!.id);
assert.equal(getActiveServer(backToB)?.baseUrl, B.baseUrl, "应能再切回 B");
assert.equal(backToB.servers.length, 2);

// 旧逻辑若还在：saveToken 会写 ciphertext，把列表冲掉。这里显式校验两条通道互不干扰
assert.ok(__prefs.has("config_ciphertext"), "配置必须写在独立键位");
assert.equal(__prefs.has("ciphertext"), false, "不得再写旧版单条凭据键位");

// 防御不变量：任何一次“变短”的保存都不得静默丢服务器（历史上镜像写入就是这么丢的）
await saveServerConfig({ activeServerId: backToB.servers.find((s) => s.baseUrl === A.baseUrl)!.id, servers: [backToB.servers.find((s) => s.baseUrl === A.baseUrl)!] });
const guarded = await loadServerConfig();
assert.equal(guarded.servers.length, 2, "非显式删除的保存不得减少服务器数量");

// 删除一台后只剩另一台，且 active 自动落位
const afterRemove = await removeServer(backToB.servers.find((s) => s.baseUrl === B.baseUrl)!.id);
assert.equal(afterRemove.servers.length, 1);
assert.equal(getActiveServer(afterRemove)?.baseUrl, A.baseUrl);

// 旧版单条凭据迁移：老装机升级后不能丢已配对的那台
__prefs.clear();
__prefs.set("ciphertext", JSON.stringify({ baseUrl: "https://legacy.example.com", deviceToken: "token-legacy" }));
__prefs.set("iv", "iv");
const migrated = await loadServerConfig();
assert.equal(migrated.servers.length, 1, "旧版单条凭据应迁移成一台");
assert.equal(migrated.servers[0]?.baseUrl, "https://legacy.example.com");
assert.equal(migrated.servers[0]?.deviceToken, "token-legacy");

console.log("remote multi-server switching tests passed");
