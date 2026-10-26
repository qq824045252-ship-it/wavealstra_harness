/**
 * 连接器注册目录的大小写一致性回归测试。
 *
 * 缺陷（Linux/macOS 上必现，Windows 上被 NTFS 大小写不敏感掩盖）：
 *   - `install()` 用连接器包目录名（例如 `demoX`）作为注册目录名；
 *   - `setEnabled()` / `isActive()` / `getPrivateSkillDirs()` 却用 `id.toLowerCase()` 拼路径。
 * 在 ext4/APFS 上 `demoX` ≠ `demox` → 启用/停用报「连接器未安装: demoX」、私有技能不生效。
 *
 * 本用例只用行为断言：安装 → 跨大小写启用/停用 → Active 判定 → 私有技能目录 → 卸载。
 * 所有沙箱写入都在临时 profile 内。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-connector-case-"));
const previousProfile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
// 服务也会从 cwd 发现开发态市场：切到沙箱，避免读到真实仓库市场。
process.chdir(sandbox);

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        results.push({ name, pass: true });
        console.log(`  ✓ ${name}`);
      },
      (error: unknown) => {
        results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) });
        console.log(`  ✗ ${name} — ${error instanceof Error ? error.message : String(error)}`);
      },
    );
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

async function main(): Promise<void> {
  assert.equal(resolve(homedir()), resolve(sandbox), "HOME 必须在导入服务前完成隔离");

  // 混合大小写的连接器包目录名（Windows 上真实市场里常见，例如 demoX / MyTool）
  const mixedId = "FixtureConnector";
  const marketDir = join(sandbox, ".mybuddy", "plugins", "connector-market", "connectors", mixedId);
  put(join(marketDir, "connector-meta.json"), JSON.stringify({ name: "大小写夹具连接器", type: "cli", version: "1.0.0" }));
  put(join(marketDir, "cli.json"), JSON.stringify({ runtime: { type: "node" } }));
  put(
    join(marketDir, "skills", "FixturePrivateSkill", "SKILL.md"),
    `---\nname: FixturePrivateSkill\ndescription: 大小写夹具私有技能\n---\n\n# FixturePrivateSkill\n`,
  );

  const { ConnectorService } = await import("../src/main/connectors/ConnectorService");
  const { getConnectorsDir, getSkillsDir } = await import("../src/main/paths");
  const connectors = new ConnectorService();

  await check("市场里能发现混合大小写的连接器包", () => {
    const dto = connectors.list().find((item) => item.name === "大小写夹具连接器");
    assert.ok(dto, "连接器包未被发现");
    assert.equal(dto!.id, mixedId, "list() 应保留包目录名的大小写");
    assert.equal(dto!.installed, false);
  });

  await check("用小写 id 安装混合大小写连接器后注册目录唯一（归一化）", () => {
    assert.deepEqual(connectors.install(mixedId.toLowerCase()), ["fixtureprivateskill"]);
    const registered = connectors.list().find((item) => item.id === mixedId)!;
    assert.equal(registered.installed, true, "安装后 list() 应报告 installed");
    assert.equal(registered.enabled, true, "新安装默认启用");
    // 注册目录只有一份，且与大小写无关（Linux 上若建成两个目录这里会变 2）
    const dirs = readdirSync(getConnectorsDir());
    assert.equal(dirs.length, 1, `注册目录应唯一，实际 ${JSON.stringify(dirs)}`);
    assert.equal(existsSync(join(getConnectorsDir(), dirs[0], "meta.json")), true);
  });

  await check("跨大小写启用/停用（旧实现 setEnabled 会抛「连接器未安装」）", () => {
    connectors.setEnabled("FIXTURECONNECTOR", false);
    assert.equal(connectors.isActive(mixedId), false, "停用后 isActive 应为 false");
    assert.equal(connectors.list().find((item) => item.id === mixedId)?.enabled, false);
    connectors.setEnabled(mixedId.toLowerCase(), true);
    assert.equal(connectors.isActive("fixtureconnector"), true, "重新启用后 isActive 应为 true");
  });

  await check("私有技能目录大小写不敏感解析", () => {
    const dirs = connectors.getPrivateSkillDirs(["fixtureconnector"]);
    assert.equal(dirs.length, 1, `应解析出 1 个私有技能目录，实际 ${JSON.stringify(dirs)}`);
    assert.ok(existsSync(join(dirs[0], "fixtureprivateskill", "SKILL.md")), "私有技能目录内容应存在");
    // 停用后不进入候选技能集
    connectors.setEnabled(mixedId, false);
    assert.deepEqual(connectors.getPrivateSkillDirs([mixedId]), [], "停用的连接器不得提供私有技能");
    connectors.setEnabled(mixedId, true);
  });

  await check("卸载用任意大小写都能命中注册目录", () => {
    connectors.uninstall("fixtureCONNECTOR");
    const dto = connectors.list().find((item) => item.id === mixedId)!;
    assert.equal(dto.installed, false, "卸载后 installed 应为 false");
    assert.equal(existsSync(join(getConnectorsDir(), mixedId.toLowerCase())), false, "注册目录应被移除");
    // 全局技能目录不残留副本
    assert.equal(existsSync(join(getSkillsDir(), "fixtureprivateskill")), false);
  });

  const failed = results.filter((item) => !item.pass).length;
  console.log(`\nconnector-id-case: ${results.length - failed}/${results.length} PASS`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
