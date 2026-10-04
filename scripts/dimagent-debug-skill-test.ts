import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-dimagent-debug-"));
  const previousProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  try {
    const [{ SkillsService }, { CODING_MODE_PRESETS }, { BUILTIN_CAPABILITY_TOOLS }, { NATIVE_CAPABILITY_TOOL_NAMES }] = await Promise.all([
      import("../src/main/skills/SkillsService"),
      import("../src/main/agent/mode-defaults"),
      import("../src/shared/builtin-capabilities"),
      import("../src/main/agent/PromptAssembly"),
    ]);

    const service = new SkillsService();
    const market = service.listMarket();
    const marketSkill = market.find((item) => item.id === "dimagent-debug");
    assert(marketSkill, "dimagent-debug should be present in the builtin skill market");

    const installed = service.installFromMarket("dimagent-debug");
    assert.equal(installed.name, "dimagent-debug");
    const skillPath = join(root, ".mybuddy", "skills", "dimagent-debug", "SKILL.md");
    assert(existsSync(skillPath), "installed SKILL.md should exist");
    const content = readFileSync(skillPath, "utf8");
    assert(content.includes("Reproduce first"), "skill should enforce reproduce-first debugging");
    assert(content.includes("ui_exec"), "skill should teach MyBuddy UI execution");
    assert(content.includes("computer_exec"), "skill should teach desktop fallback execution");
    assert(content.includes("runtime_probe"), "skill should teach runtime evidence capture");
    assert(content.includes("after_sequence"), "skill should teach mark/read evidence windows");
    assert(content.includes("persistent queues"), "skill should warn about stale test-harness state");
    assert(service.listInstalled().some((item) => item.name === "dimagent-debug" && item.enabled));

    const preset = CODING_MODE_PRESETS.find((item) => item.id === "bugfix-test");
    assert(preset, "bugfix preset should exist");
    assert(preset.skillPolicy?.prefer?.includes("dimagent-debug"), "bugfix preset should prefer dimagent-debug");
    assert(preset.promptAddon?.includes("ui_exec"), "bugfix preset should require actual UI reproduction when available");
    assert(BUILTIN_CAPABILITY_TOOLS.browser.includes("ui_exec"));
    assert(BUILTIN_CAPABILITY_TOOLS.browser.includes("computer_exec"));
    assert(BUILTIN_CAPABILITY_TOOLS.browser.includes("runtime_probe"));
    for (const tool of ["ui_exec", "computer_exec", "runtime_probe"]) {
      assert(NATIVE_CAPABILITY_TOOL_NAMES.includes(tool as (typeof NATIVE_CAPABILITY_TOOL_NAMES)[number]), `native activation list missing ${tool}`);
    }

    console.log("dimagent debug skill: ok");
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
