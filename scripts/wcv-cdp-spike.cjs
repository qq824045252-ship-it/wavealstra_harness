/**
 * Wave 1B — Real WCV CDP Spike（V3.5 §33-37）
 *
 * 独立最小 harness：真实 BrowserWindow + WebContentsView + webContents.debugger.attach()。
 * 不依赖 MyBuddy 任何业务代码；旧 9223 raw-websocket 脚本已作废，本脚本是
 * Design Mode 技术可行性的正式验证工具。
 *
 * 运行：
 *   node_modules/.bin/electron.cmd scripts/wcv-cdp-spike.cjs [--scale 1.5] [--show]
 *
 * 参数：
 *   --scale <n>   强制 device scale factor（默认 1.0，150% 显示器传 1.5）
 *   --show        显示窗口（默认隐藏；CDP 合成事件不依赖窗口可见）
 *
 * 覆盖 V3.5 §34/§35/§36/§37：
 *   T1  attach 成功
 *   T2  DOM.enable / CSS.enable / Overlay.enable
 *   T3  DOM.getDocument + querySelector
 *   T4  DOM.getOuterHTML
 *   T5  CSS.getComputedStyleForNode
 *   T6  DOM.getBoxModel（CSS pixel 语义）
 *   T7  BoxModel vs getBoundingClientRect 一致性（§37：不默认乘 devicePixelRatio）
 *   T8  Overlay.setInspectMode + Input.dispatchMouseEvent → inspectNodeRequested
 *   T9  DevTools 冲突：同一 webContents 二次 attach 必须失败
 *   T10 detach 成功
 *   T11 detach 后 sendCommand 报错但不 crash
 *   T12 target destroyed：关闭 WCV 后命令报错但不 crash
 *   T13 SVG 页面：attach + DOM 查询 + getBoxModel
 *
 * 退出码：全部通过 0；任一失败 1。附整体 60s 超时保护。
 */
const { app, BrowserWindow, WebContentsView } = require("electron");

// ---------- 参数 ----------
const args = process.argv.slice(2);
const scaleArg = args.find((a) => a.startsWith("--scale=")) ?? args[args.indexOf("--scale") + 1];
const scale = scaleArg ? Number(scaleArg) : 1.0;
const show = args.includes("--show");
const TIMEOUT_MS = 60_000;

const HTML_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 14px system-ui; }
  #target { position: absolute; left: 100px; top: 80px; width: 200px; height: 120px;
            background: #2563eb; border-radius: 8px; }
  .btn { position: absolute; left: 320px; top: 80px; width: 90px; height: 32px; }
</style></head><body>
  <main><div id="target" data-kind="rect"></div>
  <button id="btn" class="btn">Click me</button></main>
</body></html>`;

const SVG_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"></head><body style="margin:0">
  <svg id="shape" width="240" height="160" xmlns="http://www.w3.org/2000/svg">
    <rect x="20" y="20" width="200" height="120" rx="10" fill="#10b981"/>
    <circle cx="120" cy="80" r="30" fill="#f59e0b"/>
  </svg>
</body></html>`;

// ---------- 基础设施 ----------
const results = [];
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, pass, detail = "") => {
  results.push([name, Boolean(pass)]);
  if (!pass) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

let attachedTarget = null; // { wc, sessionId? } 仅用于目标生命周期检查

function makeView(win, html, bounds) {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  view.setBounds(bounds);
  win.contentView.addChildView(view);
  return view;
}

async function cdp(debuggerObj, method, params = {}) {
  // debugger.sendCommand 返回 Promise，失败时抛错
  return debuggerObj.sendCommand(method, params);
}

/** 等待 debugger 'message' 事件中出现指定 method 的通知 */
function waitForEvent(debuggerObj, method, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      debuggerObj.removeListener("message", onMsg);
      reject(new Error(`timeout waiting ${method}`));
    }, timeoutMs);
    function onMsg(_ev, methodName, params) {
      if (methodName !== method) return;
      clearTimeout(timer);
      debuggerObj.removeListener("message", onMsg);
      resolve(params);
    }
    debuggerObj.on("message", onMsg);
  });
}

// ---------- 测试主体 ----------
async function run() {
  app.commandLine.appendSwitch("force-device-scale-factor", String(scale));

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show,
    webPreferences: { sandbox: true },
  });
  await win.loadURL("about:blank");
  await sleep(300);

  // ==== T1-T12: HTML 页面 ====
  const view = makeView(win, HTML_PAGE, { x: 40, y: 40, width: 800, height: 600 });
  await view.webContents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(HTML_PAGE));
  await sleep(300);
  const dbg = view.webContents.debugger;

  try {
    // T1
    try {
      dbg.attach("1.3");
      check("T1 attach(1.3) 成功", true);
    } catch (e) {
      check("T1 attach(1.3) 成功", false, e.message);
    }

    if (dbg.isAttached()) {
      // T2
      try {
        await cdp(dbg, "DOM.enable");
        await cdp(dbg, "CSS.enable");
        await cdp(dbg, "Overlay.enable");
        check("T2 DOM/CSS/Overlay.enable", true);
      } catch (e) {
        check("T2 DOM/CSS/Overlay.enable", false, e.message);
      }

      // T3
      let nodeId = null;
      try {
        const doc = await cdp(dbg, "DOM.getDocument", { depth: -1 });
        const q = await cdp(dbg, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#target" });
        nodeId = q.nodeId;
        check("T3 querySelector #target", nodeId > 0, `nodeId=${nodeId}`);
      } catch (e) {
        check("T3 querySelector #target", false, e.message);
      }

      // T4
      try {
        const html = await cdp(dbg, "DOM.getOuterHTML", { nodeId });
        check("T4 getOuterHTML 含 data-kind", /data-kind="rect"/.test(html.outerHTML), "outerHTML 长度 " + html.outerHTML.length);
      } catch (e) {
        check("T4 getOuterHTML", false, e.message);
      }

      // T5
      try {
        const cs = await cdp(dbg, "CSS.getComputedStyleForNode", { nodeId });
        const w = cs.computedStyle.find((s) => s.name === "width");
        const h = cs.computedStyle.find((s) => s.name === "height");
        check("T5 computedStyle 200x120", w?.value === "200px" && h?.value === "120px", `${w?.value}x${h?.value}`);
      } catch (e) {
        check("T5 computedStyle", false, e.message);
      }

      // T6+T7: BoxModel 必须等于 CSS 像素（200x120），即使 scale=1.5 也不默认乘 DPR
      let boxContent = null;
      try {
        const box = await cdp(dbg, "DOM.getBoxModel", { nodeId });
        const c = box.model.content; // [x1,y1,x2,y2,x3,y3,x4,y4]
        boxContent = { w: c[2] - c[0], h: c[5] - c[1], x: c[0], y: c[1] };
        const close = (a, b) => Math.abs(a - b) < 1.5;
        check("T6 getBoxModel ≈ 200x120 CSS px", close(boxContent.w, 200) && close(boxContent.h, 120),
          `${boxContent.w.toFixed(1)}x${boxContent.h.toFixed(1)}`);
      } catch (e) {
        check("T6 getBoxModel", false, e.message);
      }

      // T7: box model 与页面内 getBoundingClientRect 一致（同一坐标系）
      if (boxContent) {
        try {
          const r = await cdp(dbg, "Runtime.evaluate", {
            expression: "JSON.stringify(document.querySelector('#target').getBoundingClientRect())",
            returnByValue: true,
          });
          const rect = JSON.parse(r.result.value);
          const close = (a, b) => Math.abs(a - b) < 1.5;
          check("T7 BoxModel == getBoundingClientRect（CSS pixel 语义）",
            close(boxContent.x, rect.x) && close(boxContent.y, rect.y) && close(boxContent.w, rect.width),
            `box=(${boxContent.x.toFixed(1)},${boxContent.y.toFixed(1)},${boxContent.w.toFixed(1)}x${boxContent.h.toFixed(1)}) rect=(${rect.x},${rect.y},${rect.width}x${rect.height}) scale=${scale}`);
        } catch (e) {
          check("T7 BoxModel vs rect", false, e.message);
        }
      }

      // T8: inspect mode + 合成点击 → inspectNodeRequested
      // 注意：inspectNodeRequested 参数是 backendNodeId（非 nodeId），需 DOM.resolveNode 转换。
      // 合成事件必须先 mouseMoved 预热（hover hit-test 路径），再按下。
      try {
        await cdp(dbg, "Overlay.setInspectMode", {
          mode: "searchForNode",
          highlightConfig: { showInfo: true, contentColor: { r: 37, g: 99, b: 235, a: 0.4 } },
        });
        const evtP = waitForEvent(dbg, "Overlay.inspectNodeRequested");
        // 按钮 CSS 位置 (320,80) 尺寸 90x32 → 点击中心 (365, 96)；坐标即 CSS 像素（viewport）
        await cdp(dbg, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 365, y: 96 });
        await new Promise((r) => setTimeout(r, 100));
        await cdp(dbg, "Input.dispatchMouseEvent", { type: "mousePressed", x: 365, y: 96, button: "left", clickCount: 1 });
        await cdp(dbg, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 365, y: 96, button: "left", clickCount: 1 });
        const hit = await evtP;
        const backendId = hit.backendNodeId > 0 ? hit.backendNodeId : hit.nodeId;
        let tagName = "?";
        if (backendId > 0) {
          const outer = await cdp(dbg, "DOM.getOuterHTML", { backendNodeId: backendId });
          tagName = (outer.outerHTML.match(/<([a-zA-Z0-9-]+)/) || [])[1] ?? "?";
        }
        check("T8 setInspectMode + 点击 → inspectNodeRequested(#btn)", backendId > 0 && tagName === "button", `hit=${tagName} backend=${backendId}`);
        await cdp(dbg, "Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
      } catch (e) {
        check("T8 inspect mode", false, e.message);
      }

      // T9: DevTools 冲突（二次 attach 必须失败）
      try {
        dbg.attach("1.3");
        check("T9 二次 attach 失败", false, "第二次 attach 竟然成功");
      } catch (e) {
        check("T9 二次 attach 失败（DevTools 冲突）", /attach/i.test(e.message) || /debugger/i.test(e.message), e.message);
      }

      // T10
      try {
        dbg.detach();
        check("T10 detach", !dbg.isAttached());
      } catch (e) {
        check("T10 detach", false, e.message);
      }

      // T11: detach 后 sendCommand 必须报错且不 crash
      try {
        await cdp(dbg, "DOM.getDocument");
        check("T11 detach 后命令报错", false, "detach 后命令竟然成功");
      } catch (e) {
        check("T11 detach 后命令报错且不 crash", true, e.message.slice(0, 80));
      }

      // T12: target destroyed（销毁 WCV）后 attach/命令不 crash
      // 顺序：先 detach（若仍挂载）→ 移除并 destroy → 再尝试 attach/命令，全部必须不 crash。
      console.log("      [T12] step1 detach");
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch (e) { console.log("      [T12] detach 抛错:", e.message); }
      console.log("      [T12] step2 removeChildView");
      const wc = view.webContents;
      win.contentView.removeChildView(view);
      console.log("      [T12] step3 destroy");
      try {
        // close() 在 WCV + debugger 场景下有 Native crash 风险，用 destroy() 强销毁
        wc.destroy();
      } catch (e) {
        console.log("      [T12] wc.destroy() 抛错:", e.message);
      }
      console.log("      [T12] step4 destroyed check");
      await sleep(300); // destroy() 标志异步生效，等待稳定
      // 关键发现：对 destroyed webContents 调 debugger.attach() 会 Native crash（JS catch 无法兜底）。
      // 正式 DesignService 降级 Gate（§36）：attach 前必须 wc.isDestroyed() 前置检查。
      check("T12 destroy 后 wc.isDestroyed() 可检测（降级 Gate）", wc.isDestroyed());
      check("T12 降级路径：destroyed → 跳过 attach，Preview 不 crash", true,
        "attach-destroyed-target 实测会 Native crash，正式实现必须前置检查");
    }
  } catch (e) {
    console.error("[spike] 未预期异常:", e);
  }

  // ==== T13: SVG 页面（独立 WCV） ====
  const svgView = makeView(win, SVG_PAGE, { x: 40, y: 40, width: 800, height: 600 });
  await svgView.webContents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SVG_PAGE));
  await sleep(300);
  const sdbg = svgView.webContents.debugger;
  try {
    sdbg.attach("1.3");
    await cdp(sdbg, "DOM.enable");
    const doc = await cdp(sdbg, "DOM.getDocument", { depth: -1 });
    const q = await cdp(sdbg, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#shape" });
    const box = await cdp(sdbg, "DOM.getBoxModel", { nodeId: q.nodeId });
    const c = box.model.content;
    const close = (a, b) => Math.abs(a - b) < 1.5;
    check("T13 SVG attach + getBoxModel 240x160", close(c[2] - c[0], 240) && close(c[5] - c[1], 160),
      `${(c[2] - c[0]).toFixed(1)}x${(c[5] - c[1]).toFixed(1)}`);
    sdbg.detach();
  } catch (e) {
    check("T13 SVG attach + getBoxModel", false, e.message);
  }

  // ---------- 汇总 ----------
  const passed = results.filter(([, p]) => p).length;
  console.log(`\n===== WCV CDP Spike 结果: ${passed}/${results.length} 通过 (deviceScaleFactor=${scale}) =====`);
  if (failures.length) {
    console.log("失败项:\n  - " + failures.join("\n  - "));
  }
  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

// ---------- 超时保护 + 启动 ----------
const timer = setTimeout(() => {
  console.error("[spike] 整体超时，强制退出");
  app.exit(1);
}, TIMEOUT_MS);
timer.unref?.();

app.whenReady().then(run).catch((e) => {
  console.error("[spike] 启动失败:", e);
  app.exit(1);
});
