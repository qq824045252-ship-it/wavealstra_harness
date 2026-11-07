import type { Context } from "@earendil-works/chord/context";
import type { Cursor, HookApi } from "@earendil-works/pi-durable";
import { z } from "zod";

const inputSchema = z.object({ mybuddyInput: z.object({ botRequestId: z.string().min(1) }) });
/** Resolve the original input from immutable native entries, never a mutable UI/current pointer. */
export async function botForegroundRequest(api: Pick<HookApi, "memo"> & Partial<Pick<HookApi, "entries">>, callId: string, context: Context): Promise<string> {
  const memo = await api.memo("mybuddy.bot-input", context);
  if (typeof memo === "string") return memo;
  if (!api.entries) throw new Error("前台工具尚未通过原始输入准入");
  let cursor: Cursor | undefined;
  let foundCall = false;
  do {
    const page = await api.entries({ order: "descending" }, 200, cursor, context);
    for (const entry of page.items) {
      if (!foundCall) {
        foundCall = Boolean(entry.model?.some(message => message.role === "assistant"
          && message.content.some(block => block.type === "toolCall" && block.id === callId)));
        continue;
      }
      if (!entry.model?.some(message => message.role === "user")) continue;
      const input = inputSchema.parse(entry.data);
      return api.memo("mybuddy.bot-input", input.mybuddyInput.botRequestId, context);
    }
    cursor = page.next;
  } while (cursor);
  throw new Error("前台工具缺少可核对的原始输入身份");
}
