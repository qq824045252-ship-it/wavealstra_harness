import assert from "node:assert/strict";
import { ageToolResultImages } from "../src/main/capabilities/ToolImageAging";

const text = (value: string) => ({ type: "text", text: value });
const image = (id: string) => ({ type: "image", data: id, mimeType: "image/jpeg" });
const toolResult = (id: string) => ({ role: "toolResult", content: [text("screenshot"), image(id)] });

const messages = [
  { role: "user", content: [text("look at this"), image("user-owned-image")] },
  toolResult("a"),
  toolResult("b"),
  toolResult("c"),
  toolResult("d"),
];

const aged = ageToolResultImages(messages, 2);
assert.equal(aged.length, messages.length, "aging must not add or drop messages");
assert.ok((aged[0].content as Array<{ type: string }>).some((block) => block.type === "image"), "user attachments must never be aged");
assert.ok(!(aged[1].content as Array<{ type: string }>).some((block) => block.type === "image"), "oldest tool image must be replaced");
assert.ok(!(aged[2].content as Array<{ type: string }>).some((block) => block.type === "image"), "second oldest tool image must be replaced");
assert.ok((aged[3].content as Array<{ type: string }>).some((block) => block.type === "image"), "newest images must be kept");
assert.ok((aged[4].content as Array<{ type: string }>).some((block) => block.type === "image"), "newest images must be kept");
assert.ok((aged[1].content as Array<{ type: string; text?: string }>).some((block) => block.type === "text" && Boolean(block.text?.includes("omitted"))), "replaced image carries a note");
assert.ok((messages[1].content as Array<{ type: string }>).some((block) => block.type === "image"), "aging must not mutate stored history");

const untouched = messages.slice(0, 3);
assert.equal(ageToolResultImages(untouched, 2), untouched, "no-op when the image count fits the budget");

console.log("tool image aging PASS (keeps newest N tool screenshots, preserves user images and stored history)");
