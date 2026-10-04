import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { quoteBashArg, quotePowerShellLiteral, toBashPath } from "../src/main/agent/ShellArguments";

const value = "spaces 中文 quote' $() `ticks`";
const root = await mkdtemp(join(tmpdir(), "pi-shell-arguments-"));
const text = (result: any) => result.content.map((part: any) => part.text ?? "").join("\n");
try {
  const result = await createBashToolDefinition(root).execute("bash-quoting", { command: `printf '%s' ${quoteBashArg(value)}`, timeout: 5 }, undefined, undefined, undefined as never);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.output, value);
  assert(text(result).includes(value));
  if (process.platform === "win32") {
    assert.equal(toBashPath("C:\\A B\\x.py"), "C:/A B/x.py");
    const ps = await createPowerShellTool(root).execute("powershell-quoting", { command: `Write-Output ${quotePowerShellLiteral(value)}`, timeout: 5 }, undefined, undefined);
    assert(text(ps).includes(value));
  }
  console.log("Shell argument quoting: PASS (actual Pi Bash/PowerShell, literal metacharacters and Unicode)");
} finally { await rm(root, { recursive: true, force: true }); }
