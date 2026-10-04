/**
 * 设置「模型」页点击被原生 WebContentsView 吃掉的回归门。
 *
 * 机制：设置弹层是 renderer DOM；扩展栏 browser / artifact 是叠在窗口上的 WCV。
 * 模型页把对话框拉到 1120px，更容易压到右栏原生视图。BrowserHost.setBounds 若
 * 无 blocker 合成，ResizeObserver 会把刚 hide 的 WCV 再显示出来。
 *
 * 运行：pnpm test:models-settings-overlay
 */
const { existsSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根（package.json）");
    dir = parent;
  }
}

const ROOT = findRoot(process.cwd());
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const results: Array<{ rule: string; pass: boolean; detail: string }> = [];
function check(rule: string, pass: boolean, detail = ""): void {
  results.push({ rule, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${rule}${detail ? `  — ${detail}` : ""}`);
}

const host = read("src/main/browser/BrowserHost.ts");
const hook = read("src/renderer/src/hooks/useBlockNativeSurfaces.ts");
const settings = read("src/renderer/src/components/settings/SettingsModal.tsx");
const css = read("src/renderer/src/styles/global.css");
const ipc = read("src/shared/agent-ipc.ts");
const preload = read("src/preload/index.ts");
const preloadDts = read("src/preload/index.d.ts");
const main = read("src/main/index.ts");

check(
  "BrowserHost synthesizes visibility from blockers",
  host.includes("this.blockers.size === 0") && host.includes("private applyVisibility()"),
);
check(
  "BrowserHost.setBounds does not force-show",
  /setBounds\(rect: Rectangle\): void \{[\s\S]*?this\.applyVisibility\(\);/.test(host)
    && !/setBounds\(rect: Rectangle\): void \{[\s\S]*?this\.setViewVisible\(true\)/.test(host),
);
check(
  "settings modal registers the shared native-surface blocker",
  settings.includes("useBlockNativeSurfaces(true)"),
);
check(
  "blocker hook uses owner-specific token before paint for artifact and browser",
  hook.includes("useLayoutEffect")
    && hook.includes("useId")
    && hook.includes("renderer-overlay:")
    && hook.includes("artifact?.addBlocker(SURFACE_MAIN, token)")
    && hook.includes("browser?.addBlocker?.(token)")
    && hook.includes("artifact?.removeBlocker(SURFACE_MAIN, token)")
    && hook.includes("browser?.removeBlocker?.(token)"),
);
check(
  "models layout row is bounded so overflow:hidden can scroll",
  css.includes(".models-provider-layout")
    && css.includes("grid-template-rows: minmax(0, 1fr)"),
);
check(
  "browser IPC exposes addBlocker/removeBlocker",
  ipc.includes('addBlocker: "browser:addBlocker"')
    && ipc.includes('removeBlocker: "browser:removeBlocker"'),
);
check(
  "preload and main wire browser blockers",
  preload.includes("BrowserIpc.addBlocker")
    && preloadDts.includes("addBlocker: (token: string) => void")
    && main.includes("browserHost.addBlocker"),
);

const browserHost = read("src/main/browser/BrowserHost.ts");
const browserView = read("src/renderer/src/components/artifact/BrowserView.tsx");
check(
  "explicit refresh bypasses cache for documents and subresources",
  browserHost.includes("this.view.webContents.reloadIgnoringCache()")
    && !browserHost.includes("this.view.webContents.reload()")
    && !browserHost.includes("loadURL(url)"),
);
check(
  "browserFrameKey bump reloads the current page",
  browserView.includes("else browser.hardReload()") && browserView.includes("[activeUrl, browserFrameKey]"),
);

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
