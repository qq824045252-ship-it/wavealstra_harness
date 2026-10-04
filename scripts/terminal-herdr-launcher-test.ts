import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  myBuddyHerdrSessionName,
  myBuddyHerdrEnv,
  prepareHerdrWorkspace,
  projectMyBuddySkillsToCliRoots,
  type HerdrCommandRunner,
  type HerdrServerStarter,
  type SharedSkillProjector,
} from "../src/main/terminal/HerdrLauncher";

interface Call {
  args: string[];
  cwd: string;
}

function fakeRunner(responses: Array<string | Error>): { runner: HerdrCommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: HerdrCommandRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error(`unexpected Herdr call: ${args.join(" ")}`);
    return next;
  };
  return { runner, calls };
}

const noProjection: SharedSkillProjector = () => ({ created: 0, existing: 0, collisions: [], errors: [] });

async function main(): Promise<void> {
  let passed = 0;
  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  };
  const noSleep = async (): Promise<void> => undefined;
  const workspaceId = "space-alpha-001";
  const sessionName = myBuddyHerdrSessionName(workspaceId);

  await run("Herdr process env exposes MyBuddy bin first", async () => {
    const base = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin";
    const env = myBuddyHerdrEnv({ PATH: base });
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const first = String(env[pathKey] ?? "").split(process.platform === "win32" ? ";" : ":")[0];
    assert.match(first.replace(/\\/g, "/"), /\.mybuddy\/bin$/);
  });

  await run("MyBuddy workspace → 稳定且隔离的 Herdr session 名", async () => {
    assert.match(sessionName, /^mybuddy-[a-f0-9]{16}$/);
    assert.equal(myBuddyHerdrSessionName(workspaceId), sessionName);
    assert.notEqual(myBuddyHerdrSessionName("space-beta-002"), sessionName);
  });

  await run("共享 Skill：补缺失链接、保留 CLI 自有同名目录、重复执行幂等", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-herdr-skills-"));
    try {
      const sourceRoot = join(sandbox, ".mybuddy", "skills");
      const roots = [
        join(sandbox, ".agents", "skills"),
        join(sandbox, ".claude", "skills"),
        join(sandbox, ".hermes", "skills"),
      ];
      mkdirSync(join(sourceRoot, "alpha"), { recursive: true });
      mkdirSync(join(sourceRoot, "beta"), { recursive: true });
      mkdirSync(join(sourceRoot, "resource-pack"), { recursive: true });
      writeFileSync(join(sourceRoot, "alpha", "SKILL.md"), "# alpha\n", "utf8");
      writeFileSync(join(sourceRoot, "beta", "skill.md"), "# beta\n", "utf8");
      writeFileSync(join(sourceRoot, "resource-pack", "README.md"), "not a skill\n", "utf8");

      const collisionDir = join(roots[0], "beta");
      mkdirSync(collisionDir, { recursive: true });
      writeFileSync(join(collisionDir, "SKILL.md"), "# cli-owned beta\n", "utf8");

      const first = projectMyBuddySkillsToCliRoots(sourceRoot, roots);
      assert.equal(first.created, 5);
      assert.equal(first.existing, 0);
      assert.deepEqual(first.collisions, [collisionDir]);
      assert.deepEqual(first.errors, []);
      assert.equal(realpathSync(join(roots[0], "alpha")), realpathSync(join(sourceRoot, "alpha")));
      assert.equal(realpathSync(join(roots[1], "beta")), realpathSync(join(sourceRoot, "beta")));
      assert.equal(readFileSync(join(collisionDir, "SKILL.md"), "utf8"), "# cli-owned beta\n");
      assert.equal(realpathSync(join(roots[2], "alpha")), realpathSync(join(sourceRoot, "alpha")));

      const second = projectMyBuddySkillsToCliRoots(sourceRoot, roots);
      assert.equal(second.created, 0);
      assert.equal(second.existing, 5);
      assert.deepEqual(second.collisions, [collisionDir]);
      assert.deepEqual(second.errors, []);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  await run("专属 session 未运行：启动 named headless server，再显式 --cwd 创建 workspace", async () => {
    const h = fakeRunner([
      JSON.stringify({ sessions: [{ name: sessionName, running: false }] }),
      JSON.stringify({ sessions: [{ name: sessionName, running: true }] }),
      JSON.stringify({ result: { workspaces: [] } }),
      JSON.stringify({ result: { workspace: { workspace_id: "w-new" } } }),
    ]);
    const starts: Array<{ sessionName: string; cwd: string }> = [];
    const starter: HerdrServerStarter = async (name, cwd) => { starts.push({ sessionName: name, cwd }); };
    const result = await prepareHerdrWorkspace(
      { workspaceId, cwd: "C:\\work\\alpha", label: "Alpha" },
      h.runner,
      starter,
      noSleep,
      noProjection,
    );
    assert.deepEqual(starts, [{ sessionName, cwd: "C:\\work\\alpha" }]);
    assert.deepEqual(result, { ok: true, action: "create-workspace", workspaceId: "w-new", sessionName });
    assert.deepEqual(h.calls.at(-1)?.args, [
      "--session",
      sessionName,
      "workspace",
      "create",
      "--cwd",
      "C:\\work\\alpha",
      "--label",
      "Alpha",
      "--focus",
    ]);
    assert.equal(h.calls.some((call) => call.args.includes("default")), false);
  });

  await run("已有同 cwd workspace：只在专属 session 内 focus 后复用", async () => {
    const h = fakeRunner([
      JSON.stringify({ sessions: [{ name: sessionName, running: true }] }),
      JSON.stringify({ result: { workspaces: [{ workspace_id: "w1" }, { workspace_id: "w2" }] } }),
      JSON.stringify({ result: { panes: [{ cwd: "C:\\other" }] } }),
      JSON.stringify({ result: { panes: [{ cwd: "C:\\work\\alpha" }] } }),
      JSON.stringify({ result: { type: "workspace_focused" } }),
    ]);
    const result = await prepareHerdrWorkspace(
      { workspaceId, cwd: "C:\\work\\alpha", label: "Alpha" },
      h.runner,
      undefined,
      undefined,
      noProjection,
    );
    assert.deepEqual(result, { ok: true, action: "focus-existing", workspaceId: "w2", sessionName });
    assert.deepEqual(h.calls.at(-1)?.args, ["--session", sessionName, "workspace", "focus", "w2"]);
  });

  await run("没有匹配 cwd：按 MyBuddy 空间真实目录创建 workspace", async () => {
    const h = fakeRunner([
      JSON.stringify({ sessions: [{ name: sessionName, running: true }] }),
      JSON.stringify({ result: { workspaces: [{ workspace_id: "w1" }] } }),
      JSON.stringify({ result: { panes: [{ cwd: "C:\\other" }] } }),
      JSON.stringify({ result: { workspace: { workspace_id: "w-beta" } } }),
    ]);
    const result = await prepareHerdrWorkspace(
      { workspaceId, cwd: "C:\\work\\beta", label: "Beta Project" },
      h.runner,
      undefined,
      undefined,
      noProjection,
    );
    assert.deepEqual(result, { ok: true, action: "create-workspace", workspaceId: "w-beta", sessionName });
    assert.deepEqual(h.calls.at(-1)?.args, [
      "--session",
      sessionName,
      "workspace",
      "create",
      "--cwd",
      "C:\\work\\beta",
      "--label",
      "Beta Project",
      "--focus",
    ]);
  });

  await run("Herdr 未安装：返回用户可读错误", async () => {
    const missing = Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
    const h = fakeRunner([missing]);
    const result = await prepareHerdrWorkspace(
      { workspaceId, cwd: "C:\\work\\alpha", label: "Alpha" },
      h.runner,
      undefined,
      undefined,
      noProjection,
    );
    assert.equal(result.ok, false);
    assert.equal(result.sessionName, sessionName);
    assert.match(result.error ?? "", /未找到 Herdr/);
  });

  console.log(`\nterminal-herdr-launcher: ${passed}/${passed} PASS`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
