import { strict as assert } from "node:assert";
import { chatPinPosition, latestHumanMessageId } from "../src/renderer/src/lib/chatPinPosition.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const chatView = readFileSync(join(root, "src/renderer/src/components/chat/ChatView.tsx"), "utf8");
const chatInput = readFileSync(join(root, "src/renderer/src/components/chat/ChatInput.tsx"), "utf8");
const css = readFileSync(join(root, "src/renderer/src/styles/global.css"), "utf8");
const remoteApp = readFileSync(join(root, "app/remote/src/App.tsx"), "utf8");

const checks: Array<[string, boolean]> = [
  ["active desktop conversation uses the full-history hook and ordinary DOM rows", chatView.includes("useFullTaskHistory(task)") &&
    chatView.includes('className="message-list"') && chatView.includes("messages.flatMap((msg)") &&
    !/useVirtualizer|requestEarlier|loadAround|loadNewer/.test(chatView)],
  ["history opening and local sends keep their explicit pin", chatView.includes("if (firstOpen || localQuestionArrived) pinUserMessageToTop()") &&
    chatView.includes("previousUserId: latestUserMessageId") &&
    chatInput.includes("onBeforeSend?.()") && !/isAssistantTurnStart|needsTurnAnchorSpace/.test(chatView)],
  ["history picker jumps within the loaded DOM, with no history replacement", chatView.includes("messages={displayMessages}") &&
    chatView.includes("onJumpToMessage={jumpToHistoryQuestion}") && !/clearWindow|useHistoryQuestions/.test(chatView)],
  // 静态兄弟不能一起带 key：两个都用 task.id 时 React 会复用同一 fiber，
  // 把整条消息列表渲染成 N 份（长会话里越刷越多）。
  ["static scroll siblings carry no keys that could collide", (() => {
    const listStart = chatView.indexOf("<MessageList");
    const listTag = listStart < 0 ? "" : chatView.slice(listStart, chatView.indexOf("/>" , listStart));
    const spacerTag = chatView.match(/<div[^>]*chat-pin-tail-space[^>]*>/)?.[0] ?? "";
    return listTag.includes("taskId={task.id}") && !/\bkey=/.test(listTag) &&
      !/\bkey=/.test(spacerTag) && /ref=\{tailSpaceRef\}/.test(spacerTag);
  })()],
  ["single guarded direct scrollTop writer", (() => { const w=chatView.match(/\.scrollTop\s*=/g) ?? []; return w.length===1 && /el\.scrollTop = target;/.test(chatView); })()],
  ["wheel-up waits for displacement", /onWheelUpCandidate\(followStateRef\.current\)/.test(chatView) && /onFollowScroll\(followStateRef\.current, bottomDistance\(\), delta\)/.test(chatView)],
  ["pointer and keyboard takeover remain wired", /document\.addEventListener\("pointerup", clearPointerIntent\)/.test(chatView) && /document\.addEventListener\("keydown", markKeyboardIntent\)/.test(chatView)],
  ["programmatic target is clamped", /Math\.min\(top, maxScrollTop\)/.test(chatView) && /target > Math\.max\(0, el\.scrollHeight - el\.clientHeight\)/.test(chatView)],
  ["manual pin restores follow", /spacer\.style\.height[^;]+;\s*commitFollow\(onResetForTask\(followStateRef\.current\)\)/.test(chatView)],
  ["anchor padding has no animated range change", !/\.message-list \{[\s\S]{0,400}transition: padding-bottom/.test(css)],
  ["assistant markdown remains full width", /\.msg-row:not\(\.user\) > \.msg-body,[\s\S]{0,320}\.markstream-react\.markdown-renderer \{\s*width: 100%;\s*max-width: 100%;\s*box-sizing: border-box;\s*\}/.test(css)],
  ["markstream intrinsic sizing is disabled", /\.msg-row:not\(\.user\) \.markstream-react\.markdown-renderer \{[\s\S]{0,180}content-visibility: visible;[\s\S]{0,120}contain-intrinsic-size: auto;/.test(css)],
  ["remote timeline prepends older blocks without pagination buttons", remoteApp.includes("onWheel={handleWheel}") && remoteApp.includes("onTouchMove={handleTouchMove}") && !remoteApp.includes('hidden aria-hidden="true"') && remoteApp.includes("consumePrependAnchor(timelineFirstMessageId(el))") && !remoteApp.includes("setOlderPage(undefined)")],
];

for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
const failed = checks.filter(([, pass]) => !pass);
console.log(`\n===== ChatScrollAnchor: ${checks.length - failed.length}/${checks.length} passed =====`);
if (failed.length > 0) process.exit(1);

assert.equal(latestHumanMessageId([
  { id: "human", role: "user" }, { id: "goal", role: "user", goalContinuation: true },
  { id: "reply", role: "assistant" },
]), "human");
const short = chatPinPosition({ scrollTop: 100, anchorOffset: 200, topInset: 8, naturalHeight: 380, viewportHeight: 500 });
assert.deepEqual(short, { top: 292, tailSpace: 412 }, "a completed short reply still permits an 8px inset");
assert.equal(380 + short.tailSpace - 500, short.top, "browser can reach the requested anchor");
assert.deepEqual(chatPinPosition({ scrollTop: 100, anchorOffset: 200, topInset: 8, naturalHeight: 900, viewportHeight: 500 }),
  { top: 292, tailSpace: 0 }, "long replies need no extra space");
console.log("PASS human anchor and reachable layout for short and long responses");
