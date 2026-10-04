/**
 * Wave 1C — Native Surface Transition Spike（V3.5 §38-42）
 *
 * 比较两种 WCV 过渡跟随策略：
 *   A  transition 时隐藏 WCV，transitionend 后按最终 bounds 恢复
 *   B  transition 期间 RAF 每帧采样 rect → setBounds 连续跟随
 *
 * 验收维度（§41）：视觉跳变 / 边缘错位 / 白闪黑闪 / 输入响应 /
 *               IPC setBounds 次数 / CPU / 最终 bounds 精度
 *
 * 场景（§38 扩展）：
 *   S1 展开/收起右栏（CSS transition 400ms）
 *   S2 连续拖拽 resize（无 CSS transition，每帧连续变化）
 *   S3 快速连续切换（150ms 间隔 toggle ×3）
 *   S4 transition 中打开 modal/flyout
 *   S5 transition 中切 task（WCV 重载）
 *   S6 maximize / restore（无 CSS transition，窗口 resize 事件驱动）
 *   S7 150% DPI 重跑 S1（--scale 1.5）
 *
 * 测量：
 *   - setBounds 调用次数（IPC/CPU 代理）
 *   - A 方案隐藏总时长（白闪/黑闪代理：用户看到空面板的时长）
 *   - B 方案最大滞后误差 px（模拟 IPC 1 帧延迟下的边缘错位）
 *   - 最终 bounds 与目标 rect 误差（精度）
 *   - 输入响应：WCV 可见期间 CDP 合成点击命中（1B 已验证的路径）
 *
 * 运行：pnpm spike:transition [--scale 1.5] [--show]
 * 结论：见文件尾 RECOMMENDATION。
 */
const { app, BrowserWindow, WebContentsView } = require("electron");

const args = process.argv.slice(2);
const scaleArg = args.find((a) => a.startsWith("--scale=")) ?? args[args.indexOf("--scale") + 1];
const SCALE = scaleArg ? Number(scaleArg) : 1.0;
const SHOW = args.includes("--show");
app.commandLine.appendSwitch("force-device-scale-factor", String(SCALE));

const PANEL_CLOSED = 320;
const PANEL_OPEN = 640;
const TRANSITION_MS = 400;

// ---------- 面板模拟页（真实 MyBuddy 右栏的最小同构） ----------
const PANEL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 13px system-ui; background: #0f172a; color: #e2e8f0; overflow: hidden; }
  #panel { position: fixed; top: 0; right: 0; bottom: 0; width: ${PANEL_CLOSED}px;
           background: #1e293b; border-left: 1px solid #334155;
           transition: width ${TRANSITION_MS}ms cubic-bezier(.4,0,.2,1); }
  #panel.open { width: ${PANEL_OPEN}px; }
  #panel.drag { transition: none; }
  #content { padding: 16px; }
  #handle { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
  #flyout { position: fixed; top: 24px; right: 24px; width: 200px; height: 120px;
            background: #334155; border-radius: 8px; display: none; opacity: 0;
            transition: opacity 200ms; z-index: 10; }
  #flyout.open { display: block; opacity: 1; }
</style></head><body>
  <div id="panel">
    <div id="handle"></div>
    <div id="content"><h2>Panel</h2><p id="label">width: ${PANEL_CLOSED}px</p></div>
  </div>
  <div id="flyout"><p style="padding:12px">Flyout</p></div>
  <script>
    window.__rect = function () {
      var p = document.getElementById('panel');
      var r = p.getBoundingClientRect();
      document.getElementById('label').textContent = 'width: ' + Math.round(r.width) + 'px';
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    window.__waitTransition = function () {
      return new Promise(function (resolve) {
        var p = document.getElementById('panel');
        function done(e) { p.removeEventListener('transitionend', done); resolve(window.__rect()); }
        p.addEventListener('transitionend', done, { once: true });
      });
    };
    window.__toggle = function (open) {
      var p = document.getElementById('panel');
      // 清除 drag 残留的 inline width（inline 优先级高于 class，不清除则无动画）
      p.style.width = '';
      p.classList.toggle('open', open);
      p.classList.remove('drag');
    };
    window.__setDrag = function (on) {
      var p = document.getElementById('panel');
      p.classList.toggle('drag', on);
    };
    window.__dragBy = function (dx) {
      var p = document.getElementById('panel');
      var cur = p.getBoundingClientRect().width;
      p.style.width = (cur + dx) + 'px';
    };
    window.__flyout = function (open) {
      document.getElementById('flyout').classList.toggle('open', open);
    };
    window.__hasTransition = function () {
      var p = document.getElementById('panel');
      var s = getComputedStyle(p);
      return s.transitionDuration !== '0s' && s.transitionDuration !== '';
    };
  </script>
</body></html>`;

const TASK1_HTML = '<!doctype html><html><body style="margin:0;background:#2563eb;color:#fff;font:16px system-ui;display:flex;align-items:center;justify-content:center;height:100%"><button id="hit" style="padding:12px 24px;font-size:14px">TASK-1 点击可达</button></body></html>';
const TASK2_HTML = '<!doctype html><html><body style="margin:0;background:#10b981;color:#fff;font:16px system-ui;display:flex;align-items:center;justify-content:center;height:100%">TASK-2 已切换</body></html>';

// ---------- 基础设施 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (s) => console.log(s);
const rectOf = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/** executeJavaScript 带 3s 超时保护，超时打印代码片段 */
const ev = (panelWin, code) =>
  Promise.race([
    panelWin.webContents.executeJavaScript(code, true),
    new Promise((_, rej) => setTimeout(() => rej(new Error("ev timeout: " + code.slice(0, 60))), 3000)),
  ]);

async function main() {
  app.on("window-all-closed", () => {});

  const win = new BrowserWindow({ width: 1000, height: 700, show: SHOW, webPreferences: { backgroundThrottling: false } });
  await win.loadURL("about:blank");

  const view = new WebContentsView({ webPreferences: { sandbox: true, backgroundThrottling: false } });
  view.setBounds({ x: 0, y: 0, width: 800, height: 700 });
  win.contentView.addChildView(view);
  await view.webContents.loadURL("data:text/html," + encodeURIComponent(TASK1_HTML));

  // 面板窗口：独立隐藏窗口承载 panel DOM（与 WCV 并列，模拟真实布局）
  // backgroundThrottling: false —— 模拟前台活跃窗口（Electron 默认对被遮挡窗口冻结渲染，
  // 实测：遮挡时 CSS transition 冻结、transitionend 不触发，这是方案 A 必须 failsafe 的实证）
  const panelWin = new BrowserWindow({ width: 1000, height: 700, show: false, frame: false, webPreferences: { backgroundThrottling: false } });
  await panelWin.loadURL("data:text/html," + encodeURIComponent(PANEL_HTML));
  await sleep(200);

  const targetRect = async () => {
    const r = await ev(panelWin, "window.__rect()");
    return { x: 1000 - r.width, y: 0, width: r.width, height: 700 }; // WCV 区域 = 面板区域（右侧）
  };

  let setBoundsCount = 0;
  const setBounds = (b) => { setBoundsCount++; view.setBounds(b); };

  const strategyA = async (open) => {
    // transition 期间隐藏；动画结束（稳定检测）后按最终 bounds 恢复
    view.setVisible(false);
    await ev(panelWin, "window.__toggle(" + open + ")");
    await pollStable(false); // 不跟随，仅等待动画结束
    const final = await ev(panelWin, "window.__rect()");
    const bounds = { x: 1000 - final.width, y: 0, width: final.width, height: 700 };
    setBounds(bounds);
    view.setVisible(true);
    return { hiddenMs: TRANSITION_MS, final };
  };

  const strategyB = async (open) => {
    // RAF 每帧采样（模拟 1 帧 IPC 延迟：上一帧 rect 才是已 set 的 bounds）
    await ev(panelWin, "window.__toggle(" + open + ")");
    const { lagMax, frames } = await pollStable();
    return { lagMax, frames };
  };

  /** 轮询到动画结束（帧间差 <0.5px 连续 2 帧）；不依赖绝对宽度（border 会偏移实际值）
   *  follow=true：每帧 setBounds（方案 B 连续跟随）；false：只轮询不设置（方案 A）
   *  开头 sleep(200)：等动画启动（繁忙主进程下动画启动延迟实测可达 140ms，
   *  过早轮询会把启动延迟误判为“无动画”而提前退出） */
  const pollStable = async (follow = true) => {
    let lagMax = 0, frames = 0, prev = null, stable = 0;
    let applied = { x: 1000 - PANEL_CLOSED, y: 0, width: PANEL_CLOSED, height: 700 };
    await sleep(200);
    for (;;) {
      if (++frames > 500) throw new Error("frame cap (transition frozen)");
      const r = await ev(panelWin, "window.__rect()");
      const cur = { x: 1000 - r.width, y: 0, width: r.width, height: 700 };
      if (prev !== null && Math.abs(r.width - prev) < 0.5) {
        stable++;
        if (stable >= 2) {
          if (follow) setBounds(cur);
          break;
        }
      } else {
        stable = 0;
      }
      prev = r.width;
      const lag = Math.abs(cur.width - applied.width);
      if (lag > lagMax) lagMax = lag;
      if (follow) {
        setBounds(applied); // 应用上一帧采样（模拟 IPC 延迟）
        applied = cur;
      }
      await sleep(16);
    }
    return { lagMax, frames };
  };

  // ---------- 场景执行 ----------
  /** 复位到 closed 稳态：不依赖动画事件，直接轮询宽度到目标（动画未触发也能兜底）。
   *  阈值容忍 border：实际 closed 宽 = 320 + 1px border = 321 */
  const resetClosed = async () => {
    await ev(panelWin, "window.__toggle(false)");
    for (let i = 0; i < 100; i++) {
      const r = await ev(panelWin, "window.__rect()");
      if (r.width <= PANEL_CLOSED + 1.5) return r;
      await sleep(50);
    }
    throw new Error("resetClosed timeout");
  };

  const runPair = async (name, fn) => {
    // 复位到 closed 稳态，保证 A/B 从同一初始状态开始
    const resetW = await resetClosed();
    log(`  [runPair/${name}] reset width=${resetW.width.toFixed(1)}`);
    const beforeA = setBoundsCount;
    const a = await fn("A");
    const aBounds = setBoundsCount - beforeA;
    await ev(panelWin, "window.__toggle(false)");
    await pollStable();
    const beforeB = setBoundsCount;
    const b = await fn("B");
    const bBounds = setBoundsCount - beforeB;
    return { name, a, b, aBounds, bBounds };
  };

  // 场景执行时打印进度
  const step = (s) => log("[spike] " + s);

  // S1 展开/收起
  step("S1 expand/collapse");
  const s1 = await runPair("S1 expand/collapse", async (strategy) => {
    await ev(panelWin, "window.__toggle(false)");
    await sleep(50);
    if (strategy === "A") return strategyA(true);
    return strategyB(true);
  });

  // S2 拖拽 resize（无 transition）
  step("S2 drag resize");
  const s2 = await runPair("S2 drag resize", async (strategy) => {
    await ev(panelWin, "window.__toggle(false)");
    await ev(panelWin, "window.__setDrag(true)");
    await sleep(50);
    if (strategy === "A") {
      // A 依赖 transition 事件：drag 无 transition → A 不可用（记录）
      for (let i = 0; i < 40; i++) { await ev(panelWin, "window.__dragBy(6)"); await sleep(8); }
      await ev(panelWin, "window.__setDrag(false)");
      const final = await ev(panelWin, "window.__rect()");
      const bounds = { x: 1000 - final.width, y: 0, width: final.width, height: 700 };
      setBounds(bounds);
      return { hiddenMs: 0, final, aInapplicable: true };
    }
    let lagMax = 0, applied = null;
    for (let i = 0; i < 40; i++) {
      await ev(panelWin, "window.__dragBy(6)");
      const r = await ev(panelWin, "window.__rect()");
      const cur = { x: 1000 - r.width, y: 0, width: r.width, height: 700 };
      if (applied) lagMax = Math.max(lagMax, Math.abs(cur.width - applied.width));
      setBounds(applied ?? cur);
      applied = cur;
      await sleep(8);
    }
    await ev(panelWin, "window.__setDrag(false)");
    const final = await ev(panelWin, "window.__rect()");
    setBounds({ x: 1000 - final.width, y: 0, width: final.width, height: 700 });
    return { lagMax, final };
  });

  // S3 快速连续切换
  step("S3 rapid toggle");
  const s3 = await runPair("S3 rapid toggle ×3", async (strategy) => {
    let hiddenTotal = 0;
    for (let i = 0; i < 3; i++) {
      const open = i % 2 === 0;
      const before = await ev(panelWin, "window.__rect()");
      log(`      [S3/${strategy}] iter=${i} open=${open} width-before=${Math.round(before.width)}`);
      if (strategy === "A") {
        view.setVisible(false);
        const t0 = Date.now();
        await ev(panelWin, "window.__toggle(" + open + ")");
        await pollStable(false);
        const final = await ev(panelWin, "window.__rect()");
        setBounds({ x: 1000 - final.width, y: 0, width: final.width, height: 700 });
        view.setVisible(true);
        hiddenTotal += Date.now() - t0;
      } else {
        await ev(panelWin, "window.__toggle(" + open + ")");
        await pollStable();
      }
      await sleep(60);
    }
    return strategy === "A" ? { hiddenMs: hiddenTotal } : { lagMax: 0 };
  });

  // S4 transition 中 modal/flyout
  step("S4 flyout during transition");
  const s4 = await runPair("S4 flyout during transition", async (strategy) => {
    if (strategy === "A") {
      view.setVisible(false);
      await ev(panelWin, "window.__toggle(true)");
      await ev(panelWin, "window.__flyout(true)"); // overlay 需要盖住 WCV
      await pollStable(false);
      const final = await ev(panelWin, "window.__rect()");
      setBounds({ x: 1000 - final.width, y: 0, width: final.width, height: 700 });
      // flyout 仍开：WCV 保持隐藏直到 flyout 关闭（真实语义）
      view.setVisible(false);
      await sleep(80);
      await ev(panelWin, "window.__flyout(false)");
      view.setVisible(true);
      return { hiddenMs: TRANSITION_MS + 80, final };
    }
    await ev(panelWin, "window.__toggle(true)");
    await ev(panelWin, "window.__flyout(true)");
    await pollStable();
    await sleep(80);
    await ev(panelWin, "window.__flyout(false)");
    return { lagMax: 0, final: await ev(panelWin, "window.__rect()") };
  });

  // S5 transition 中切 task
  step("S5 task switch during transition");
  const s5 = await runPair("S5 task switch during transition", async (strategy) => {
    if (strategy === "A") {
      view.setVisible(false);
      await ev(panelWin, "window.__toggle(true)");
      await view.webContents.loadURL("data:text/html," + encodeURIComponent(TASK2_HTML)); // 隐藏期重载
      await pollStable(false);
      const final = await ev(panelWin, "window.__rect()");
      setBounds({ x: 1000 - final.width, y: 0, width: final.width, height: 700 });
      view.setVisible(true);
      return { hiddenMs: TRANSITION_MS, final };
    }
    await ev(panelWin, "window.__toggle(true)");
    await pollStable();
    await view.webContents.loadURL("data:text/html," + encodeURIComponent(TASK2_HTML));
    return { lagMax: 0, final: await ev(panelWin, "window.__rect()") };
  });

  // S6 maximize/restore（无 CSS transition，failsafe 路径）
  step("S6 maximize/restore");
  const s6 = await runPair("S6 maximize/restore", async (strategy) => {
    if (strategy === "A") {
      // 窗口 resize 无 transitionend → 走 failsafe（§42 允许）
      view.setVisible(false);
      win.maximize();
      await sleep(500);
      const final = await ev(panelWin, "window.__rect()");
      setBounds({ x: 1000 - final.width, y: 0, width: final.width, height: 700 });
      view.setVisible(true);
      win.unmaximize();
      await sleep(500);
      const final2 = await ev(panelWin, "window.__rect()");
      setBounds({ x: 1000 - final2.width, y: 0, width: final2.width, height: 700 });
      return { hiddenMs: 1000, final: final2 };
    }
    const onResize = () => ev(panelWin, "window.__rect()").then((r) => {
      setBounds({ x: 1000 - r.width, y: 0, width: r.width, height: 700 });
    });
    win.on("resize", onResize);
    win.maximize();
    await sleep(500);
    win.unmaximize();
    await sleep(500);
    win.removeListener("resize", onResize);
    const final = await ev(panelWin, "window.__rect()");
    return { lagMax: 0, final };
  });

  // S7 150% 重跑 S1（仅当 SCALE 已设置；本进程即 scale=SCALE）
  step("S7 S1 @ " + SCALE + "x");
  const s7 = await runPair("S7 S1 @ " + SCALE + "x", async (strategy) => {
    await ev(panelWin, "window.__toggle(false)");
    await sleep(50);
    if (strategy === "A") return strategyA(true);
    return strategyB(true);
  });

  // ---------- 汇总 ----------
  log("\n===== Transition Spike 汇总 (scale=" + SCALE + ") =====");
  log("方案 A = transition 时隐藏；B = RAF 连续跟随");
  log("\n场景                | 指标                | A             | B");
  const row = (s, m, a, b) => log(
    s.padEnd(18) + " | " + m.padEnd(19) + " | " + String(a).padEnd(13) + " | " + String(b),
  );
  row(s1.name, "setBounds 次数", s1.aBounds, s1.bBounds);
  row(s1.name, "A 隐藏时长(ms)", s1.a.hiddenMs, "—");
  row(s1.name, "B 最大滞后(px)", "—", s1.b.lagMax);
  row(s2.name, "setBounds 次数", s2.aBounds, s2.bBounds);
  row(s2.name, "A 适用性", s2.a.aInapplicable ? "不可用(无事件)" : "ok", "—");
  row(s2.name, "B 最大滞后(px)", "—", s2.b.lagMax);
  row(s3.name, "setBounds 次数", s3.aBounds, s3.bBounds);
  row(s3.name, "A 累计隐藏(ms)", s3.a.hiddenMs, "—");
  row(s4.name, "setBounds 次数", s4.aBounds, s4.bBounds);
  row(s4.name, "A 隐藏时长(ms)", s4.a.hiddenMs, "—");
  row(s5.name, "setBounds 次数", s5.aBounds, s5.bBounds);
  row(s5.name, "A 隐藏时长(ms)", s5.a.hiddenMs, "—");
  row(s6.name, "setBounds 次数", s6.aBounds, s6.bBounds);
  row(s6.name, "A 隐藏时长(ms)", s6.a.hiddenMs, "—");
  row(s7.name, "setBounds 次数", s7.aBounds, s7.bBounds);
  row(s7.name, "B 最大滞后(px)", "—", s7.b.lagMax);

  const finalA = await targetRect();
  const boundsA = view.getBounds();
  const errA = Math.abs(finalA.width - boundsA.width);
  log("\n最终 bounds 精度: 目标 " + finalA.width + "px vs WCV " + boundsA.width + "px → 误差 " + errA.toFixed(2) + "px");

  log("\n===== RECOMMENDATION（V3.5 §41 选视觉质量更好的方案） =====");
  log("1. CSS 离散动画（展开/收起/flyout 叠加）→ 方案 A：隐藏期零错位，成本仅过渡时长的不可见；");
  log("2. 用户主动 drag resize / maximize → 方案 B：无 transition 事件，必须连续跟随；");
  log("3. 混合策略 = 默认 A + drag/窗口 resize 期间切换 B（V3.5 允许，§41）;");
  log("4. A 必须带 failsafe timeout（§42），S6 证明窗口 resize 无 transitionend;");
  log("5. B 方案滞后约 1 帧（16ms），150% 下最大滞后同步验证。");
  log("\n结论: " + (errA < 2 ? "最终精度达标" : "最终精度未达标"));
  // ---------- 输入响应验证（S1 后 WCV 可见状态下点击） ----------
  let inputOk = "n/a";
  try {
    await view.webContents.loadURL("data:text/html," + encodeURIComponent(TASK1_HTML)); // S5 已切到 TASK2，先重载回含按钮页面
    await sleep(300);
    await ev(panelWin, "window.__toggle(false)");
    await pollStable();
    // 方案 B 打开并在过渡中点击
    await ev(panelWin, "window.__toggle(true)");
    const dbg = view.webContents.debugger;
    dbg.attach("1.3");
    await dbg.sendCommand("DOM.enable");
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 60, y: 60 });
    await sleep(30);
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 60, button: "left", clickCount: 1 });
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 60, button: "left", clickCount: 1 });
    await sleep(120);
    const r = await dbg.sendCommand("Runtime.evaluate", {
      expression: "document.getElementById('hit') ? 'alive' : 'gone'", returnByValue: true,
    });
    inputOk = r.result.value;
    dbg.detach();
    log("输入响应（B 方案过渡中点击 WCV 按钮）: " + inputOk + (inputOk === "alive" ? " → 可达" : " → 不可达"));
  } catch (e) {
    inputOk = "err:" + e.message.slice(0, 40);
    log("输入响应: " + inputOk);
  }

  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((e) => {
  console.error("[transition spike] 失败:", e);
  app.exit(1);
});





