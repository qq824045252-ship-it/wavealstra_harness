import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, symlink, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { currentPlatformId } from "../src/main/platform";
import { executeWorkReadCommand, validateWorkReadPath } from "../src/main/platform/work-shell-read";
import { workShellRead, presentWorkReadResult } from "../src/main/agent/work/WorkShellRead";

export async function verifyReadonlyCommands(root: string): Promise<void> {
  const cwd = join(root, "verification"), outside = join(root, "outside.txt"); await mkdir(cwd);
  const path = join(cwd, "中文 proof.txt"), empty = join(cwd, "empty.txt");
  const bytes = Buffer.from("Hello from Bot 第三轮复测\n");
  await writeFile(path, bytes); await writeFile(empty, ""); await writeFile(outside, "must not read");
  for (const command of ["wc --files0-from=/etc/passwd", 'wc -c "x" "y"', "sha256sum -c file", "stat -L file", "ls -R .", "ls -L .",
    "du -a .", "awk 'END{print NR}' file", "ls -l$(touch pwn)", 'wc -c "$(cat /etc/passwd)"', "ls -l . >output", "ls -l . | cat",
    "wc -c file; echo $?; touch pwn", "wc -c file && echo $?", "wc -c file; echo $PATH", "wc -c file; echo $(touch pwn)",
    "wc -c file; printf '%s' $?", "wc -c file; echo $? >output", "wc -c file; echo $?\nwhoami", "cat file; echo $?", "pwd; echo $?",
    "wc -c file; wc -c other; echo $?", "FOO=bar wc -c file", 'wc -c "x"\nwhoami', 'wc -c "x""y"', "wc -c --files0-from=x"]) {
    assert.equal(workShellRead("bash", { command }), undefined, command);
  }
  for (const command of ["ls -l proof.txt", "wc -c proof.txt", "stat proof.txt", 'wc -c "中文 proof.txt"']) {
    const direct = workShellRead("bash", { command }); assert(direct?.verification, command);
    const echoed = workShellRead("bash", { command: `${command}; echo $?` });
    assert.deepEqual(echoed, { ...direct, echoExitCode: true });
  }
  assert.equal(workShellRead("terminal_exec", { command: `wc -c "${path}"` }), undefined);
  assert.throws(() => validateWorkReadPath(cwd, outside), /工作区/);
  assert.throws(() => validateWorkReadPath(cwd, "../outside.txt"), /工作区/);
  if (currentPlatformId !== "linux") {
    await assert.rejects(executeWorkReadCommand(cwd, path, { command: "wc", flags: ["-c"] }), /尚未提供/);
    console.log("PASS unsupported platform reports no trusted system-command backend; no simulated command success"); return;
  }
  for (const command of [`wc -c "${path}"`, `wc -l "${path}"`, `stat "${path}"`, `ls -l "${path}"`, `ls -1 "${cwd}"`,
    `du -b "${path}"`, `od -c "${path}"`, `sha256sum "${path}"`, `md5sum "${path}"`, `sha1sum "${path}"`]) {
    const parsed = workShellRead("bash", { command }); assert(parsed?.verification, command);
    const result = await executeWorkReadCommand(cwd, parsed.path, parsed.verification);
    assert.equal(result.exitCode, 0, `${command}: ${result.output}`);
    assert.equal(result.evidenceSource, "system-command-scoped-file-descriptor");
    assert.equal(result.requestedPath, path === parsed.path ? path : cwd);
    assert.equal(result.argv.at(-1), "/proc/self/fd/3");
    if (command.startsWith("du -b")) assert.match(result.output, new RegExp(`^${bytes.length}\\s`));
    if (command.startsWith("wc -c")) assert.match(result.output, new RegExp(`^${bytes.length} `));
    if (command.startsWith("wc -l")) assert.match(result.output, /^1 /);
    if (command.startsWith("sha256sum")) assert(result.output.startsWith(createHash("sha256").update(bytes).digest("hex")));
    if (command.startsWith("stat")) assert(result.output.includes(`Size: ${bytes.length}`));
  }
  // The adapter accepts only parser-approved flags in production. Invoke a
  // fixed system binary with a deliberately invalid test flag to obtain real
  // nonzero output, then exercise the same presentation path used by the tool.
  const failed = await executeWorkReadCommand(cwd, path, { command: "wc", flags: ["--fixture-invalid-option"] });
  assert.notEqual(failed.exitCode, 0);
  assert(failed.output.length > 0, "real system stderr is retained");
  const presented = presentWorkReadResult(failed, true);
  assert.equal(presented.structuredOutput.exitCode, failed.exitCode, "echo never converts failed command to success");
  assert.equal(presented.structuredOutput.output, failed.output, "raw system output is unchanged");
  assert.equal(presented.structuredOutput.exitCodeOutput, `${failed.exitCode}\n`);
  assert(presented.output.startsWith(failed.output + `${failed.exitCode}\n`));
  assert.equal(workShellRead("bash", { command: 'wc --fixture-invalid-option "file"; echo $?' }), undefined,
    "fixture flag is not admitted through the production command parser");
  const zero = await executeWorkReadCommand(cwd, empty, { command: "wc", flags: ["-c"] }); assert.match(zero.output, /^0 /);
  await symlink(outside, join(cwd, "outside-link"));
  await symlink(root, join(cwd, "outside-dir"));
  await link(outside, join(cwd, "outside-hardlink"));
  for (const name of ["outside-link", "outside-dir/outside.txt", "outside-hardlink"]) {
    assert.throws(() => validateWorkReadPath(cwd, name));
    await assert.rejects(executeWorkReadCommand(cwd, name, { command: "wc", flags: ["-c"] }));
  }
  const raced = join(cwd, "raced-link"); await symlink(path, raced);
  assert.equal(validateWorkReadPath(cwd, raced), path);
  await unlink(raced); await symlink(outside, raced);
  await assert.rejects(executeWorkReadCommand(cwd, raced, { command: "wc", flags: ["-c"] }), /工作区/,
    "an alias changed after admission cannot be executed against its new external target");
  execFileSync("/usr/bin/mkfifo", [join(cwd, "fifo")]);
  assert.throws(() => validateWorkReadPath(cwd, "fifo"), /设备|FIFO/);
  await assert.rejects(executeWorkReadCommand(cwd, "fifo", { command: "wc", flags: ["-c"] }));
  await assert.rejects(executeWorkReadCommand(cwd, cwd, { command: "du", flags: ["-b"] }), /仅接受一个普通文件/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(executeWorkReadCommand(cwd, path, { command: "wc", flags: ["-c"] }, aborted.signal));
  console.log("PASS real system read commands: byte/line/stat/list/hash/od/du, Unicode paths, empty files; reject injection, external links, hardlinks, FIFO and aborted reads");
}
