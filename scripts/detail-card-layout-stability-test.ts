/**
 * DetailCard HTML preview layout stability regression gate.
 *
 * Guards the task-switch jitter fix: HTML previews must not repeatedly mutate
 * their outer iframe height after mount. SVG keeps intrinsic auto sizing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const results: Array<[string, boolean]> = [];

function read(rel: string): string {
  const path = join(ROOT, rel);
  if (!existsSync(path)) throw new Error(`missing source: ${rel}`);
  return readFileSync(path, "utf8");
}

function check(name: string, pass: boolean): void {
  results.push([name, pass]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
}

const detailCard = read("src/renderer/src/components/chat/DetailCard.tsx");
const chatView = read("src/renderer/src/components/chat/ChatView.tsx");
const css = read("src/renderer/src/styles/global.css");

check(
  "HTML preview uses a stable 480px height constant",
  /const HTML_PREVIEW_HEIGHT = 480;/.test(detailCard),
);
check(
  "HTML iframe height and minHeight both use the stable constant",
  /height:\s*kind === "html" \? HTML_PREVIEW_HEIGHT/.test(detailCard) &&
    /minHeight:[\s\S]{0,120}kind === "html" \? HTML_PREVIEW_HEIGHT/.test(detailCard),
);
check(
  "live iframe is never stretched to 10000px for measurement",
  !/frame\.style\.height\s*=\s*["']10000px["']/.test(detailCard),
);
check(
  "old delayed HTML resize timers are absent",
  !/setTimeout\(resizeFrame\s*,\s*(50|200|600)\)/.test(detailCard),
);
check(
  "HTML iframe does not attach the resize onLoad handler",
  /onLoad=\{kind === "svg" \? onFrameLoad : undefined\}/.test(detailCard),
);
check(
  "layout and observer auto-sizing are restricted to SVG",
  (detailCard.match(/if \(kind !== "svg" \|\| viewMode !== "preview"\) return;/g)?.length ?? 0) >= 3 &&
    /if \(kind !== "svg"\) return;/.test(detailCard),
);
check(
  "SVG intrinsic sizing remains available",
  /function parseSvgIntrinsicSize/.test(detailCard) &&
    /function heightFromIntrinsic/.test(detailCard) &&
    /measureFrameContentHeight/.test(detailCard),
);
check(
  "experimental readyChanged second-pin logic is not present",
  !/readyChanged|previousInitialViewReadyRef/.test(chatView),
);
check(
  "reproduction remains below the virtualization boundary (threshold 16, strict greater-than)",
  /const MESSAGE_VIRTUALIZE_THRESHOLD = 16;/.test(chatView) &&
    /messages\.length > MESSAGE_VIRTUALIZE_THRESHOLD/.test(chatView),
);

const messageScroll = /\.message-scroll\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
check(
  "chat scroll container keeps native anchoring disabled",
  /overflow-anchor:\s*none;/.test(messageScroll),
);
check(
  "chat scroll container keeps non-smooth default scrolling",
  /scroll-behavior:\s*auto;/.test(messageScroll),
);

const failed = results.filter(([, pass]) => !pass);
console.log(`\n===== DetailCardLayoutStability: ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map(([name]) => name).join(", ")}`);
  process.exit(1);
}
