import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { detectCloudflared, parseCloudflaredVersion, resolveCloudflaredPath } from "../src/main/remote/CloudflaredCli";

/** cloudflared CLI 探测：版本解析 + PATH 解析 + 只读探测。不联网、不启动隧道。 */

const versionCases: Array<[string, string | undefined]> = [
  ["cloudflared version 2026.10.2 (built 20261020-20:51:21)", "2026.10.2"],
  ["cloudflared version 2026.10.7 (Checksum b9969989b243a4eaaac262cb6b8d29bded7a02810a7307509f338ed9253a29e0)", "2026.10.7"],
  ["Version 2026.10.2 (Checksum b9969989...)", "2026.10.2"],
  ["cloudflared version 2024.8.3", "2024.8.3"],
  ["nothing useful here", undefined],
  ["", undefined],
];
for (const [input, expected] of versionCases) {
  assert.equal(parseCloudflaredVersion(input), expected, `parse: ${JSON.stringify(input)}`);
}

const platform = process.platform;
const binaryName = platform === "win32" ? "cloudflared.exe" : "cloudflared";
const root = mkdtempSync(join(tmpdir(), "mybuddy-cloudflared-detect-"));
try {
  const binDir = join(root, "bin");
  const otherDir = join(root, "other");
  const fileDir = join(root, "filedir");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  mkdirSync(join(fileDir, binaryName), { recursive: true });

  const binary = join(binDir, binaryName);
  writeFileSync(binary, "#!/bin/sh\necho 'cloudflared version 2026.10.2 (built 20261020)'\n", { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(binary, 0o755);

  // PATH 命中（显式关掉常见目录兜底，避免读到宿主机真实的 cloudflared）
  const resolved = resolveCloudflaredPath({ platform, env: { PATH: [otherDir, binDir].join(delimiter) }, wellKnownDirs: [] });
  assert.equal(resolved, binary, "PATH 里的 cloudflared 必须被解析到");

  // 目录同名不算可执行文件
  assert.equal(resolveCloudflaredPath({ platform, env: { PATH: fileDir }, wellKnownDirs: [] }), undefined);

  // 完全找不到
  assert.equal(resolveCloudflaredPath({ platform, env: { PATH: otherDir }, wellKnownDirs: [] }), undefined);

  // 兜底目录只在 PATH 未命中时生效
  assert.equal(
    resolveCloudflaredPath({ platform, env: { PATH: otherDir }, wellKnownDirs: [binDir] }),
    binary,
  );

  if (process.platform !== "win32") {
    const probe = await detectCloudflared({ platform, env: { PATH: binDir }, wellKnownDirs: [], timeoutMs: 5000 });
    assert.equal(probe.installed, true);
    assert.equal(probe.version, "2026.10.2");
    assert.equal(probe.binary, binary);
    assert.equal(probe.error, undefined);

    const missing = await detectCloudflared({ platform, env: { PATH: otherDir }, wellKnownDirs: [] });
    assert.deepEqual(missing, { installed: false }, "找不到时必须是 installed:false，且不抛错");

    // 可执行但输出无法解析：仍然 installed:true，并带上 error 供 UI 提示
    const broken = join(otherDir, "cloudflared");
    writeFileSync(broken, "#!/bin/sh\necho 'not a version'\n", { mode: 0o755 });
    chmodSync(broken, 0o755);
    const brokenProbe = await detectCloudflared({ platform, env: { PATH: otherDir }, wellKnownDirs: [], timeoutMs: 5000 });
    assert.equal(brokenProbe.installed, true);
    assert.equal(brokenProbe.version, undefined);
    assert.match(brokenProbe.error ?? "", /not a version/);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("cloudflared-cli-detect: PASS");
