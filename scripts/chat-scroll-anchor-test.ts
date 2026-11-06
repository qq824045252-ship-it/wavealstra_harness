import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const chatView = readFileSync(join(root, "src/renderer/src/components/chat/ChatView.tsx"), "utf8");
const chatInput = readFileSync(join(root, "src/renderer/src/components/chat/ChatInput.tsx"), "utf8");
const css = readFileSync(join(root, "src/renderer/src/styles/global.css"), "utf8");
const remoteApp = readFileSync(join(root, "app/remote/src/App.tsx"), "utf8");
const earlierHistory = readFileSync(join(root, "src/renderer/src/components/chat/useEarlierHistory.ts"), "utf8");

const checks: Array<[string, boolean]> = [
  ["new turn pin is one-shot and deferred one frame", /const resetAndPin = \(\): void => \{[\s\S]{0,260}requestAnimationFrame\(\(\) => \{[\s\S]{0,100}pinUserMessageToTopRef\.current\(\);/.test(chatView) && !/const resetAndPin[\s\S]{0,300}requestAnimationFrame\(\(\) => \{[\s\S]{0,120}requestAnimationFrame/.test(chatView)],
  ["streaming/layout observers have no scroll writer", !chatView.includes("keepAnchorPinned") && !chatView.includes("onVirtualLayout") && !chatView.includes("new ResizeObserver")],
  ["automatic new-turn pin never enters virtualizer scrollToIndex reconcile", (() => { const s=chatView.indexOf("const pinUserMessageToTop = useCallback"); const e=chatView.indexOf("const pinUserMessageToTopRef",s); const b=chatView.slice(s,e); return s>=0 && b.includes("getMessageOffset(id)") && b.includes("applyProgrammaticScrollTop") && !b.includes("scrollToMessageId(id, false)") && !b.includes("virtualizer.scrollToIndex"); })()],
  ["local send restores follow before mount", /onBeforeSend=\{\(\) => \{[\s\S]{0,180}pendingLocalSendRef\.current = true;[\s\S]{0,180}onResetForTask\(followStateRef\.current\)/.test(chatView) && /onBeforeSend\?\.\(\);[\s\S]{0,80}if \(onSend\)/.test(chatInput)],
  ["user takeover gates new-turn pin", /shouldPinOnNewTurn\(followRef\.current, isNewTurn\)/.test(chatView)],
  ["full stream keeps anchor space until assistant_end", /const needsTurnAnchorSpace =\s*tailMessage\?\.role === "user" \|\|\s*\(tailMessage\?\.role === "assistant" && Boolean\(tailMessage\.streaming\)\)/.test(chatView)],
  ["single guarded direct scrollTop writer", (() => { const w=chatView.match(/\.scrollTop\s*=/g) ?? []; return w.length===1 && /el\.scrollTop = target;/.test(chatView); })()],
  ["virtualizer compensation stays under follow state", /shouldAdjustScrollPositionOnItemSizeChange[\s\S]{0,600}shouldAdjustScrollCompensation/.test(chatView)],
  ["wheel-up waits for displacement", /onWheelUpCandidate\(followStateRef\.current\)/.test(chatView) && /onFollowScroll\(followStateRef\.current, bottomDistance\(\), delta\)/.test(chatView)],
  ["pointer and keyboard takeover remain wired", /document\.addEventListener\("pointerup", clearPointerIntent\)/.test(chatView) && /document\.addEventListener\("keydown", markKeyboardIntent\)/.test(chatView)],
  ["programmatic target is clamped", /Math\.min\(top, maxScrollTop\)/.test(chatView) && /target > Math\.max\(0, el\.scrollHeight - el\.clientHeight\)/.test(chatView)],
  ["jump action restores follow", /className="jump-to-bottom"[\s\S]{0,420}onResetForTask\(followStateRef\.current\)/.test(chatView)],
  ["anchor padding has no animated range change", !/\.message-list \{[\s\S]{0,400}transition: padding-bottom/.test(css)],
  ["assistant markdown remains full width", /\.msg-row:not\(\.user\) > \.msg-body,[\s\S]{0,320}\.markstream-react\.markdown-renderer \{\s*width: 100%;\s*max-width: 100%;\s*box-sizing: border-box;\s*\}/.test(css)],
  ["markstream intrinsic sizing is disabled", /\.msg-row:not\(\.user\) \.markstream-react\.markdown-renderer \{[\s\S]{0,180}content-visibility: visible;[\s\S]{0,120}contain-intrinsic-size: auto;/.test(css)],
  // 历史块前插并由唯一滚动入口补偿，界面没有隐藏分页按钮。
  ["history prepends and compensates", chatView.includes("mergeHistoryWindow([visibleWindow.messages], live)") && chatView.includes("useEarlierHistory({") && /applyProgrammaticScrollTop\(prependScrollTop\(anchor\.top, anchor\.height, element\.scrollHeight\)\)/.test(earlierHistory) && !chatView.includes('className="durable-history-earlier"')],
  ["pull-up near top loads serially", /const EARLIER_EDGE_PX = 48/.test(earlierHistory) && earlierHistory.includes("if (element.scrollTop >= EARLIER_EDGE_PX) return;") && earlierHistory.includes("if (loadingRef.current || !taskId || target === undefined || !element) return;") && earlierHistory.includes("row?.durable?.epoch !== page.epoch") && chatView.includes("if (delta < 0) requestEarlier();")],
  ["prepend suppresses pin and virtual compensation", chatView.includes("if (!hasMessages || prepended) return;") && chatView.includes("isPrependOnly(previousDisplayMessagesRef.current, displayMessages)") && chatView.includes("compensationOwned: programmaticTargetRef.current !== null")],
  ["jump-to-bottom clears history window", /className="jump-to-bottom"[\s\S]{0,420}clearWindow\(\)/.test(chatView) && earlierHistory.includes("tokenRef.current += 1;")],
  // 手机端同样是前插：不再有隐藏分页按钮，触摸与 wheel 共用同一“贴顶继续拉”判定。
  ["remote timeline prepends older blocks without pagination buttons", remoteApp.includes("onWheel={handleWheel}") && remoteApp.includes("onTouchMove={handleTouchMove}") && !remoteApp.includes('hidden aria-hidden="true"') && remoteApp.includes("consumePrependAnchor(timelineFirstMessageId(el))") && !remoteApp.includes("setOlderPage(undefined)")],
];

for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, pass]) => !pass);
console.log(`\n===== ChatScrollAnchor: ${checks.length - failed.length}/${checks.length} passed =====`);
if (failed.length > 0) process.exit(1);
