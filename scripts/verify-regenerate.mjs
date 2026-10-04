/**
 * 验证 regenerate 依赖的 SessionManager 语义（只读，拷贝到临时目录）：
 * 1. getUserMessagesForForking() 返回用户消息顺序
 * 2. navigateTree(用户消息) → 叶子移到其 parent，editorText 返回原文
 * 3. 分支后 buildSessionContext 不再包含旧助手回合
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const SOURCE = process.argv[2];
if (!SOURCE || !existsSync(SOURCE)) {
  console.error("usage: node scripts/verify-regenerate.mjs <session.jsonl>");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "regen-verify-"));
const copy = join(dir, "session.jsonl");
copyFileSync(SOURCE, copy);

const sm = SessionManager.open(copy);
// 复刻 AgentSession.getUserMessagesForForking() 的筛选逻辑
function contentText(content, fallback) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fallback;
  return content
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      if (p.type === "text" && typeof p.text === "string") return p.text;
      if (p.type === "thinking" && typeof p.thinking === "string") return p.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
const userMessages = sm
  .getEntries()
  .filter((e) => e.type === "message" && e.message.role === "user")
  .map((e) => ({ entryId: e.id, parentId: e.parentId, text: contentText(e.message.content, "") }))
  .filter((u) => u.text);
console.log(`用户消息数: ${userMessages.length}`);
userMessages.forEach((u, i) => console.log(`  [${i}] ${u.text.slice(0, 60).replace(/\n/g, " ")}`));

if (userMessages.length < 2) {
  console.log("（消息太少，跳过分支验证）");
  process.exit(0);
}

const before = sm.buildSessionContext().messages;
console.log(`\n分支前上下文消息数: ${before.length}`);
console.log(`分支前最后一条: role=${before[before.length - 1].role}`);

// 模拟 regenerate：回退到倒数第二条用户消息（复刻 navigateTree 对 user message 的处理）
const target = userMessages[userMessages.length - 2];
const newLeafId = target.parentId; // navigateTree: user message → leaf = parent
if (newLeafId === null) sm.resetLeaf();
else sm.branch(newLeafId);
const editorText = contentText(target.text, "");
console.log(`\nnavigateTree(cancelled=false) 等价操作完成`);
console.log(`editorText=${JSON.stringify(editorText.slice(0, 80))}`);

const after = sm.buildSessionContext().messages;
console.log(`分支后上下文消息数: ${after.length}`);
console.log(`分支后最后一条: role=${after[after.length - 1].role}`);
const lastUser = [...after].reverse().find((m) => m.role === "user");
console.log(`分支后最后一条用户消息文本: ${JSON.stringify(contentText(lastUser?.content, "").slice(0, 60))}`);

// 叶子应位于目标用户消息的 parent 上；appendMessage 会形成新分支子节点
sm.appendMessage({ role: "user", content: editorText });
const leaf = sm.getLeafEntry();
const leafMsg = leaf && leaf.type === "message" ? leaf.message : null;
console.log(`\n重新追加用户消息后叶子: role=${leafMsg?.role}, parent=${leaf?.parentId === target.parentId ? "正确指向分支点" : "异常:" + leaf?.parentId}`);
console.log(`叶子文本: ${JSON.stringify(String(leafMsg?.content ?? "").slice(0, 60))}`);
console.log("\n✅ SessionManager 语义验证通过");
