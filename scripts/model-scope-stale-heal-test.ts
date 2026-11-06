/** enabledModels 悬空引用自愈：模型列表的读取边界必须清掉指向目录里不存在模型的
 * 引用（网关下线的 id / 拼写错误），否则每次 scope 解析都打 no-match 警告，而设置页
 * 又渲染不出这一行，用户无法手动关掉。真正的 Provider 夹具 + 真实 AgentService。 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mybuddy-model-scope-heal-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const config = join(root, ".mybuddy");
process.env.PI_CODING_AGENT_DIR = config;
mkdirSync(config, { recursive: true });
mkdirSync(join(config, ".."), { recursive: true });

const modelEntry = (id: string) => ({
  id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
writeFileSync(join(config, "models.json"), JSON.stringify({
  providers: {
    fixture: {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key",
      models: [modelEntry("live")],
    },
    // 目录里有、但没有任何凭证：getAvailable() 不含它，enabledModels 的显式选择必须保留。
    unlinked: {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
      models: [modelEntry("offline")],
    },
  },
}));
writeFileSync(join(config, "auth.json"), "{}");

const settingsPath = join(config, "settings.json");
const writeSettings = (value: Record<string, unknown>): void => {
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "fixture", defaultModel: "live", ...value }, null, 2));
};
const readSettings = (): Record<string, any> => JSON.parse(readFileSync(settingsPath, "utf8"));

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { AgentService } = await import("../src/main/agent/AgentService");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");

const db = new AppDatabase(join(root, "app.db"));
const runtime = await ModelRuntime.create({
  authPath: join(config, "auth.json"), modelsPath: join(config, "models.json"),
  modelsStorePath: join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false,
});
const agent = new AgentService(db, new TaskExecutionWorkspace(join(root, "workspaces")), { models: runtime });

try {
  await agent.init();
  await agent.resumePersistedTasks();

  // 1. 已下线 id（含 :level 后缀）与失效思考偏好一起清掉；目录中存在的引用（含无凭证）保留。
  writeSettings({
    enabledModels: ["fixture/live", "fixture/retired", "fixture/retired:high", "unlinked/offline"],
    modelThinkingLevels: { "fixture/retired": "high", "fixture/live": "low" },
  });
  const models = await agent.listModels();
  let settings = readSettings();
  assert.deepEqual(settings.enabledModels, ["fixture/live", "unlinked/offline"],
    "指向不存在模型的引用必须被清掉，目录中的引用（含无凭证）必须保留");
  assert.deepEqual(settings.modelThinkingLevels, { "fixture/live": "low" },
    "失效模型的思考偏好必须一起清掉");
  assert(models.some((model) => model.id === "fixture/live" && model.enabled !== false),
    "清掉悬空引用不能影响真实模型");

  // 2. 收敛后不再重写文件：同一份列表第二次读取必须逐字节不变。
  const settled = readFileSync(settingsPath, "utf8");
  await agent.listModels();
  assert.equal(readFileSync(settingsPath, "utf8"), settled, "没有悬空引用时不得重写 settings.json");

  // 3. 全部启用项都失效时保留原列表：[] 会被读成「全部禁用」。
  writeSettings({ enabledModels: ["fixture/retired"] });
  await agent.listModels();
  assert.deepEqual(readSettings().enabledModels, ["fixture/retired"],
    "失效引用覆盖全部启用项时必须保留列表，不能变成「全部禁用」");

  // 4. Provider 停用/启用不得把已下线模型重新写回 enabledModels。
  writeSettings({ enabledModels: ["fixture/live", "fixture/retired"] });
  await agent.listModels();
  await agent.setProviderEnabled("fixture", false);
  await agent.setProviderEnabled("fixture", true);
  settings = readSettings();
  assert(!(settings.enabledModels ?? []).includes("fixture/retired"),
    "重新启用 Provider 不能复活已下线的模型引用");
  assert.deepEqual(settings.enabledModels, ["fixture/live"], "原有可用模型必须回到启用列表");

  console.log(JSON.stringify({ suite: "model-scope-stale-heal", passed: 4 }));
} finally {
  agent.dispose();
  db.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows 仍持有句柄时留给临时目录 */ }
}
