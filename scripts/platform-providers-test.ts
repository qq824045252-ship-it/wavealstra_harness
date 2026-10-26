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
 */
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
import { createPlatformShellTools } from "../src/main/platform/shell-tools";

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

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
