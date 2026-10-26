/**
 * 系统字体枚举（platform/fonts）。
 *
 * 背景：`UserFontsStore.listSystemFonts()` 里原本内联了 Windows 的 PowerShell
 * (System.Drawing InstalledFontCollection) + 注册表兜底两段实现，Linux/macOS 直接返回 []。
 * 平台边界（见 `./index.ts`）要求把「这个平台用什么实现」收敛到这里。
 *
 * 约定：
 * - 同步 API（`UserFontsStore.listSystemFonts(): string[]` 的既有签名不变）；
 * - 缓存语义留在 `UserFontsStore`（只缓存非空结果，避免一次临时失败把「0 个字体」缓存到进程结束）；
 * - Windows 实现与原 `UserFontsStore` 逐字一致（PowerShell → 注册表兜底、归一化/去重/zh-CN 排序）；
 * - Linux 走 fontconfig 的 `fc-list --format=%{family}\n`；
 * - macOS 暂返回 []（系统字体 API 走 NSFontManager，需要原生桥，尚未接入）。
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";

export interface FontExecOptions {
  encoding: "utf-8";
  timeout: number;
  windowsHide: boolean;
}

/** 可注入的同步执行器：默认 `execFileSync`，测试传假实现即可覆盖 Windows/Linux 解析路径。 */
export interface FontExecRunner {
  run(command: string, args: string[], options: FontExecOptions): string;
}

export interface ListSystemFontsOptions {
  runner?: FontExecRunner;
  /** Windows 路径用到的 SystemRoot/WINDIR；默认读 process.env，便于测试注入。 */
  env?: NodeJS.ProcessEnv;
}

const defaultRunner: FontExecRunner = {
  run: (command, args, options) => String(execFileSync(command, args, options)),
};

/**
 * 字体名归一化：去 BOM、trim、去空、去重（保留首次出现）、按 zh-CN 排序。
 * 与搬迁前 Windows 实现的 `normalize` 完全一致。
 */
export function normalizeFontFamilies(names: readonly string[]): string[] {
  return names
    .map((name) => String(name).replace(/^\uFEFF/, "").trim())
    .filter(Boolean)
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort((a, b) => a.localeCompare(b, "zh-CN", { sensitivity: "base" }));
}

/**
 * `fc-list --format=%{family}\n` 输出 → family 列表。
 *
 * fontconfig 的 `%{family}` 是**该 face 的别名列表**，多个别名用逗号拼接，例如
 * `Noto Sans Gujarati,Noto Sans Gujarati Black`；逗号串不是合法的 CSS font-family，
 * 直接展示会在字体选择器里出现「A,B」这种脏名字，因此这里按行 + 逗号双重拆分。
 * 其余规则照要求：trim、去空、去重、`localeCompare("zh-CN")` 排序。
 */
export function parseFcListFamilies(text: string): string[] {
  const raw: string[] = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    for (const alias of line.split(",")) {
      const name = alias.trim();
      if (name) raw.push(name);
    }
  }
  return normalizeFontFamilies(raw);
}

/** PowerShell 的 InstalledFontCollection（Windows）。失败/为空 => null（交给注册表兜底）。 */
function windowsInstalledFontCollection(runner: FontExecRunner, env: NodeJS.ProcessEnv): string[] | null {
  try {
    const command = [
      "$ErrorActionPreference='Stop'",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "Add-Type -AssemblyName System.Drawing",
      "$fonts = New-Object System.Drawing.Text.InstalledFontCollection",
      "$fonts.Families | ForEach-Object { $_.Name } | Sort-Object -Unique | ConvertTo-Json -Compress",
    ].join("; ");
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = runner
      .run(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { encoding: "utf-8", timeout: 10000, windowsHide: true },
      )
      .replace(/^\uFEFF/, "")
      .trim();
    if (!output) return null;
    const parsed = JSON.parse(output) as string | string[];
    const list = normalizeFontFamilies(Array.isArray(parsed) ? parsed : [parsed]);
    return list.length ? list : null;
  } catch (error) {
    console.warn("[platform/fonts] InstalledFontCollection 枚举失败，改用注册表", error);
    return null;
  }
}

/** 注册表字体项兜底（Windows）。与搬迁前实现一致：HKLM + HKCU，去掉 (TrueType)/(Regular) 后缀。 */
function windowsRegistryFamilies(runner: FontExecRunner, env: NodeJS.ProcessEnv): string[] {
  try {
    const systemRoot = env.SystemRoot || env.WINDIR || "C:\\Windows";
    const reg = join(systemRoot, "System32", "reg.exe");
    const roots = [
      "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
      "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    ];
    const names: string[] = [];
    for (const key of roots) {
      let output = "";
      try {
        output = runner.run(reg, ["query", key], { encoding: "utf-8", timeout: 5000, windowsHide: true });
      } catch {
        continue;
      }
      for (const line of output.split(/\r?\n/)) {
        const match = /^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+.+$/i.exec(line);
        if (!match?.[1]) continue;
        const family = match[1]
          .replace(/\s+\((?:TrueType|OpenType)\)$/i, "")
          .replace(/\s+(?:Regular|Roman)$/i, "")
          .trim();
        if (family) names.push(family);
      }
    }
    return normalizeFontFamilies(names);
  } catch (error) {
    console.warn("[platform/fonts] 注册表字体枚举失败", error);
    return [];
  }
}

/** Linux：fontconfig 的 fc-list（无 fontconfig / 命令缺失 => []）。 */
function linuxFontFamilies(runner: FontExecRunner): string[] {
  try {
    const output = runner.run("fc-list", ["--format=%{family}\n"], {
      encoding: "utf-8",
      timeout: 10000,
      windowsHide: true,
    });
    return parseFcListFamilies(output);
  } catch {
    // 精简发行版/容器里可能没有 fc-list；字体选择器回落到「仅用户导入字体」。
    return [];
  }
}

/**
 * 列出系统已安装字体（family 名），按平台分派。
 *
 * @param platform 目标平台，默认当前进程（测试可覆盖）
 * @param options  runner/env 注入（仅测试使用）
 */
export function listSystemFonts(
  platform: PlatformId = currentPlatformId,
  options: ListSystemFontsOptions = {},
): string[] {
  const runner = options.runner ?? defaultRunner;
  const env = options.env ?? process.env;
  switch (platform) {
    case "windows": {
      const installed = windowsInstalledFontCollection(runner, env);
      if (installed) return installed;
      return windowsRegistryFamilies(runner, env);
    }
    case "linux":
      return linuxFontFamilies(runner);
    case "macos":
    default:
      return [];
  }
}
