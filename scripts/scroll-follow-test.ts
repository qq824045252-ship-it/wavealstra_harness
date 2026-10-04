/**
 * 贴底跟随状态机（lib/scrollFollow）纯函数单测（无 React / 无 Electron）。
 *
 * 覆盖（对应抖动根因）：
 *   1. 用户上滚后，内容高度变化不恢复 follow（多次 onScroll 各种距离仍 false）
 *   2. 「偶发」场景：小幅上滚（wheel 步长 < 阈值 48px）后 scroll 事件不再误恢复
 *   3. 主动下滚到底部阈值内 → 恢复 follow；下滚但未到底 → 保持退出
 *   4. 程序化滚动（方向 null）不改变任何状态
 *   5. 指针拖动：拖上不恢复、拖下到底恢复、pointercancel 不恢复
 *   6. 任务切换重置：清手势方向 + follow=true；历史跳转：follow=false 且方向清空
 *   7. 阈值边界：=48 恢复，>48 不恢复
 *   8. 流式新增内容在 follow=true 时保持 true（由 ChatView 持续置顶）
 *   9. virtualizer 补偿决策：follow=true 禁止；backward 禁止；仅真实下边缘在
 *      折叠线上方时允许（超长首卡首测跨折叠线不向下拖）
 *  10. 键盘滚动意图：PageUp/↑/Home/End 等；输入框/按钮特殊处理
 *  11. 消息高度内容感知估算（缩小首测 delta）
 *  12. 任务切换重置判定（shouldResetFollow）
 *  13. 新一轮置顶门控（shouldPinOnNewTurn）：用户接管滚动后新消息不得拉回视口
 *
 * 运行：node scripts/scroll-follow-test.ts（或 npm run test:scroll-follow）
 */
import {
  FOLLOW_BOTTOM_THRESHOLD,
  initialFollowState,
  keyboardIntent,
  onHistoryJump,
  onPointerCancel,
  onPointerDown,
  onPointerUp,
  onResetForTask,
  onScroll,
  onUserScrollDown,
  onUserScrollUp,
  onWheelUpCandidate,
  shouldAdjustScrollCompensation,
  shouldInferUserScroll,
  shouldPinOnNewTurn,
  shouldResetFollow,
  type FollowState,
} from "../src/renderer/src/lib/scrollFollow";
import { estimateMessageHeight } from "../src/renderer/src/lib/messageSizeEstimate";
import type { ChatMessage } from "../src/renderer/src/types";

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function main(): void {
  console.log("[scroll-follow-test]");
  assert(FOLLOW_BOTTOM_THRESHOLD === 48, "阈值为 48");

  // ---- 1. 初始状态 ----------------------------------------------------------
  const s0 = initialFollowState();
  assert(s0.follow === true, "初始贴底");
  assert(s0.direction === null && s0.dragStartDistance === null, "初始无手势");

  // ---- 2. 上滚后内容高度变化不恢复 follow（滚动状态机核心回归） -------------
  let s = initialFollowState();
  s = onUserScrollUp(s); // 用户上滚
  assert(s.follow === false && s.direction === "up", "上滚立即退出跟随并锁存方向");
  // 接下来多次 scroll 事件 + 各种距底距离（内容增高/收缩、图片加载）
  for (const d of [200, 0, 30, 500, 10]) {
    s = onScroll(s, d);
    assert(s.follow === false, `上滚后距底 ${d}px 的 scroll 事件不恢复跟随`);
  }

  // ---- 2b. wheel 上滚候选（P2-1：触底回弹/惯性零位移不误锁） -----------------
  // 贴底回弹：deltaY<0 但 scrollTop 零位移 → 不锁存
  s = initialFollowState();
  s = onWheelUpCandidate(s);
  assert(s.follow === true && s.direction === null && s.wheelUpPending === true, "wheel up 仅登记候选，不立即锁存");
  s = onScroll(s, 0, 0); // 零位移（触底回弹）
  assert(s.follow === true && s.wheelUpPending === true, "零位移回弹不误锁（候选保持）");
  // 连续回弹多次仍不锁
  s = onScroll(s, 0, 0);
  s = onScroll(s, 0, 0);
  assert(s.follow === true, "连续零位移回弹仍不误锁");
  // 实际向上位移 → 立即锁存（普通 wheel 上拉语义不破坏）
  s = onScroll(s, 120, -30);
  assert(s.follow === false && s.direction === "up", "实际向上位移确认锁存（立即停止自动跟随）");
  // 锁存后内容增高不恢复
  s = onScroll(s, 0, 0);
  assert(s.follow === false, "锁存后内容增高不回拉");
  // 候选 + 向下位移 → 清除候选（用户实际在向下滚），不锁
  s = initialFollowState();
  s = onWheelUpCandidate(s);
  s = onScroll(s, 200, 40);
  assert(s.follow === true && s.wheelUpPending === false, "候选 + 向下位移 → 清除候选不锁");
  // wheel down 意图清除候选
  s = initialFollowState();
  s = onWheelUpCandidate(s);
  s = onUserScrollDown(s);
  assert(s.wheelUpPending === false && s.direction === "down", "wheel down 清除候选并锁存方向");
  s = onScroll(s, 20, 40);
  assert(s.follow === true, "向下到阈值内恢复跟随");
  // 键盘/推断路径仍立即锁存（必有实际位移）
  s = initialFollowState();
  s = onUserScrollUp(s);
  assert(s.follow === false && s.wheelUpPending === false, "键盘/推断上滚立即锁存（候选语义不影响）");
  // 指针按下/重置/历史跳转清候选
  s = onWheelUpCandidate(initialFollowState());
  assert(onPointerDown(s, 0).wheelUpPending === false, "pointerdown 清候选");
  assert(onResetForTask(onWheelUpCandidate(initialFollowState())).wheelUpPending === false, "重置清候选");
  assert(onHistoryJump(onWheelUpCandidate(initialFollowState())).wheelUpPending === false, "历史跳转清候选");

  // ---- 3. 「偶发」场景：小幅上滚（步长 < 阈值）不再翻转 ---------------------
  s = initialFollowState();
  s = onWheelUpCandidate(s); // wheel up
  s = onScroll(s, 30, -30); // 实际滚了 30px（< 48 阈值）→ 确认锁存
  assert(s.follow === false && s.direction === "up", "小幅上滚确认锁存（方向 up）");
  s = onScroll(s, 30); // 后续 scroll 事件，距底 30 ≤ 阈值
  assert(s.follow === false, "小幅上滚（30px<48）后 scroll 事件不误恢复（历史抖动根因）");

  // ---- 4. 主动下滚到底部 → 恢复；未到底 → 保持退出 --------------------------
  s = initialFollowState();
  s = onUserScrollUp(s);
  s = onUserScrollDown(s); // 用户改向下滚
  s = onScroll(s, 0);
  assert(s.follow === true, "下滚到底部恢复跟随");
  s = onUserScrollUp(s);
  s = onUserScrollDown(s);
  s = onScroll(s, 400);
  assert(s.follow === false, "下滚但未到底（400px）保持退出");

  // ---- 4b. 无手势负位移推断门控（shouldInferUserScroll；#回归：消息被顶出）----
  // virtualizer 首滚估算偏高 → 真实测量收缩 → 浏览器 clamp scrollTop：
  // 负位移但距底仍 ≤ 阈值 → 不是用户上滚，不得锁方向（否则 follow 永久 false，
  // 新一轮发送的置顶被 shouldPinOnNewTurn 跳过，刚发的消息不可见）。
  assert(shouldInferUserScroll(-623, 1) === false, "贴底负位移（内容收缩 clamp）不推断为用户上滚");
  assert(shouldInferUserScroll(-636, 0) === false, "贴底零距负位移不推断");
  assert(shouldInferUserScroll(-30, FOLLOW_BOTTOM_THRESHOLD) === false, "贴底边界（=48）负位移不推断");
  assert(shouldInferUserScroll(-20, 20) === false, "贴底无手势小负位移按布局 clamp 处理；wheel/pointer 另行确认用户意图");
  assert(shouldInferUserScroll(-120, 200) === true, "非贴底负位移 → 推断用户上滚（滚动条拖动/触摸）");
  assert(shouldInferUserScroll(200, 100) === true, "正位移 → 推断用户下滚");
  assert(shouldInferUserScroll(0, 0) === true, "零位移不拦截（外层 delta!==0 已排除）");

  // ---- 5. 程序化滚动（方向 null）不改变状态 ---------------------------------
  s = initialFollowState();
  s = onScroll(s, 0);
  assert(s.follow === true && s.direction === null, "程序化滚动在 follow=true 时不改变");
  s = onUserScrollUp(s);
  s = onScroll(s, 0); // 方向仍 up → 保持退出
  assert(s.follow === false, "程序化滚动不恢复（方向 up 锁存）");
  // 方向 latch 在无手势时不被清掉：再次程序化滚动仍是 false
  s = onScroll(s, 5);
  assert(s.follow === false, "方向锁存不被程序化滚动清除");

  // ---- 6. 指针拖动滚动条 ----------------------------------------------------
  s = initialFollowState();
  s = onPointerDown(s, 0); // 在底部按下滚动条
  assert(s.follow === false && s.pointerScrolling === true, "按下滚动条退出跟随");
  s = onScroll(s, 150); // 拖动中滚动事件不判定
  assert(s.follow === false && s.dragStartDistance === 0, "拖动中滚动事件不判定");
  s = onPointerUp(s, 150); // 拖上（距离增大）
  assert(s.follow === false, "拖上不恢复跟随");
  // 拖下到底：从 150 拖到 0
  s = onPointerDown(s, 150);
  s = onPointerUp(s, 0);
  assert(s.follow === true, "拖下到底恢复跟随");
  // 拖下但停在半途（距底 120）
  s = onPointerDown(s, 400);
  s = onPointerUp(s, 120);
  assert(s.follow === false, "拖下但未到底不恢复");

  // ---- 7. 指针取消不恢复 ----------------------------------------------------
  s = initialFollowState();
  s = onPointerDown(s, 20);
  s = onPointerCancel(s);
  assert(s.follow === false && s.pointerScrolling === false, "pointercancel 退出且不恢复");

  // ---- 8. 任务切换 / 历史跳转 ----------------------------------------------
  s = initialFollowState();
  s = onUserScrollUp(s);
  s = onResetForTask(s);
  assert(s.follow === true && s.direction === null, "任务切换重置为贴底并清方向");
  // 切换后程序化滚动（虚拟列表锚定）不得再误动
  s = onScroll(s, 30);
  assert(s.follow === true, "任务切换后程序化滚动保持贴底");
  s = onHistoryJump(s);
  assert(s.follow === false && s.direction === null, "历史跳转退出跟随并清方向");
  s = onScroll(s, 0);
  assert(s.follow === false, "历史跳转后程序化滚动不恢复");

  // ---- 9. 阈值边界 ----------------------------------------------------------
  s = initialFollowState();
  s = onUserScrollUp(s);
  s = onUserScrollDown(s);
  s = onScroll(s, FOLLOW_BOTTOM_THRESHOLD);
  assert(s.follow === true, "距底=48 恢复");
  s = onUserScrollUp(s);
  s = onUserScrollDown(s);
  s = onScroll(s, FOLLOW_BOTTOM_THRESHOLD + 1);
  assert(s.follow === false, "距底=49 不恢复");

  // ---- 10. 流式新增内容在 follow=true 时保持 true ---------------------------
  s = initialFollowState();
  for (const d of [0, 0, 0]) {
    s = onScroll(s, d);
    assert(s.follow === true, "无手势（流式高度变化伴随程序化滚动）不改变 follow");
  }

  // ---- 10b. 需求回归：assistant_end / 持续 delta 不得回拉 -------------------
  // 手动上拉（锁定）后，后续任意 scroll 事件（text_delta/thinking_delta/
  // markdown 增高/footer 出现/assistant_end 引发的程序化滚动，方向 null 或 up）
  // 都保持 follow=false：持续多次也不回拉。
  s = initialFollowState();
  s = onUserScrollUp(s);
  for (let i = 0; i < 50; i += 1) {
    s = onScroll(s, i % 3 === 0 ? 0 : 120 + i); // 距离任意（含 0）
    assert(s.follow === false, `锁定后第 ${i + 1} 次内容变化不回拉（assistant_end 语义）`);
  }
  // 只有明确的向下手势 + 距底 ≤ 阈值才恢复
  s = onUserScrollDown(s);
  s = onScroll(s, 20);
  assert(s.follow === true, "向下滚到底部阈值内恢复跟随");

  // ---- 11. virtualizer 滚动补偿决策（shouldAdjustScrollCompensation）--------
  // 11.1 follow=true：一律禁止补偿（贴底 pin 独占视口，消除同帧/跨帧竞争）
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 0, cachedSize: 160, delta: 3000, scrollOffset: 5000,
      scrollDirection: null, follow: true,
    }) === false,
    "follow=true 时上方行增高禁止补偿（不与 pin 竞争）",
  );
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 0, cachedSize: 160, delta: -100, scrollOffset: 5000,
      scrollDirection: null, follow: true,
    }) === false,
    "follow=true 时上方行收缩禁止补偿",
  );

  // 11.2 用户向上滚动中（backward）：禁止补偿（滚上去不被长卡补偿抵消）
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 0, cachedSize: 160, delta: 3000, scrollOffset: 8000,
      scrollDirection: "backward", follow: false,
    }) === false,
    "backward 滚动中禁止补偿",
  );

  // 11.3 follow=false + 空闲 + 行完全在折叠线上方 → 允许（真正保持阅读锚点）
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 0, cachedSize: 160, delta: 3000, scrollOffset: 4000,
      scrollDirection: null, follow: false,
    }) === true,
    "空闲时上方行增高允许补偿（保持阅读锚点）",
  );
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 1200, cachedSize: 1800, delta: -150, scrollOffset: 3200,
      scrollDirection: null, follow: false,
    }) === true,
    "空闲时上方行收缩允许补偿（锚点保持）",
  );

  // 11.4 超长首卡首测跨折叠线：估算 160 vs 实测 +3000，折叠线在卡真实内容内
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 0, cachedSize: 160, delta: 3000, scrollOffset: 500,
      scrollDirection: null, follow: false,
    }) === false,
    "超长首卡首测跨折叠线禁止补偿（禁止向下拖数千像素）",
  );

  // 11.5 delta=0 → 禁止（无变化无补偿）
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 0, cachedSize: 160, delta: 0, scrollOffset: 1000,
      scrollDirection: null, follow: false,
    }) === false,
    "delta=0 禁止补偿",
  );

  // 11.6 边界：真实下边缘恰好等于折叠线 → 允许
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 0, cachedSize: 160, delta: 840, scrollOffset: 1000,
      scrollDirection: null, follow: false,
    }) === true,
    "真实下边缘=折叠线边界允许补偿",
  );

  // 11.7 行完全在折叠线下方（start > offset）→ 禁止
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 3000, cachedSize: 160, delta: 2000, scrollOffset: 1000,
      scrollDirection: null, follow: false,
    }) === false,
    "折叠线下方的行增高禁止补偿（#1218 语义）",
  );

  // 11.8 正在流式增长的最末行（跨折叠线）→ 禁止（与 11.4 同规则）
  assert(
    shouldAdjustScrollCompensation({
      itemStart: 4200, cachedSize: 800, delta: 120, scrollOffset: 4600,
      scrollDirection: "forward", follow: false,
    }) === false,
    "跨折叠线流式行禁止补偿（增长在折叠线下方，视口不动）",
  );

  // ---- 12. 键盘滚动意图（keyboardIntent）-----------------------------------
  assert(keyboardIntent("PageUp", false, false, false) === "up", "PageUp → up");
  assert(keyboardIntent("ArrowUp", false, false, false) === "up", "ArrowUp → up");
  assert(keyboardIntent("Home", false, false, false) === "up", "Home → up");
  assert(keyboardIntent(" ", true, false, false) === "up", "Space+Shift → up");
  assert(keyboardIntent("PageDown", false, false, false) === "down", "PageDown → down");
  assert(keyboardIntent("ArrowDown", false, false, false) === "down", "ArrowDown → down");
  assert(keyboardIntent("End", false, false, false) === "down", "End → down");
  assert(keyboardIntent(" ", false, false, false) === "down", "Space → down");
  assert(keyboardIntent(" ", false, false, true) === null, "Space 在按钮上不算滚动意图");
  assert(keyboardIntent(" ", false, true, false) === null, "Space 在输入框不算");
  assert(keyboardIntent("PageUp", false, true, false) === null, "PageUp 在输入框不算");
  assert(keyboardIntent("ArrowDown", false, true, false) === null, "ArrowDown 在输入框不算");
  assert(keyboardIntent("Enter", false, false, false) === null, "无关键 null");
  assert(keyboardIntent("ArrowUp", true, false, false) === "up", "Shift+ArrowUp 仍 up");

  // ---- 13. 消息高度内容感知估算（estimateMessageHeight）---------------------
  const userMsg = (text: string): ChatMessage => ({
    id: "u", role: "user", createdAt: 0,
    blocks: [{ type: "text", text }],
  });
  const assistantMsg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: "a", role: "assistant", createdAt: 0,
    blocks: [], finalBlocks: [],
    ...over,
  });
  const hShortUser = estimateMessageHeight(userMsg("你好"));
  const hLongUser = estimateMessageHeight(userMsg("字".repeat(500)));
  assert(hLongUser > hShortUser, "用户消息越长估算越高");
  assert(hLongUser <= 800, "用户消息估算封顶 800");
  const hPlain = estimateMessageHeight(
    assistantMsg({ finalBlocks: [{ type: "text", text: "好的" }] }),
  );
  const hLongFinal = estimateMessageHeight(
    assistantMsg({ finalBlocks: [{ type: "text", text: "字".repeat(3000) }] }),
  );
  assert(hLongFinal > hPlain, "最终回复越长估算越高");
  assert(
    estimateMessageHeight(
      assistantMsg({ streaming: true, blocks: [{ type: "thinking", text: "思考" }] }),
    ) > hPlain,
    "流式思考段增加估算高度",
  );
  assert(
    estimateMessageHeight(assistantMsg({ artifactIds: ["a1", "a2"] })) > hPlain,
    "artifact 产物增加估算高度",
  );
  assert(estimateMessageHeight(assistantMsg({})) >= 90, "助手消息估算下限 90");
  assert(
    estimateMessageHeight(assistantMsg({ finalBlocks: [{ type: "text", text: "字".repeat(200000) }] })) <= 6000,
    "超长内容估算封顶 6000",
  );
  // 超长首卡：估算应显著大于固定 160，缩小首测 delta
  const longFirstCard = assistantMsg({
    streaming: true,
    blocks: [{ type: "thinking", text: "字".repeat(4000) }],
    finalBlocks: [{ type: "text", text: "字".repeat(6000) }],
    artifactIds: ["a1", "a2", "a3"],
  });
  const hFirst = estimateMessageHeight(longFirstCard);
  assert(hFirst > 160 * 3, "超长首卡估算显著大于固定 160（缩小首测 delta）");

  // ---- 14. 任务切换重置判定（shouldResetFollow）-----------------------------
  assert(shouldResetFollow({ taskChanged: true, historyRestored: false, messageAdded: false, lastMessageStreaming: false }) === true, "任务切换 → 重置");
  assert(shouldResetFollow({ taskChanged: false, historyRestored: true, messageAdded: false, lastMessageStreaming: false }) === true, "历史恢复 → 重置");
  assert(shouldResetFollow({ taskChanged: false, historyRestored: false, messageAdded: true, lastMessageStreaming: true }) === true, "新一轮发送 → 重置");
  assert(shouldResetFollow({ taskChanged: false, historyRestored: false, messageAdded: true, lastMessageStreaming: false }) === false, "消息追加但非流式 → 不重置");
  assert(shouldResetFollow({ taskChanged: false, historyRestored: false, messageAdded: false, lastMessageStreaming: true }) === false, "流式 patch 不重置");
  assert(shouldResetFollow({ taskChanged: false, historyRestored: false, messageAdded: false, lastMessageStreaming: false }) === false, "无变化不重置");

  // ---- 15. 新一轮置顶门控（shouldPinOnNewTurn；需求 4）----------------------
  assert(shouldPinOnNewTurn(true, true) === true, "跟随态 + 新一轮 → 置顶");
  assert(shouldPinOnNewTurn(false, true) === false, "用户接管滚动 + 新一轮 → 不置顶（不覆盖显式滚动接管）");
  assert(shouldPinOnNewTurn(false, false) === false, "用户接管 + 非新一轮 → 不置顶");
  assert(shouldPinOnNewTurn(true, false) === false, "跟随态 + 非新一轮（delta patch）→ 不置顶");

  console.log(`\n[scroll-follow-test] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
