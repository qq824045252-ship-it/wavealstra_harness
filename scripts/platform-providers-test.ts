/**
 * platform providers 测试（platform/fonts、platform/processes、platform/shell-tools）。
 *
 * 覆盖：
 *  1. Windows 进程发现：netstat LISTENING 行 → pid、tasklist CSV → pid、PowerShell CIM → exe 路径
 *     （全部用假 runner，不依赖真实 Windows / 真实进程）
 *  2. Linux 进程发现：`ss -ltnp` 解析（含 IPv6、多 pid、端口后缀不误匹配）、`/proc/*\/comm` 镜像名匹配、
 *     `/proc/<pid>/exe` 读链接（含 ENOENT/权限失败 → null、` (deleted)` 后缀剥离）
 *  3. 字体枚举：`fc-list` 输出解析（别名逗号拆分 / 去重 / zh-CN 排序 / BOM）、Linux provider、
 *     Windows provider（PowerShell InstalledFontCollection JSON + 注册表兜底）、macOS → []
 *  4. shell 工具矩阵：windows → PowerShell；linux/macOS → []
 *  5. 工厂注入：假 runner / 假 /proc 只在本文件内构造，测试不触碰真实系统状态。
 *  6-12. 平台拆分 D 的纯函数/注入面：paths、runtime、terminal、apps、input、fs-security、进程树终止。
 */
import { dirname, join, resolve, sep } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  normalizeFontFamilies,
  parseFcListFamilies,
  listSystemFonts,
  type FontExecRunner,
} from "../src/main/platform/fonts";
import {
  createProcessDiscovery,
  imageNameMatchesComm,
  parseProcCommMatches,
  parseSsListeningPids,
  type ProcessFsDeps,
  type ProcessRunner,
} from "../src/main/platform/processes";
import { createPlatformShellTools, executeCodeLanguages, platformShellLanguageIds } from "../src/main/platform/shell-tools";
import {
  canonicalPathKey,
  caseInsensitivePathFs,
  directorySymlinkType,
  isBashExecutableName,
  parentTraversalPrefix,
  pathKey,
  pathSeparator,
  resolvedPathKey,
  toPosixPath,
} from "../src/main/platform/paths";
import {
  nodeExecutableName,
  pathListSeparator,
  programFilesDefault,
  pythonExecutableName,
  pythonProjectCacheKey,
  pythonVenvInterpreterParts,
  spawnDetachedForTreeKill,
  uvAssetName,
  uvExecutableName,
  venvPython3RelativePath,
  venvPythonRelativePath,
} from "../src/main/platform/runtime";
import {
  defaultShellForPlatform,
  posixDefaultShell,
  pwshPath,
  useConpty,
  windowsPowerShellPath,
} from "../src/main/platform/terminal";
import {
  adbCandidatePaths,
  adbExecutableName,
  commandCodeAcpEnv,
  connectorPlatformKey,
  devinDesktopBundledCli,
  npxFallbackPaths,
  npxProbeCommand,
  pickExecutablePath,
  roamingAppDataDir,
  spawnExternalCliCommand,
  whereCommand,
  whereFirst,
} from "../src/main/platform/apps";
import { selectAllModifier } from "../src/main/platform/input";
import {
  ensureExecutable,
  ensureExecutableFile,
  parsePowerShellDiskSpace,
  protectSecretFile,
  readDiskSpaceFallback,
} from "../src/main/platform/fs-security";
import { killProcessTree, type KillableChild } from "../src/main/platform/processes";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, ok ? label : `${label}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
}

/** 假进程 runner：按命令分派；记录调用便于断言命令行。 */
function fakeRunner(
  handler: (command: string, args: string[]) => { code: number; output: string } | Promise<{ code: number; output: string }>,
): ProcessRunner & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push({ command, args });
      return handler(command, args);
    },
  };
}

function throwingRunner(): ProcessRunner {
  return {
    run: async () => {
      throw new Error("spawn ENOENT");
    },
  };
}

/** 假字体执行器：按命令分派并记录调用。 */
function fakeFontRunner(handler: (command: string, args: string[]) => string): FontExecRunner & {
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args });
      return handler(command, args);
    },
  };
}

const NETSTAT_OUTPUT = [
  "",
  "活动连接",
  "",
  "  协议  本地地址          外部地址        状态           PID",
  "  TCP    127.0.0.1:9876     0.0.0.0:0       LISTENING       1234",
  "  TCP    0.0.0.0:9876       0.0.0.0:0       LISTENING       5678",
  "  TCP    0.0.0.0:9080       0.0.0.0:0       LISTENING       999",
  "  TCP    127.0.0.1:9876     127.0.0.1:51000 ESTABLISHED     4321",
  "",
].join("\r\n");

// 真实 tasklist 已按 /FI 过滤，客户端不再过滤（搬迁前后一致）：fixture 只放匹配行。
const TASKLIST_OUTPUT = [
  '"blender.exe","4242","Console","1","1,234 K"',
  '"blender.exe","4243","Console","1","2,345 K"',
  "",
].join("\r\n");

const SS_OUTPUT = [
  "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
  'LISTEN 0      511          0.0.0.0:5174       0.0.0.0:*    users:(("node-MainThread",pid=55357,fd=21))',
  "LISTEN 0      4096        127.0.0.1:7890       0.0.0.0:*    users:(",
  'LISTEN 0      511        127.0.0.1:36899       0.0.0.0:*    users:(("node-MainThread",pid=53918,fd=22))',
  'LISTEN 0      511            [::]:36899          [::]:*    users:(("node",pid=60001,fd=5),("node",pid=60002,fd=6))',
  'LISTEN 0      511          0.0.0.0:368990       0.0.0.0:*    users:(("decoy",pid=1,fd=1))',
  "",
].join("\n");

async function main(): Promise<void> {
  // ------------------------------------------------------------ 1) Windows 进程发现
  console.log("== 1) Windows 进程发现（netstat / tasklist / PowerShell CIM，假 runner）==");
  {
    const runner = fakeRunner((command) => {
      if (command === "netstat") return { code: 0, output: NETSTAT_OUTPUT };
      if (command === "tasklist") return { code: 0, output: TASKLIST_OUTPUT };
      return { code: 1, output: "" };
    });
    const discovery = createProcessDiscovery("windows", { runner });
    assertEqual(await discovery.listListeningPids(9876), [1234, 5678], "netstat：只取 LISTENING 行的目标端口 pid（ESTABLISHED 不算）");
    assertEqual(await discovery.listListeningPids(9080), [999], "netstat：另一端口");
    assertEqual(await discovery.listListeningPids(1234), [], "netstat：无匹配端口 → []");
    assertEqual(runner.calls[0], { command: "netstat", args: ["-ano", "-p", "tcp"] }, "netstat 参数与原实现一致");

    assertEqual(await discovery.listPidsByImageName("blender.exe"), [4242, 4243], "tasklist：镜像名匹配的 pid 列表");
    const tasklistCall = runner.calls.find((call) => call.command === "tasklist")!;
    assertEqual(
      tasklistCall.args,
      ["/FI", "IMAGENAME eq blender.exe", "/FO", "CSV", "/NH"],
      "tasklist 参数与原实现一致（CSV/NH）",
    );

    const exeRunner = fakeRunner((command) => {
      if (command === "powershell") return { code: 0, output: "C:\\Tools\\Blender\\blender.exe\r\n" };
      return { code: 1, output: "" };
    });
    const exeDiscovery = createProcessDiscovery("windows", { runner: exeRunner });
    assertEqual(await exeDiscovery.pidExecutablePath(4242), "C:\\Tools\\Blender\\blender.exe", "PowerShell CIM：首行 trim 作为 exe 路径");
    const psCall = exeRunner.calls[0]!;
    assert(
      psCall.command === "powershell" && psCall.args.some((arg) => arg.includes("Get-CimInstance Win32_Process")),
      "PowerShell 用 Get-CimInstance Win32_Process 查询 ExecutablePath",
    );

    const emptyRunner = fakeRunner(() => ({ code: 1, output: "" }));
    const emptyDiscovery = createProcessDiscovery("windows", { runner: emptyRunner });
    assertEqual(await emptyDiscovery.listListeningPids(9876), [], "netstat 非 0 退出 → []");
    assertEqual(await emptyDiscovery.listPidsByImageName("blender.exe"), [], "tasklist 非 0 退出 → []");
    assertEqual(await emptyDiscovery.pidExecutablePath(4242), null, "PowerShell 非 0 退出 → null");

    const boom = createProcessDiscovery("windows", { runner: throwingRunner() });
    assertEqual(await boom.listListeningPids(9876), [], "runner 抛错（命令缺失）→ []（探测型 API 不抛）");
    assertEqual(await boom.pidExecutablePath(4242), null, "runner 抛错 → null");
  }

  // ------------------------------------------------------------ 2) Linux 进程发现
  console.log("== 2) Linux 进程发现（ss / /proc，假 runner + 假 /proc）==");
  {
    assertEqual(parseSsListeningPids(SS_OUTPUT, 36899), [53918, 60001, 60002], "ss：监听端口的全部 pid（含 IPv6 与多进程）");
    assertEqual(parseSsListeningPids(SS_OUTPUT, 5174), [55357], "ss：单 pid");
    assertEqual(parseSsListeningPids(SS_OUTPUT, 7890), [], "ss：没有 users: 段 → 归属未知（不伪造 pid）");
    assertEqual(parseSsListeningPids(SS_OUTPUT, 368990), [1], "ss：端口按列尾精确匹配（368990 ≠ 36899）");
    assertEqual(parseSsListeningPids(SS_OUTPUT, 3689), [], "ss：前缀不是端口（3689 ≠ 36899）");
    assertEqual(parseSsListeningPids("", 1), [], "ss：空输出 → []");

    const runner = fakeRunner(() => ({ code: 0, output: SS_OUTPUT }));
    const discovery = createProcessDiscovery("linux", { runner });
    assertEqual(await discovery.listListeningPids(36899), [53918, 60001, 60002], "Linux 发现：ss -ltnp 结果经解析返回");
    assertEqual(runner.calls[0], { command: "ss", args: ["-ltnp"] }, "Linux 用 `ss -ltnp`（不是 netstat）");

    const noSs = createProcessDiscovery("linux", { runner: throwingRunner() });
    assertEqual(await noSs.listListeningPids(36899), [], "ss 缺失 → []（精简容器降级）");

    // 假 /proc：readdir 过滤非 pid 目录，readFile/readlink 只对已知 pid 生效。
    const commByPid: Record<string, string> = {
      "/proc/42/comm": "blender\n",
      "/proc/123/comm": "Blender.exe\n",
      "/proc/7/comm": "node-MainThread\n",
      "/proc/8/comm": "blender-statu\n", // 内核把 comm 截断到 15 字符
    };
    const exeByPid: Record<string, string> = {
      "/proc/42/exe": "/usr/bin/blender",
      "/proc/123/exe": "/opt/blender/blender",
      "/proc/7/exe": "/usr/bin/node (deleted)",
    };
    const probeCalls: string[] = [];
    const fs: ProcessFsDeps = {
      readdir: (path) => {
        probeCalls.push(`readdir:${path}`);
        assertEqual(path, "/proc", "Linux 镜像名扫描从 /proc 开始");
        return ["1", "42", "123", "7", "8", "self", "sys", "uptime"];
      },
      readFile: (path, encoding) => {
        assertEqual(encoding, "utf-8", "comm 以 utf-8 读取");
        const value = commByPid[path];
        if (value === undefined) throw new Error(`ENOENT ${path}`);
        return value;
      },
      readlink: (path) => {
        const value = exeByPid[path];
        if (value === undefined) throw new Error(`ENOENT ${path}`);
        return value;
      },
    };
    const linuxFs = createProcessDiscovery("linux", { runner: fakeRunner(() => ({ code: 0, output: "" })), fs });
    assertEqual(await linuxFs.listPidsByImageName("blender.exe"), [42, 123], "/proc/comm：imageName 带 .exe 仍匹配（大小写不敏感）");
    assertEqual(await linuxFs.listPidsByImageName("blender"), [42, 123], "/proc/comm：imageName 不带扩展名也匹配");
    assertEqual(await linuxFs.listPidsByImageName("node.exe"), [], "/proc/comm：node-MainThread ≠ node.exe（不做模糊匹配）");
    assertEqual(await linuxFs.listPidsByImageName("blender-status-server.exe"), [], "/proc/comm 15 字符截断 → 不误匹配");
    assertEqual(await linuxFs.pidExecutablePath(42), "/usr/bin/blender", "/proc/<pid>/exe 读链接");
    assertEqual(await linuxFs.pidExecutablePath(7), "/usr/bin/node", "exe 路径剥掉 ` (deleted)` 后缀");
    assertEqual(await linuxFs.pidExecutablePath(999), null, "进程不存在（readlink 抛错）→ null");
    assert(probeCalls.length > 0, "/proc 注入生效（未触碰真实 /proc）");
  }
  {
    assert(imageNameMatchesComm("blender", "blender.exe"), "comm 无扩展名 + imageName 带 .exe → 匹配");
    assert(imageNameMatchesComm("Blender.EXE", "blender.exe"), "大小写不敏感");
    assert(imageNameMatchesComm("blender.exe", "blender.exe"), "comm 自带 .exe → 匹配");
    assert(!imageNameMatchesComm("blend", "blender.exe"), "前缀不匹配");
    assert(!imageNameMatchesComm("", "blender.exe"), "空 comm 不匹配");
    assertEqual(
      parseProcCommMatches([{ pid: 5, comm: "bash\n" }, { pid: 6, comm: "bash\n" }, { pid: 6, comm: "bash" }], "bash"),
      [5, 6],
      "parseProcCommMatches 去重",
    );
  }

  // ------------------------------------------------------------ 3) 字体
  console.log("== 3) 字体枚举（fc-list / PowerShell JSON / 注册表兜底，假 runner）==");
  {
    const fcList = [
      "Noto Sans Gujarati,Noto Sans Gujarati Black",
      "Arial Black",
      "",
      "  Noto Sans  ",
      "Noto Sans",
      "Noto Sans Gujarati UI,Noto Sans Gujarati UI Light",
      "",
    ].join("\n");
    assertEqual(
      parseFcListFamilies(fcList),
      ["Arial Black", "Noto Sans", "Noto Sans Gujarati", "Noto Sans Gujarati Black", "Noto Sans Gujarati UI", "Noto Sans Gujarati UI Light"],
      "fc-list：按行 + 别名逗号拆分、trim、去重、zh-CN 排序",
    );
    assertEqual(parseFcListFamilies("\uFEFFArial\nBodoni"), ["Arial", "Bodoni"], "fc-list：剥离 BOM");
    assertEqual(parseFcListFamilies(""), [], "fc-list：空输出 → []");
    assertEqual(
      normalizeFontFamilies(["Zeta", "alpha", "Alpha", " zeta "]),
      ["alpha", "Alpha", "Zeta", "zeta"],
      "normalizeFontFamilies：去重是精确匹配（与 Windows 原实现一致），排序 zh-CN 大小写不敏感",
    );

    const linuxRunner = fakeFontRunner((command, args) => {
      assertEqual(command, "fc-list", "Linux 字体用 fc-list");
      assertEqual(args, ["--format=%{family}\n"], "fc-list 用 %{family} 格式（每行一个 family）");
      return "Arial\nDejaVu Sans,Arial\n";
    });
    assertEqual(
      listSystemFonts("linux", { runner: linuxRunner }),
      ["Arial", "DejaVu Sans"],
      "Linux provider：fc-list → 解析（含别名拆分与去重）",
    );
    assertEqual(linuxRunner.calls.length, 1, "Linux provider 只调用一次 fc-list");

    const missingFcList = fakeFontRunner(() => {
      throw new Error("spawn fc-list ENOENT");
    });
    assertEqual(listSystemFonts("linux", { runner: missingFcList }), [], "Linux：fc-list 缺失 → []（不抛错）");

    // Windows：PowerShell JSON（单值 / 数组）→ 归一化
    const psRunner = fakeFontRunner((command, args) => {
      if (!/powershell(?:\.exe)?$/i.test(command)) throw new Error(`unexpected ${command}`);
      assert(args.includes("-EncodedCommand"), "Windows 用 -EncodedCommand 传 PowerShell 脚本（避开引号/编码问题）");
      return JSON.stringify(["Zeta Font", "Alpha Font", "Alpha Font"]);
    });
    assertEqual(
      listSystemFonts("windows", { runner: psRunner }),
      ["Alpha Font", "Zeta Font"],
      "Windows provider：InstalledFontCollection JSON → 去重排序",
    );

    const singleValueRunner = fakeFontRunner(() => JSON.stringify("Calibri"));
    assertEqual(listSystemFonts("windows", { runner: singleValueRunner }), ["Calibri"], "Windows：ConvertTo-Json 单值时是裸字符串");

    // Windows：PowerShell 失败 → 注册表兜底（HKLM + HKCU，去掉 (TrueType)/(Regular) 后缀）
    const regCalls: string[][] = [];
    const regRunner = fakeFontRunner((command, args) => {
      if (/powershell(?:\.exe)?$/i.test(command)) throw new Error("System.Drawing unavailable");
      if (/reg(?:\.exe)?$/i.test(command)) {
        regCalls.push(args);
        if (args[1]?.includes("HKLM")) {
          return [
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
            "    Arial (TrueType)    REG_SZ    arial.ttf",
            "    Segoe UI Light (TrueType)    REG_SZ    segoeuil.ttf",
            "    Cambria (OpenType)    REG_SZ    cambria.ttc",
            "",
          ].join("\r\n");
        }
        return [
          "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
          "    Zeta Regular    REG_SZ    zeta.ttf",
          "",
        ].join("\r\n");
      }
      throw new Error(`unexpected ${command}`);
    });
    assertEqual(
      listSystemFonts("windows", { runner: regRunner }),
      ["Arial", "Cambria", "Segoe UI Light", "Zeta"],
      "Windows provider：注册表兜底解析（HKLM + HKCU；只剥 (TrueType)/(OpenType) 与 Regular/Roman 后缀，Light 等字重保留）",
    );
    assert(regCalls.length === 2, "注册表兜底查两个根（HKLM/HKCU）");

    const bothFail = fakeFontRunner(() => {
      throw new Error("no fonts");
    });
    assertEqual(listSystemFonts("windows", { runner: bothFail }), [], "Windows：PowerShell + 注册表都失败 → []");

    assertEqual(listSystemFonts("macos"), [], "macOS：暂未接入 → []");
  }

  // ------------------------------------------------------------ 4) shell 工具矩阵
  console.log("== 4) shell 工具矩阵（platform/shell-tools）==");
  {
    let created = 0;
    const stub = (): ToolRegistration => {
      created += 1;
      return { name: "powershell" } as unknown as ToolRegistration;
    };
    const windowsTools = createPlatformShellTools("windows", { createPowerShellTool: stub });
    assertEqual(windowsTools.length, 1, "windows：额外提供 1 个 shell 工具");
    assertEqual((windowsTools[0] as unknown as { name: string }).name, "powershell", "windows：工具名 powershell");
    assertEqual(created, 1, "windows：工厂被调用一次");

    let linuxCreated = 0;
    const linuxTools = createPlatformShellTools("linux", {
      createPowerShellTool: () => {
        linuxCreated += 1;
        return { name: "powershell" } as unknown as ToolRegistration;
      },
    });
    assertEqual(linuxTools, [], "linux：不额外提供 shell 工具（CodingTools 自带 bash）");
    assertEqual(linuxCreated, 0, "linux：幂等（不构造 PowerShell 工具）");

    assertEqual(createPlatformShellTools("macos"), [], "macos：不额外提供 shell 工具");

    assertEqual(platformShellLanguageIds("windows"), ["powershell"], "windows：execute_code 额外支持 powershell 语言");
    assertEqual(platformShellLanguageIds("linux"), [], "linux：不额外声明 shell 语言");
    assertEqual(platformShellLanguageIds("macos"), [], "macos：不额外声明 shell 语言");

    const real = createPlatformShellTools("windows");
    assertEqual(real.length, 1, "windows：默认工厂返回真实的 PowerShell 工具注册");
    assertEqual((real[0] as unknown as { name: string }).name, "powershell", "默认工厂工具名 powershell（pi-durable SDK）");
  }

  // ------------------------------------------------------------ 5) macOS 进程发现（无信息语义）
  console.log("== 5) macOS 进程发现（暂无实现 → 保持「无信息」语义）==");
  {
    const mac = createProcessDiscovery("macos");
    assertEqual(await mac.listListeningPids(8080), [], "macOS：listListeningPids → []");
    assertEqual(await mac.listPidsByImageName("blender.exe"), [], "macOS：listPidsByImageName → []");
    assertEqual(await mac.pidExecutablePath(1), null, "macOS：pidExecutablePath → null");
  }


  // ------------------------------------------------------------ 6) paths
  console.log("== 6) platform/paths（大小写、分隔符、symlink、正斜杠）==");
  {
    assertEqual(pathKey("C:\\Users\\Alice", "windows"), "c:\\users\\alice", "pathKey(win32) 统一小写");
    assertEqual(pathKey("/home/Alice", "linux"), "/home/Alice", "pathKey(linux) 原样");
    assertEqual(resolvedPathKey("foo", "windows"), resolve("foo").toLowerCase(), "resolvedPathKey(win32)=resolve+小写");
    assertEqual(resolvedPathKey("foo", "linux"), resolve("foo"), "resolvedPathKey(linux)=resolve");
    // canonicalPathKey 内部用宿主 resolve() 归一化（不按 platform 参数切 path 模块），
    // 所以期望值必须用 resolve() 拼，写死 "/tmp/x" 在 Windows 上必红。
    assertEqual(canonicalPathKey(`${resolve("/tmp/x")}///`, "linux"), resolve("/tmp/x"), "canonicalPathKey 去尾部斜杠");
    assertEqual(
      canonicalPathKey("/tmp/X", "windows"),
      resolve("/tmp/x").toLocaleLowerCase(),
      "canonicalPathKey(win32) 小写",
    );
    assertEqual(pathSeparator("windows"), "\\", "pathSeparator(win32) 反斜杠");
    assertEqual(pathSeparator("linux"), "/", "pathSeparator(linux) 正斜杠");
    assertEqual(parentTraversalPrefix("windows"), "..\\", "越界前缀(win32) 是 ..\\");
    assertEqual(parentTraversalPrefix("linux"), "../", "越界前缀(linux) 是 ../");
    assertEqual(directorySymlinkType("windows"), "junction", "目录 symlink(win32)=junction");
    assertEqual(directorySymlinkType("linux"), "dir", "目录 symlink(linux)=dir");
    assertEqual(toPosixPath("C:\\a\\b", "windows"), "C:/a/b", "toPosixPath(win32) 反斜杠转正斜杠");
    assertEqual(toPosixPath("/a/b", "linux"), "/a/b", "toPosixPath(linux) 原样");
    assert(caseInsensitivePathFs("windows") && !caseInsensitivePathFs("linux"), "只有 Windows 大小写不敏感");
  }

  // ------------------------------------------------------------ 7) runtime
  console.log("== 7) platform/runtime（node/venv/uv/PATH 布局）==");
  {
    assertEqual(nodeExecutableName("win32"), "node.exe", "Windows node 可执行名带 .exe");
    assertEqual(nodeExecutableName("linux"), "node", "POSIX node 可执行名");
    assertEqual(pathListSeparator("win32"), ";", "Windows PATH 分隔符 ;");
    assertEqual(pathListSeparator("linux"), ":", "POSIX PATH 分隔符 :");
    assertEqual(programFilesDefault("win32"), "C:\\Program Files", "Windows ProgramFiles 默认值");
    assertEqual(programFilesDefault("linux"), "", "POSIX 没有 ProgramFiles（空串）");
    assertEqual(spawnDetachedForTreeKill("win32"), false, "Windows 不放进独立进程组（用 taskkill /T）");
    assertEqual(spawnDetachedForTreeKill("linux"), true, "POSIX 新建进程组便于整树杀");
    assertEqual(venvPythonRelativePath("win32"), join("Scripts", "python.exe"), "venv Python（win32）在 Scripts");
    assertEqual(venvPythonRelativePath("linux"), join("bin", "python"), "venv Python（POSIX）在 bin");
    assertEqual(venvPython3RelativePath("win32"), "python.exe", "venv python3（win32）回落 python.exe");
    assertEqual(venvPython3RelativePath("linux"), join("bin", "python3"), "venv python3（POSIX）bin/python3");
    assertEqual(pythonExecutableName("win32"), "python.exe", "解释器文件名（win32）");
    assertEqual(
      pythonProjectCacheKey("ProjDir", "win32"),
      resolve("ProjDir").split(sep).join("/").toLowerCase(),
      "pythonProjectCacheKey(win32)=统一分隔符+小写",
    );
    assertEqual(pythonProjectCacheKey("ProjDir", "linux"), resolve("ProjDir").split(sep).join("/"), "pythonProjectCacheKey(linux) 保留大小写");
    assertEqual(uvExecutableName("win32"), "uv.exe", "uv 可执行名（win32）");
    assertEqual(uvExecutableName("linux"), "uv", "uv 可执行名（POSIX）");
    assertEqual(uvAssetName("win32", "x64"), "uv-x86_64-pc-windows-msvc.zip", "uv 资产：win32/x64");
    assertEqual(uvAssetName("win32", "arm64"), "uv-aarch64-pc-windows-msvc.zip", "uv 资产：win32/arm64");
    assertEqual(uvAssetName("darwin", "arm64"), "uv-aarch64-apple-darwin.tar.gz", "uv 资产：darwin/arm64");
    assertEqual(uvAssetName("linux", "x64"), "uv-x86_64-unknown-linux-gnu.tar.gz", "uv 资产：linux/x64");
    let archThrew = false;
    try { uvAssetName("linux", "ia32" as NodeJS.Architecture); } catch { archThrew = true; }
    assert(archThrew, "uv 资产：不支持的架构直接抛错（不做猜测式回退）");
    let platformThrew = false;
    try { uvAssetName("freebsd" as NodeJS.Platform, "x64"); } catch { platformThrew = true; }
    assert(platformThrew, "uv 资产：不支持的平台直接抛错");
  }

  // ------------------------------------------------------------ 8) terminal
  console.log("== 8) platform/terminal（默认 shell / ConPTY）==");
  {
    const winEnv = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv;
    assertEqual(
      defaultShellForPlatform("windows", { exists: () => true, env: winEnv }),
      join("C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
      "Windows：存在 pwsh 7 时优先 PowerShell 7",
    );
    assertEqual(
      defaultShellForPlatform("windows", { exists: () => false, env: winEnv }),
      join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "Windows：无 pwsh 7 时回退 Windows PowerShell 5.1",
    );
    assertEqual(
      defaultShellForPlatform("windows", { exists: () => true, env: {} as NodeJS.ProcessEnv }),
      join("C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
      "Windows：ProgramFiles 未设置时用默认 C:\\Program Files",
    );
    assertEqual(defaultShellForPlatform("linux", { env: { SHELL: "/bin/fish" } as NodeJS.ProcessEnv }), "/bin/fish", "POSIX：优先 $SHELL");
    assertEqual(defaultShellForPlatform("linux", { env: {} as NodeJS.ProcessEnv }), "/bin/bash", "Linux 未设置 SHELL → bash");
    assertEqual(defaultShellForPlatform("macos", { env: {} as NodeJS.ProcessEnv }), "/bin/zsh", "macOS 未设置 SHELL → zsh");
    assertEqual(posixDefaultShell("macos"), "/bin/zsh", "posixDefaultShell(macos)");
    assertEqual(posixDefaultShell("linux"), "/bin/bash", "posixDefaultShell(linux)");
    assertEqual(pwshPath({} as NodeJS.ProcessEnv, "linux"), "pwsh", "POSIX 上 pwsh 就是命令名");
    assertEqual(windowsPowerShellPath({} as NodeJS.ProcessEnv, "linux"), "powershell.exe", "POSIX 上 PowerShell 命令名");
    assertEqual(useConpty("windows"), true, "Windows 终端用 ConPTY");
    assertEqual(useConpty("linux"), false, "POSIX 不用 ConPTY");
  }

  // ------------------------------------------------------------ 9) apps
  console.log("== 9) platform/apps（where/which、npx、adb、外部 CLI）==");
  {
    assertEqual(whereCommand("win32"), "where", "Windows 用 where");
    assertEqual(whereCommand("win32", { exe: true }), "where.exe", "Windows where.exe 形式");
    assertEqual(whereCommand("linux"), "which", "POSIX 用 which");

    const winRows = ["C:\\tools\\npx", "C:\\tools\\npx.ps1", "C:\\tools\\npx.cmd", "C:\\tools\\npx.exe"];
    assertEqual(pickExecutablePath(winRows, "win32"), "C:\\tools\\npx.exe", "Windows 优先 .exe");
    assertEqual(pickExecutablePath(["C:\\a\\npx.cmd", "C:\\a\\npx.ps1"], "win32"), "C:\\a\\npx.cmd", ".cmd 优先于 .ps1");
    assertEqual(pickExecutablePath(["C:\\a\\npx", "C:\\a\\npx.ps1"], "win32"), "C:\\a\\npx.ps1", "只有 .ps1 时用 .ps1");
    assertEqual(pickExecutablePath(["/usr/bin/npx", "/usr/local/bin/npx"], "linux"), "/usr/bin/npx", "POSIX 取第一行");
    assertEqual(pickExecutablePath([], "linux"), null, "空列表 → null");

    const whereCalls: string[] = [];
    const fakeExec = (command: string, args: string[]) => {
      whereCalls.push(`${command} ${args.join(" ")}`);
      return "C:\\tools\\npx.cmd\r\nC:\\tools\\npx.exe\r\n";
    };
    assertEqual(whereFirst("npx", "win32", { execFileSync: fakeExec }), "C:\\tools\\npx.exe", "whereFirst(win32) 走扩展名优先级");
    assertEqual(whereCalls[0], "where.exe npx", "whereFirst 调 where.exe");
    assertEqual(whereFirst("npx", "linux", { execFileSync: () => "/usr/bin/npx\n/usr/local/bin/npx\n" }), "/usr/bin/npx", "whereFirst(linux) 取第一行");
    assertEqual(
      whereFirst("nope", "linux", { execFileSync: () => { throw new Error("not found"); } }),
      null,
      "whereFirst：命令缺失 → null（不抛错）",
    );

    const devinEnv = { LOCALAPPDATA: "C:\\Users\\u" } as NodeJS.ProcessEnv;
    assertEqual(
      devinDesktopBundledCli(devinEnv, "win32", { exists: () => true }),
      join("C:\\Users\\u", "Programs", "Devin", "resources", "app", "extensions", "windsurf", "devin", "bin", "devin.exe"),
      "Devin 桌面自带 CLI 路径（Windows）",
    );
    assertEqual(devinDesktopBundledCli(devinEnv, "linux", { exists: () => true }), null, "Devin 桌面自带 CLI 只在 Windows 生效");
    assertEqual(devinDesktopBundledCli({} as NodeJS.ProcessEnv, "win32", { exists: () => true }), null, "缺 LOCALAPPDATA → null");
    assertEqual(devinDesktopBundledCli(devinEnv, "win32", { exists: () => false }), null, "文件不存在 → null");

    // 外部 CLI 启动方式（假 spawn / 假 where）
    type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };
    const makeSpawn = (calls: SpawnCall[]) =>
      ((command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return {} as never;
      }) as never;
    const noWhere = { execFileSync: () => { throw new Error("not found"); } };

    const spawnCalls: SpawnCall[] = [];
    spawnExternalCliCommand("C:\\tools\\agent.ps1", ["--flag"], "/tmp/cwd", "win32", {
      ...noWhere,
      spawn: makeSpawn(spawnCalls),
    });
    assertEqual(spawnCalls[0]!.command, "powershell.exe", "Windows .ps1 → powershell.exe");
    assert(
      spawnCalls[0]!.args.slice(0, 4).join(" ") === "-NoProfile -ExecutionPolicy Bypass -File",
      "Windows .ps1 用 -File 直接执行（不经 cmd）",
    );

    const cmdCalls: SpawnCall[] = [];
    spawnExternalCliCommand("cmdc", ["--acp"], "/tmp/cwd", "win32", {
      execFileSync: () => "C:\\tools\\cmdc.cmd\r\n",
      spawn: makeSpawn(cmdCalls),
    });
    assertEqual(cmdCalls[0]!.command, "cmd.exe", "Windows .cmd → cmd.exe");
    assertEqual(cmdCalls[0]!.args, ["/d", "/s", "/c", "C:\\tools\\cmdc.cmd --acp"], ".cmd 命令行按 Windows 规则引号拼接");

    const exeCalls: SpawnCall[] = [];
    spawnExternalCliCommand("C:\\tools\\agent.exe", ["a"], "/tmp/cwd", "win32", { ...noWhere, spawn: makeSpawn(exeCalls) });
    assertEqual(exeCalls[0]!.command, "C:\\tools\\agent.exe", "Windows .exe 直接 spawn");

    const posixCalls: SpawnCall[] = [];
    spawnExternalCliCommand("codex", ["--version"], "/tmp/cwd", "linux", {
      execFileSync: () => "/usr/bin/codex\n",
      spawn: makeSpawn(posixCalls),
    });
    assertEqual(posixCalls[0]!.command, "/usr/bin/codex", "POSIX 直接 spawn 解析后的路径");

    assertEqual(
      commandCodeAcpEnv("/usr/local/bin/cmdc", "linux"),
      { COMMAND_CODE_ACP_CMD_PATH: "/usr/local/bin/cmdc" },
      "Command Code（POSIX）：注入 CMD_PATH",
    );
    assertEqual(
      commandCodeAcpEnv("C:\\tools\\cmdc", "win32", { exists: () => true }),
      { COMMAND_CODE_ACP_NODE_ENTRY: join(dirname("C:\\tools\\cmdc"), "node_modules", "command-code", "dist", "index.mjs") },
      "Command Code（Windows）：注入 NODE_ENTRY",
    );
    let ccThrew = false;
    try { commandCodeAcpEnv("C:\\tools\\cmdc", "win32", { exists: () => false }); } catch { ccThrew = true; }
    assert(ccThrew, "Command Code（Windows）：Node 入口缺失时明确抛错");

    assertEqual(adbExecutableName("win32"), "adb.exe", "adb（win32）带 .exe");
    assertEqual(adbExecutableName("linux"), "adb", "adb（POSIX）");
    const adb = adbCandidatePaths("win32", {
      MYBUDDY_ADB_PATH: "/custom/adb.exe",
      ANDROID_SDK_ROOT: "C:\\sdk",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      PATH: "C:\\bin;C:\\other",
    } as NodeJS.ProcessEnv);
    assertEqual(adb[0], "/custom/adb.exe", "adb 候选：MYBUDDY_ADB_PATH 优先");
    assertEqual(adb[1], join("C:\\sdk", "platform-tools", "adb.exe"), "adb 候选：ANDROID_SDK_ROOT");
    assert(adb.includes(join("C:\\Users\\u\\AppData\\Local", "Android", "Sdk", "platform-tools", "adb.exe")), "adb 候选：Windows 默认 SDK 目录");
    assert(adb.includes(join("C:\\bin", "adb.exe")) && adb.includes(join("C:\\other", "adb.exe")), "adb 候选：PATH 各项");
    assertEqual(adb[adb.length - 1], "adb.exe", "adb 候选：最后回落裸名");
    const adbLinux = adbCandidatePaths("linux", { PATH: "/usr/bin:/usr/local/bin" } as NodeJS.ProcessEnv);
    assert(!adbLinux.some((one) => one.includes("Android")), "Linux 不加 Windows 默认 SDK 目录");

    assertEqual(npxProbeCommand("win32"), "where", "npx 探测：Windows where");
    assertEqual(npxProbeCommand("linux"), "which", "npx 探测：POSIX which");
    assertEqual(npxFallbackPaths("win32"), ["C:\\Program Files\\nodejs\\npx.cmd", "C:\\Program Files (x86)\\nodejs\\npx.cmd"], "npx 回退路径（Windows）");
    assertEqual(npxFallbackPaths("linux"), ["/usr/bin/npx", "/usr/local/bin/npx"], "npx 回退路径（POSIX）");

    assertEqual(connectorPlatformKey("win32"), "win32", "连接器清单平台键 = NodeJS platform 名");
    assertEqual(roamingAppDataDir("/home/u", "linux"), "", "POSIX 没有漫游目录（空串表示跳过）");
    assertEqual(roamingAppDataDir("/home/u", "win32", { APPDATA: "C:\\Roaming" } as NodeJS.ProcessEnv), "C:\\Roaming", "Windows 用 %APPDATA%");
    assertEqual(roamingAppDataDir("/home/u", "win32", {} as NodeJS.ProcessEnv), join("/home/u", "AppData", "Roaming"), "Windows 无 %APPDATA% 时回落 home");
  }

  // ------------------------------------------------------------ 10) input
  console.log("== 10) platform/input（全选修饰键）==");
  {
    assertEqual(selectAllModifier("macos"), "meta", "macOS 全选用 meta(Command)");
    assertEqual(selectAllModifier("windows"), "control", "Windows 全选用 control");
    assertEqual(selectAllModifier("linux"), "control", "Linux 全选用 control");
  }

  // ------------------------------------------------------------ 11) fs-security
  console.log("== 11) platform/fs-security（可执行位 / Windows ACL）==");
  {
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    ensureExecutableFile("/tmp/script.sh", "windows", { chmodSync: (path, mode) => chmodCalls.push({ path, mode }) });
    assertEqual(chmodCalls.length, 0, "Windows：可执行位是空操作（不 chmod）");
    ensureExecutableFile("/tmp/script.sh", "linux", { chmodSync: (path, mode) => chmodCalls.push({ path, mode }) });
    assertEqual(chmodCalls[0], { path: "/tmp/script.sh", mode: 0o755 }, "POSIX：chmod 0755");
    let swallowed = true;
    try {
      ensureExecutableFile("/tmp/x", "linux", { chmodSync: () => { throw new Error("EPERM"); } });
    } catch { swallowed = false; }
    assert(swallowed, "chmod 失败是 best effort（不抛）");

    const posixChmod: Array<{ path: string; mode: number }> = [];
    const posixExec: string[] = [];
    protectSecretFile("/tmp/secret.json", "linux", {
      chmodSync: (path, mode) => posixChmod.push({ path, mode }),
      execFileSync: ((file: string) => { posixExec.push(file); return ""; }) as never,
    });
    assertEqual(posixChmod[0], { path: "/tmp/secret.json", mode: 0o600 }, "POSIX：密钥文件 chmod 0600");
    assertEqual(posixExec.length, 0, "POSIX：不调 icacls/whoami");

    const winChmod: Array<{ path: string; mode: number }> = [];
    const winExec: Array<{ file: string; args: readonly string[] }> = [];
    protectSecretFile("C:\\secret.json", "windows", {
      chmodSync: (path, mode) => winChmod.push({ path, mode }),
      execFileSync: ((file: string, args: readonly string[]) => {
        winExec.push({ file, args });
        return file.endsWith("whoami.exe") ? "DOMAIN\\user,S-1-5-21-111-222-333-1001\r\n" : "";
      }) as never,
      env: { SystemRoot: "C:\\Windows" } as NodeJS.ProcessEnv,
    });
    assertEqual(winChmod[0], { path: "C:\\secret.json", mode: 0o600 }, "Windows：仍先 chmod 0600");
    assertEqual(winExec.length, 2, "Windows：whoami + icacls 各一次");
    assert(winExec[0]!.file.endsWith("whoami.exe"), "Windows：用 whoami.exe 取 SID");
    assert(winExec[1]!.args.includes("/inheritance:r"), "Windows：icacls 去掉继承");
    assert(
      winExec[1]!.args.includes("*S-1-5-21-111-222-333-1001:(F)") && winExec[1]!.args.includes("*S-1-5-18:(F)"),
      "Windows：只授权当前用户与 SYSTEM",
    );

    let sidThrew = false;
    try {
      protectSecretFile("C:\\secret.json", "windows", {
        chmodSync: () => undefined,
        execFileSync: (() => "no-sid-here") as never,
        env: {} as NodeJS.ProcessEnv,
      });
    } catch { sidThrew = true; }
    assert(sidThrew, "Windows：拿不到 SID 时致命失败（不静默降级）");
  }

  // ------------------------------------------------------------ 12) 进程树终止
  console.log("== 12) platform/processes 进程树终止 ==");
  {
    const noopChild = (pid: number | null | undefined, kills: Array<string | undefined>) => ({
      pid,
      kill: (signal?: NodeJS.Signals) => kills.push(signal),
    }) as KillableChild;

    // No real signal/process dependency is used, even if this regression fails.
    for (const pid of [0, 1, -1, -42, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const effects: string[] = [];
      for (const mode of [
        { platform: "linux" }, { platform: "linux", groupKill: false },
        { platform: "macos" }, { platform: "macos", groupKill: false },
        { platform: "windows" }, { platform: "windows", windowsMode: "execFile" },
      ] as const) {
        const timer = killProcessTree({ pid, kill: () => { effects.push("child.kill"); } }, {
          ...mode,
          posixSignal: "SIGTERM", escalateSignal: "SIGKILL", escalateAfterMs: 5,
          childEscalation: { signal: "SIGKILL", afterMs: 5 },
          killProcess: () => { effects.push("signal"); return true; },
          spawnTaskkill: () => { effects.push("spawn taskkill"); return {}; },
          execFileTaskkill: () => { effects.push("exec taskkill"); return {}; },
          onMissingPid: () => { effects.push("missing-pid fallback"); },
          onPosixError: () => { effects.push("POSIX fallback"); },
          onWindowsError: () => { effects.push("Windows fallback"); },
        });
        if (timer) { effects.push("escalation timer"); clearTimeout(timer); }
      }
      assertEqual(effects, [], `无效/保留 pid=${String(pid)}：各平台不发信号、不杀 child、不调用回退或创建升级计时器`);
    }

    const spawnTaskkillCalls: Array<{ command: string; args: string[] }> = [];
    const winKills: Array<string | undefined> = [];
    killProcessTree(noopChild(123, winKills), {
      platform: "windows",
      spawnTaskkill: (command, args) => { spawnTaskkillCalls.push({ command, args }); return {}; },
    });
    assertEqual(spawnTaskkillCalls[0], { command: "taskkill", args: ["/PID", "123", "/T", "/F"] }, "Windows：taskkill /PID /T /F");
    assertEqual(winKills.length, 0, "Windows：taskkill 成功时不再 child.kill");

    const execCalls: Array<{ command: string; args: string[] }> = [];
    let unrefed = false;
    let windowsError = 0;
    killProcessTree(noopChild(456, []), {
      platform: "windows",
      windowsMode: "execFile",
      unref: true,
      onWindowsError: () => { windowsError += 1; },
      execFileTaskkill: (command, args, done) => {
        execCalls.push({ command, args });
        done(new Error("taskkill failed"));
        return { unref: () => { unrefed = true; } };
      },
    });
    assertEqual(execCalls[0]!.command, "taskkill", "Windows execFile 模式用 taskkill");
    assert(unrefed, "Windows execFile 模式 unref（不阻塞退出）");
    assertEqual(windowsError, 1, "Windows execFile 失败 → onWindowsError");

    const posixSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const posixChildKills: Array<string | undefined> = [];
    const timer = killProcessTree(noopChild(50, posixChildKills), {
      platform: "linux",
      posixSignal: "SIGTERM",
      escalateSignal: "SIGKILL",
      escalateAfterMs: 5,
      killProcess: (pid, signal) => { posixSignals.push({ pid, signal }); return true; },
    });
    assert(!!timer, "POSIX 组杀返回升级计时器（调用方负责清理）");
    await new Promise((done) => setTimeout(done, 30));
    if (timer) clearTimeout(timer);
    assertEqual(
      posixSignals,
      [{ pid: -50, signal: "SIGTERM" }, { pid: -50, signal: "SIGKILL" }],
      "POSIX：先 SIGTERM 组杀，再按 grace 升级 SIGKILL",
    );
    assertEqual(posixChildKills.length, 0, "POSIX 组杀成功时不 child.kill");

    const fallbackKills: Array<string | undefined> = [];
    killProcessTree(noopChild(60, fallbackKills), {
      platform: "linux",
      posixSignal: "SIGKILL",
      killProcess: () => { throw new Error("ESRCH"); },
    });
    assertEqual(fallbackKills, ["SIGKILL"], "POSIX 组杀失败 → 回退 child.kill(SIGKILL)");

    const freeCadKills: Array<string | undefined> = [];
    killProcessTree(noopChild(70, freeCadKills), { platform: "linux", groupKill: false });
    assertEqual(freeCadKills, [undefined], "groupKill=false（FreeCAD）：只 child.kill()");

    let missingPid = 0;
    for (const pid of [null, undefined]) {
      killProcessTree(noopChild(pid, []), { platform: "linux", onMissingPid: () => { missingPid += 1; } });
    }
    assertEqual(missingPid, 2, "pid 为 null/undefined 时仍调用 onMissingPid（各调用点语义不同）");
  }


  // ------------------------------------------------------------ 13) 平台拆分 G
  console.log("== 13) Python venv / 磁盘兜底 / execute_code 门控 / bash 名 ==");
  {
    // PythonProjectDiscovery 用的 venv 解释器相对路径片段
    assertEqual(pythonVenvInterpreterParts("win32"), ["Scripts", "python.exe"], "venv 解释器片段（win32）= Scripts/python.exe");
    assertEqual(pythonVenvInterpreterParts("linux"), ["bin", "python"], "venv 解释器片段（linux）= bin/python");
    assertEqual(pythonVenvInterpreterParts("darwin"), ["bin", "python"], "venv 解释器片段（macOS）= bin/python");
    assertEqual(
      pythonVenvInterpreterParts("win32").join("/"),
      venvPythonRelativePath("win32").split(sep).join("/"),
      "与 venvPythonRelativePath 同源（同一事实两个入口）",
    );

    // execute_code 的 language 门控（Windows 顺序保持迁移前：javascript, python, powershell, shell）
    assertEqual(
      executeCodeLanguages("windows"),
      ["javascript", "python", "powershell", "shell"],
      "execute_code schema（Windows）含 powershell，顺序与迁移前一致",
    );
    assertEqual(executeCodeLanguages("linux"), ["javascript", "python", "shell"], "execute_code schema（Linux）不含 powershell");
    assertEqual(executeCodeLanguages("macos"), ["javascript", "python", "shell"], "execute_code schema（macOS）不含 powershell");

    // ensureExecutable（UvToolchain 的 uv 二进制）
    const uvChmod: Array<{ path: string; mode: number }> = [];
    ensureExecutable("/opt/mybuddy/uv", "linux", { chmodSync: (path, mode) => uvChmod.push({ path, mode }) });
    assertEqual(uvChmod[0], { path: "/opt/mybuddy/uv", mode: 0o755 }, "ensureExecutable（POSIX）chmod 0755");
    const winUvChmod: Array<{ path: string; mode: number }> = [];
    ensureExecutable("C:\\mybuddy\\uv.exe", "windows", { chmodSync: (path, mode) => winUvChmod.push({ path, mode }) });
    assertEqual(winUvChmod.length, 0, "ensureExecutable（Windows）是空操作");

    // 磁盘容量兜底（AppSettingsStore.getDiskSpace 的 PowerShell 分支）
    let linuxRan = false;
    const linuxDisk = readDiskSpaceFallback("/home/u/.mybuddy", "linux", {
      execSync: () => { linuxRan = true; return ""; },
    });
    assertEqual(linuxDisk, null, "非 Windows：磁盘兜底直接返回 null");
    assertEqual(linuxRan, false, "非 Windows：不执行 PowerShell");

    const winCmds: string[] = [];
    const winDisk = readDiskSpaceFallback("C:\\Users\\u\\.mybuddy", "windows", {
      execSync: (cmd) => { winCmds.push(cmd); return "123456\n789012\r\n"; },
    });
    assertEqual(winDisk, { usedBytes: 123456, totalBytes: 912468, freeBytes: 789012 }, "Windows：解析 Used/Free 两行");
    assertEqual(
      winCmds[0],
      'powershell -NoProfile -Command "(Get-PSDrive C).Used,(Get-PSDrive C).Free"',
      "Windows：命令与迁移前逐字一致（盘符取首字母大写）",
    );
    const driveDCmds: string[] = [];
    readDiskSpaceFallback("d:/data", "windows", {
      execSync: (cmd) => { driveDCmds.push(cmd); return "1\n2"; },
    });
    assert(driveDCmds[0]!.includes("Get-PSDrive D"), "Windows：小写盘符目录也取大写盘符");
    assertEqual(
      readDiskSpaceFallback("C:\\x", "windows", { execSync: () => { throw new Error("powershell missing"); } }),
      null,
      "Windows：PowerShell 失败 → null（上层继续 statfs/0 兜底）",
    );
    assertEqual(parsePowerShellDiskSpace("100\n200"), { usedBytes: 100, totalBytes: 300, freeBytes: 200 }, "解析两行输出");
    assertEqual(parsePowerShellDiskSpace("100"), { usedBytes: 100, totalBytes: 100, freeBytes: 0 }, "只有一行时 free=0（与原实现一致）");
    assertEqual(parsePowerShellDiskSpace(""), { usedBytes: 0, totalBytes: 0, freeBytes: 0 }, "空输出按 0 处理（与迁移前 parseInt||0 一致）");
    assertEqual(parsePowerShellDiskSpace("abc\ndef"), { usedBytes: 0, totalBytes: 0, freeBytes: 0 }, "非数字输出按 0 处理");

    // Bash 可执行名（Pi shellPath 判定）
    for (const name of ["bash", "sh", "bash.exe", "sh.exe", "BASH.EXE", " bash "]) {
      assert(isBashExecutableName(name), `Bash 可执行名接受 ${JSON.stringify(name)}`);
    }
    for (const name of ["zsh", "fish", "powershell.exe", "bash_profile", "bashx", ""]) {
      assert(!isBashExecutableName(name), `Bash 可执行名拒绝 ${JSON.stringify(name)}`);
    }
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
