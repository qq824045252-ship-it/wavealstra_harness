/**
 * Subagent 角色发现回归测试：产品目录 `~/.mybuddy/plugins/agents` 必须被 user/both scope 找到。
 *
 * 真机故障：用户要求「用 5 个 subagent」，`subagent` 全部失败于 `Unknown agent: "worker"`。
 * 角色定义实际在 `~/.mybuddy/plugins/agents/`（产品位置，见 src/main/paths.ts getAgentsDir），
 * 而发现逻辑只读 pi 原生 user 目录 `<PI_CODING_AGENT_DIR>/agents`（= ~/.mybuddy/agents，不存在）。
 *
 * 断言：
 *  1. user scope = 用户显式目录 + 产品目录（产品 planner 被用户同名覆盖）
 *  2. project scope 只读项目 `.pi/agents`
 *  3. both scope 里项目同名覆盖产品，且用户/产品/项目各自独有的都在
 *  4. 优先级：产品 < 用户显式 < 项目本地
 *  5. 发现结果暴露三个目录，便于错误信息定位
 *  6. MYBUDDY_AGENTS_DIR 可覆盖产品目录（部署/测试）
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../src/main/capabilities/subagent/agents";

let passed = 0;
function ok(label: string): void { passed += 1; console.log(`  ✓ ${label}`); }

function writeAgent(dir: string, name: string, description: string, tools?: string): void {
  mkdirSync(dir, { recursive: true });
  const frontmatter = [`name: ${name}`, `description: ${description}`, ...(tools ? [`tools: ${tools}`] : [])].join("\n");
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n\nYou are ${name}.\n`, "utf8");
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-agent-discovery-"));
const agentDir = join(root, ".mybuddy");
const project = join(root, "repo");
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  const userDir = join(agentDir, "agents");
  const productDir = join(agentDir, "plugins", "agents");
  const projectDir = join(project, ".pi", "agents");

  // 产品自带（真机现状：planner/reviewer/scout/worker）
  writeAgent(productDir, "worker", "product worker");
  writeAgent(productDir, "reviewer", "product reviewer");
  writeAgent(productDir, "scout", "product scout");
  writeAgent(productDir, "planner", "product planner");
  // 用户显式覆盖：同名 planner + 独有 useronly
  writeAgent(userDir, "planner", "user planner override");
  writeAgent(userDir, "useronly", "only in user dir");
  // 项目本地：同名 worker + 独有 projectonly
  writeAgent(projectDir, "worker", "project worker", "read, grep");
  writeAgent(projectDir, "projectonly", "only in project");

  // ---------- 1. user scope ----------
  const user = discoverAgents(project, "user");
  const names = user.agents.map((agent) => agent.name).sort();
  assert.deepEqual(names, ["planner", "reviewer", "scout", "useronly", "worker"], "user scope 必须包含产品目录角色");
  const planner = user.agents.find((agent) => agent.name === "planner")!;
  assert.equal(planner.description, "user planner override", "用户显式目录覆盖产品同名角色");
  assert.ok(planner.filePath.startsWith(userDir), "覆盖后的角色来自用户目录");
  assert.equal(user.agents.find((agent) => agent.name === "worker")?.description, "product worker", "产品角色可被直接使用");
  assert.equal(user.agents.some((agent) => agent.name === "projectonly"), false, "user scope 不读项目角色");
  ok("user scope = 产品目录 + 用户目录（用户同名覆盖）");

  // ---------- 2. project scope ----------
  const projectOnly = discoverAgents(project, "project");
  assert.deepEqual(projectOnly.agents.map((agent) => agent.name).sort(), ["projectonly", "worker"], "project scope 只读项目目录");
  assert.equal(projectOnly.agents.find((agent) => agent.name === "worker")?.source, "project");
  ok("project scope 严格隔离");

  // ---------- 3/4. both scope 优先级 ----------
  const both = discoverAgents(project, "both");
  const bothNames = both.agents.map((agent) => agent.name).sort();
  assert.deepEqual(bothNames, ["planner", "projectonly", "reviewer", "scout", "useronly", "worker"]);
  const bothWorker = both.agents.find((agent) => agent.name === "worker")!;
  assert.equal(bothWorker.source, "project", "项目角色覆盖产品角色");
  assert.equal(bothWorker.description, "project worker");
  assert.deepEqual(bothWorker.tools, ["read", "grep"], "项目角色的 tools 限制生效");
  assert.equal(both.agents.find((agent) => agent.name === "planner")?.description, "user planner override", "用户覆盖仍然优先于产品");
  ok("both scope 优先级：产品 < 用户显式 < 项目本地");

  // ---------- 5. 诊断目录 ----------
  assert.equal(user.userAgentsDir, userDir);
  assert.equal(user.productAgentsDir, productDir);
  assert.equal(both.projectAgentsDir, projectDir);
  ok("发现结果暴露产品/用户/项目三个目录");

  // ---------- 6. MYBUDDY_AGENTS_DIR 覆盖 ----------
  const altDir = join(root, "alt-agents");
  writeAgent(altDir, "altworker", "alt product dir");
  process.env.MYBUDDY_AGENTS_DIR = altDir;
  const alt = discoverAgents(project, "user");
  assert.equal(alt.agents.some((agent) => agent.name === "altworker"), true, "MYBUDDY_AGENTS_DIR 必须生效");
  assert.equal(alt.agents.some((agent) => agent.name === "scout"), false, "覆盖后不再读默认产品目录");
  delete process.env.MYBUDDY_AGENTS_DIR;
  ok("MYBUDDY_AGENTS_DIR 覆盖产品目录");

  console.log(`\nsubagent agent discovery: PASS (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
