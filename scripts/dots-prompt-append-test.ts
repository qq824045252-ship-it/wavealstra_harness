import assert from "node:assert/strict";
import { assembleDotsPrompt } from "../src/main/dots/DotsExtension";

const plain = assembleDotsPrompt("readWrite", "", "");
assert.deepEqual(plain.map(segment => segment.title), [
  "身份与办事范围", "查资料与文件", "记忆与偏好", "交办与跟进", "回复与交付", "通用回复规范",
]);
assert.deepEqual(assembleDotsPrompt("readWrite", " \n ", "   \n "), plain, "空白沿用默认，并省略追加段");
const edited = assembleDotsPrompt("readWrite", "", "", { delivery: "  在原对话只交付一个文件。 " });
assert.equal(edited[4].content, "在原对话只交付一个文件。");
assert.equal(edited[4].source, "user");
assert.deepEqual(edited.slice(0, 4), plain.slice(0, 4));
assert.deepEqual(edited.slice(5), plain.slice(5));
assert.deepEqual(assembleDotsPrompt("readWrite", "", "", { delivery: " \n " }), plain);

const prompt = assembleDotsPrompt("readOnly", "  你是仓库值班助理。\n", "  先给结论。\n数字注明来源。\n");
assert.deepEqual(prompt.map(segment => segment.source), ["user", "runtime", "seed", "user"]);
assert.equal(prompt[0].content, "你是仓库值班助理。");
assert.match(prompt[1].content, /只读/);
assert.match(prompt[3].content, /\n先给结论。\n数字注明来源。$/);
assert.equal(prompt[3].chars, prompt[3].content.length);
assert.match(assembleDotsPrompt("off", "", "").find(segment => segment.id === "dotsMemoryMode")?.content ?? "", /已关闭/);

console.log("dots prompt append ok");
