/** Host fs backend of the trusted read commands: GNU-shaped output, security bounds, platform split. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeWorkReadCommand, type ScopedReadCommand } from "../src/main/platform/work-shell-read";
import { platformId, type PlatformId } from "../src/main/platform/index";

function workspaceRoot(): string {
  const candidate = process.cwd();
  if (!existsSync(join(candidate, "package.json"))) throw new Error("请在仓库根目录运行本测试（找不到 package.json）");
  return candidate;
}

async function run(): Promise<void> {
  const repoRoot = workspaceRoot();
  const outRoot = join(repoRoot, "out");
  mkdirSync(outRoot, { recursive: true });
  const root = mkdtempSync(join(outRoot, "work-shell-read-test-"));
  const canonical = (name: string): string => realpathSync(join(root, name));
  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const hostRead = (input: string, command: ScopedReadCommand, platform: PlatformId = "windows") =>
    executeWorkReadCommand(root, input, command, undefined, undefined, platform);

  async function check(name: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
      passed.push(name);
      console.log(`PASS ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`FAIL ${name}`);
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }

  try {
    const text = "hello\nworld\n";
    writeFileSync(join(root, "hello.txt"), text, "utf8");
    writeFileSync(join(root, "empty.txt"), "", "utf8");
    writeFileSync(join(root, "big.bin"), "x".repeat(30_000), "utf8");
    mkdirSync(join(root, "dir", "sub"), { recursive: true });
    writeFileSync(join(root, "dir", "a.txt"), "aaa\n", "utf8");
    writeFileSync(join(root, "dir", ".hidden"), "hidden\n", "utf8");

    await check("ls -l single file (GNU-shaped line, evidence fields)", async () => {
      const result = await hostRead("hello.txt", { command: "ls", flags: ["-l"] });
      assert.deepEqual(Object.keys(result).sort(), ["argv", "evidenceSource", "executable", "exitCode", "output", "requestedPath", "truncated"]);
      assert.equal(result.evidenceSource, "host-node-fs");
      assert.equal(result.executable, "host-node-fs");
      assert.equal(result.exitCode, 0);
      assert.equal(result.truncated, false);
      assert.equal(result.requestedPath, canonical("hello.txt"));
      assert.deepEqual(result.argv, ["ls", "-l", canonical("hello.txt")]);
      const tokens = result.output.trimEnd().split(/\s+/);
      assert.equal(tokens.length, 9, result.output);
      assert.match(tokens[0]!, /^-([r-][w-][x-]){3}$/, tokens[0]!);
      assert.equal(tokens[1], "1");
      assert.equal(tokens[4], "12");
      assert.equal(tokens[8], "hello.txt");
    });

    await check("ls -1 single file prints the operand", async () => {
      assert.equal((await hostRead("hello.txt", { command: "ls", flags: ["-1"] })).output, "hello.txt\n");
    });

    await check("ls directory hides dot files by default and sorts by name", async () => {
      assert.equal((await hostRead("dir", { command: "ls", flags: ["-1"] })).output, "a.txt\nsub\n");
    });

    await check("ls -a and ls -A use the GNU dot-entry rules", async () => {
      assert.equal((await hostRead("dir", { command: "ls", flags: ["-a"] })).output, ".\n..\n.hidden\na.txt\nsub\n");
      assert.equal((await hostRead("dir", { command: "ls", flags: ["-A"] })).output, ".hidden\na.txt\nsub\n");
    });

    await check("ls -la directory emits total plus long entries", async () => {
      const result = await hostRead("dir", { command: "ls", flags: ["-la"] });
      const lines = result.output.split("\n");
      assert.match(lines[0]!, /^total \d+$/);
      assert.equal(lines.length, 7, result.output);
      const names = lines.slice(1, 6).map(line => line.split(/\s+/).at(-1));
      assert.deepEqual(names, [".", "..", ".hidden", "a.txt", "sub"]);
    });

    await check("wc -l / -c / -cl counts bytes and newlines", async () => {
      assert.equal((await hostRead("hello.txt", { command: "wc", flags: ["-l"] })).output, "2 hello.txt\n");
      assert.equal((await hostRead("hello.txt", { command: "wc", flags: ["-c"] })).output, "12 hello.txt\n");
      assert.equal((await hostRead("hello.txt", { command: "wc", flags: ["-cl"] })).output, " 2 12 hello.txt\n");
      assert.equal((await hostRead("empty.txt", { command: "wc", flags: ["-l"] })).output, "0 empty.txt\n");
    });

    await check("wc rejects a directory and unsupported flags", async () => {
      await assert.rejects(() => hostRead("dir", { command: "wc", flags: ["-l"] }), /仅接受一个普通文件/);
      await assert.rejects(() => hostRead("hello.txt", { command: "wc", flags: ["-w"] }), /不支持的只读命令选项/);
    });

    await check("stat describes files and directories", async () => {
      const file = await hostRead("hello.txt", { command: "stat", flags: [] });
      assert.equal(file.output.split("\n")[0], "  File: hello.txt");
      assert.match(file.output, /Size: 12/);
      assert.match(file.output, /regular file/);
      assert.match(file.output, /Access: \(0[0-7]{3}\/(?:-|d)[rwx-]{9}\)/);
      assert.match(file.output, /Modify: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9} \+0000/);
      const directory = await hostRead("dir", { command: "stat", flags: [] });
      // Directory inode size depends on the filesystem; it is not always zero.
      assert.equal(Number(directory.output.match(/Size: (\d+)/)?.[1]), statSync(join(root, "dir")).size);
      assert.match(directory.output, /directory/);
      await assert.rejects(() => hostRead("hello.txt", { command: "stat", flags: ["-l"] }), /不支持的只读命令选项/);
    });

    await check("sha256sum / sha1sum / md5sum emit GNU digest lines", async () => {
      const content = Buffer.from(text, "utf8");
      assert.equal((await hostRead("hello.txt", { command: "sha256sum", flags: [] })).output,
        `${createHash("sha256").update(content).digest("hex")}  hello.txt\n`);
      assert.equal((await hostRead("hello.txt", { command: "sha1sum", flags: [] })).output,
        `${createHash("sha1").update(content).digest("hex")}  hello.txt\n`);
      assert.equal((await hostRead("hello.txt", { command: "md5sum", flags: [] })).output,
        `${createHash("md5").update(content).digest("hex")}  hello.txt\n`);
      assert.match((await hostRead("big.bin", { command: "sha256sum", flags: [] })).output, /^[0-9a-f]{64}  big\.bin\n$/);
      await assert.rejects(() => hostRead("hello.txt", { command: "sha256sum", flags: ["-b"] }), /不支持的只读命令选项/);
    });

    await check("du -b reports apparent bytes and refuses directories", async () => {
      assert.equal((await hostRead("hello.txt", { command: "du", flags: ["-b"] })).output, "12\thello.txt\n");
      await assert.rejects(() => hostRead("dir", { command: "du", flags: ["-b"] }), /仅接受一个普通文件/);
      await assert.rejects(() => hostRead("hello.txt", { command: "du", flags: [] }), /不支持的只读命令选项/);
    });

    await check("od -c matches the GNU field layout", async () => {
      const result = await hostRead("hello.txt", { command: "od", flags: ["-c"] });
      const lines = result.output.split("\n");
      assert.equal(lines.at(-1), "");
      assert.equal(lines.at(-2), "0000014");
      const dataLine = lines[0]!, fields = dataLine.slice(7);
      assert.equal(dataLine.slice(0, 7), "0000000");
      assert.equal(fields.length, 12 * 4);
      assert.equal(dataLine.slice(7, 11), "   h");
      assert.equal(dataLine.slice(11, 15), "   e");
      assert.equal(dataLine.includes("\\n"), true);
      assert.equal((await hostRead("empty.txt", { command: "od", flags: ["-c"] })).output, "0000000\n");
      await assert.rejects(() => hostRead("big.bin", { command: "od", flags: ["-c"] }), /只读命令输出超出安全上限/);
      await assert.rejects(() => hostRead("hello.txt", { command: "od", flags: [] }), /不支持的只读命令选项/);
    });

    await check("paths outside the root, missing paths and unknown commands are refused", async () => {
      await assert.rejects(() => hostRead(resolve(root, "..", "outside.txt"), { command: "stat", flags: [] }), /不在当前工作区内/);
      await assert.rejects(() => hostRead("../outside.txt", { command: "stat", flags: [] }), /不在当前工作区内/);
      await assert.rejects(() => hostRead("missing.txt", { command: "stat", flags: [] }), /只读校验路径不存在/);
      await assert.rejects(() => hostRead("hello.txt", { command: "cat", flags: [] } as unknown as ScopedReadCommand), /不支持的只读命令/);
    });

    await check("platform dispatch keeps the linux branch and defaults the host backend", async () => {
      const current = platformId();
      if (current === "linux") {
        const linuxDefault = await executeWorkReadCommand(root, "hello.txt", { command: "ls", flags: ["-1"] });
        assert.equal(linuxDefault.evidenceSource, "system-command-scoped-file-descriptor");
        assert.equal(linuxDefault.exitCode, 0);
        assert.equal(linuxDefault.requestedPath, canonical("hello.txt"));
        const forcedLinux = await executeWorkReadCommand(root, "hello.txt", { command: "stat", flags: [] }, undefined, 5_000, "linux");
        assert.equal(forcedLinux.evidenceSource, "system-command-scoped-file-descriptor");
      } else {
        const hostDefault = await executeWorkReadCommand(root, "hello.txt", { command: "ls", flags: ["-1"] });
        assert.equal(hostDefault.evidenceSource, "host-node-fs");
        assert.equal(hostDefault.argv.at(-1), canonical("hello.txt"));
        await assert.rejects(() => executeWorkReadCommand(root, "hello.txt", { command: "stat", flags: [] }, undefined, 5_000, "linux"));
      }
      const forcedHost = await executeWorkReadCommand(root, "hello.txt", { command: "stat", flags: [] }, undefined, undefined, "macos");
      assert.equal(forcedHost.evidenceSource, "host-node-fs");
    });

    if (process.platform !== "win32" || process.env.MYBUDDY_TEST_SYMLINKS === "1") {
      try {
        symlinkSync(canonical("hello.txt"), join(root, "inside-link"), "file");
        symlinkSync(join(repoRoot, "package.json"), join(root, "escape-link"), "file");
      } catch (error) {
        skipped.push(`symlink escape (symlink creation unavailable: ${error instanceof Error ? error.message : String(error)})`);
      }
      if (existsSync(join(root, "escape-link"))) {
        await check("a symlink escaping the root is rejected", async () => {
          await assert.rejects(() => hostRead("escape-link", { command: "stat", flags: [] }), /通过符号链接越出当前工作区/);
        });
        await check("a symlink staying inside the root is readable", async () => {
          const result = await hostRead("inside-link", { command: "stat", flags: [] });
          assert.equal(result.requestedPath, canonical("hello.txt"));
        });
      }
    } else {
      skipped.push("symlink escape (Windows symlink creation needs developer mode; set MYBUDDY_TEST_SYMLINKS=1 to try)");
    }

    let hardLinkCreated = false;
    try { linkSync(canonical("hello.txt"), join(root, "hardlink.txt")); hardLinkCreated = true; }
    catch { skipped.push("hardlink refusal (link creation unavailable)"); }
    if (hardLinkCreated) {
      await check("multi-hardlink files are refused", async () => {
        await assert.rejects(() => hostRead("hardlink.txt", { command: "stat", flags: [] }), /多硬链接/);
        await assert.rejects(() => hostRead("hello.txt", { command: "stat", flags: [] }), /多硬链接/);
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n[work-shell-read] ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  for (const name of skipped) console.log(`SKIP ${name}`);
  if (failed.length > 0) { console.error(`[work-shell-read] FAILED: ${failed.join(", ")}`); process.exitCode = 1; }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
