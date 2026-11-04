import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isCodeOrTextFile,
  isFileWriteTool,
  extractChangeFromToolCall,
  resolveTaskFileChanges,
} from "../src/renderer/src/lib/taskFileChanges";
import type { Artifact, ChatMessage } from "../src/renderer/src/types";

console.log("[test] 1. isCodeOrTextFile");
assert.equal(isCodeOrTextFile("index.html"), true);
assert.equal(isCodeOrTextFile("src/App.tsx"), true);
assert.equal(isCodeOrTextFile("server.py"), true);
assert.equal(isCodeOrTextFile("Dockerfile"), true);
assert.equal(isCodeOrTextFile(".gitignore"), true);
assert.equal(isCodeOrTextFile("screenshot.png"), false);
assert.equal(isCodeOrTextFile("avatar.jpg"), false);
assert.equal(isCodeOrTextFile("icon.svg"), false);
assert.equal(isCodeOrTextFile("audio.mp3"), false);
assert.equal(isCodeOrTextFile("video.mp4"), false);
assert.equal(isCodeOrTextFile("document.pdf"), false);
assert.equal(isCodeOrTextFile("data.zip"), false);

console.log("[test] 2. isFileWriteTool");
assert.equal(isFileWriteTool("write"), true);
assert.equal(isFileWriteTool("edit"), true);
assert.equal(isFileWriteTool("write_file"), true);
assert.equal(isFileWriteTool("edit_file"), true);
assert.equal(isFileWriteTool("modify_file"), true);
assert.equal(isFileWriteTool("apply_diff"), true);
assert.equal(isFileWriteTool("patch"), true);
assert.equal(isFileWriteTool("str_replace_editor"), true);

// 绝不能作为文件写入的工具
assert.equal(isFileWriteTool("codemode"), false);
assert.equal(isFileWriteTool("bash"), false);
assert.equal(isFileWriteTool("terminal"), false);
assert.equal(isFileWriteTool("read"), false);
assert.equal(isFileWriteTool("read_file"), false);
assert.equal(isFileWriteTool("gadget_read"), false);
assert.equal(isFileWriteTool("gadget_update"), false);
assert.equal(isFileWriteTool("gadget_create"), false);
assert.equal(isFileWriteTool("memory_save"), false);
assert.equal(isFileWriteTool("multi_model_consult"), false);
assert.equal(isFileWriteTool("web_search"), false);

console.log("[test] 3. extractChangeFromToolCall");
// codemode 脚本里出现 index.html
const codemodeCall = extractChangeFromToolCall(
  "codemode",
  "Run JS",
  JSON.stringify({
    code: "const j = await tools.gadget_read(); let s = j.files.find(x => x.path === 'index.html').content;",
  }),
);
assert.equal(codemodeCall, null, "codemode should never be extracted as file change");

// 真实的 write 工具
const writeCall = extractChangeFromToolCall(
  "write",
  "Write src/index.ts",
  JSON.stringify({ path: "src/index.ts", content: "line1\nline2\nline3" }),
);
assert.deepEqual(writeCall, {
  name: "index.ts",
  path: "src/index.ts",
  additions: 3,
  deletions: 0,
});

// 真实的 edit 工具
const editCall = extractChangeFromToolCall(
  "edit",
  "Edit src/index.ts",
  JSON.stringify({ path: "src/index.ts", target: "old", replacement: "new1\nnew2" }),
);
assert.deepEqual(editCall, {
  name: "index.ts",
  path: "src/index.ts",
  additions: 2,
  deletions: 1,
});

// 写入图片等非代码产物应被过滤
const imageWriteCall = extractChangeFromToolCall(
  "write",
  "Write banner.png",
  JSON.stringify({ path: "assets/banner.png", content: "binary" }),
);
assert.equal(imageWriteCall, null, "non-code file should not be extracted");

console.log("[test] 4. resolveTaskFileChanges 组合与过滤");
// 含有 codemode 的工具调用
const fakeMsg: ChatMessage = {
  id: "msg-1",
  role: "assistant",
  createdAt: 1000,
  blocks: [
    {
      type: "tool",
      toolCall: {
        id: "call-1",
        tool: "codemode",
        summary: "codemode",
        detail: JSON.stringify({
          code: "let s = j.files.find(x => x.path === 'index.html').content;",
        }),
        status: "success",
      },
    },
  ],
};
const res1 = resolveTaskFileChanges([], [], [fakeMsg]);
assert.equal(res1.length, 0, "VPS task codemode tool call must yield 0 changes");

// 图片 artifact 必须被过滤
const imgArtifact: Artifact = {
  id: "art-img-1",
  name: "桌面截图.png",
  kind: "image",
  content: "",
};
const resImg = resolveTaskFileChanges([], [imgArtifact], []);
assert.equal(resImg.length, 0, "Image artifact must not be counted as code change");

// 多次写同一个文件合并累加
const msgEdit1: ChatMessage = {
  id: "msg-edit-1",
  role: "assistant",
  createdAt: 1000,
  blocks: [
    {
      type: "tool",
      toolCall: {
        id: "call-edit-1",
        tool: "edit",
        summary: "edit",
        detail: JSON.stringify({ path: "src/app.ts", target: "a\nb", replacement: "c\nd\ne" }),
        status: "success",
      },
    },
    {
      type: "tool",
      toolCall: {
        id: "call-edit-2",
        tool: "edit",
        summary: "edit",
        detail: JSON.stringify({ path: "src/app.ts", target: "x", replacement: "y" }),
        status: "success",
      },
    },
  ],
};
const resMerged = resolveTaskFileChanges([], [], [msgEdit1]);
assert.equal(resMerged.length, 1);
assert.equal(resMerged[0].name, "app.ts");
assert.equal(resMerged[0].additions, 4); // 3 + 1
assert.equal(resMerged[0].deletions, 3); // 2 + 1

console.log("[test] 5. 真实会话回放测试");
const sessionPath =
  "C:\\Users\\servi\\.mybuddy\\sessions\\--C--Users-servi-Documents-vps管理--\\2026-11-04T05-30-05-714Z_01a1a509-3211-7594-9d8e-bab61380be55.jsonl";
if (fs.existsSync(sessionPath)) {
  const lines = fs.readFileSync(sessionPath, "utf8").trim().split("\n");
  const blocks: any[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const content = entry.message?.content || [];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "toolCall") {
            blocks.push({
              type: "tool",
              toolCall: {
                id: part.id,
                tool: part.name,
                summary: part.name,
                detail: JSON.stringify(part.arguments),
                status: "success",
              },
            });
          }
        }
      }
    } catch {}
  }
  const realMessages: ChatMessage[] = [
    {
      id: "real-msg-1",
      role: "assistant",
      createdAt: 1000,
      blocks,
    },
  ];
  const changes = resolveTaskFileChanges([], [], realMessages);
  console.log("Real VPS session detected changes:", changes);
  assert.equal(changes.length, 0, "Real VPS session must yield 0 changes!");
}

console.log("[test] ALL TESTS PASSED!");
