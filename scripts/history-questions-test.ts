import assert from "node:assert/strict";
import { mergeHistoryQuestions } from "../src/renderer/src/lib/historyQuestions";
import { verifyHistoryUi } from "./history-navigation-ui-fixture";

// 历史提问弹窗：完整索引（旧→新）与实时窗口（新→旧）的合并/去重/排序规则。
const windowQuestions = [
  { id: "msg-newest-uncommitted", text: "还没进索引的最新提问" },
  { id: "msg-from-index", text: "窗口里也有索引里的旧提问" },
];
assert.deepEqual(mergeHistoryQuestions(windowQuestions, null), windowQuestions, "索引未返回时退回实时窗口");

const index = [
  { id: "entry-1", text: "问 1" },
  { id: "entry-2", text: "问 2" },
  { id: "msg-from-index", text: "窗口里也有索引里的旧提问" },
];
assert.deepEqual(mergeHistoryQuestions(windowQuestions, index), [
  { id: "msg-newest-uncommitted", text: "还没进索引的最新提问" },
  { id: "msg-from-index", text: "窗口里也有索引里的旧提问" },
  { id: "entry-2", text: "问 2" },
  { id: "entry-1", text: "问 1" },
], "整体最新在上，索引与窗口按 id 去重");

assert.deepEqual(mergeHistoryQuestions([], index), [
  { id: "msg-from-index", text: "窗口里也有索引里的旧提问" },
  { id: "entry-2", text: "问 2" },
  { id: "entry-1", text: "问 1" },
], "窗口为空时展示完整索引（倒序）");
assert.deepEqual(mergeHistoryQuestions(windowQuestions, []), windowQuestions, "索引为空时保持窗口内容");

console.log("PASS history question index merge: window fallback, full-index ordering and id de-duplication");
verifyHistoryUi().catch(error => { console.error(error); process.exitCode = 1; });
