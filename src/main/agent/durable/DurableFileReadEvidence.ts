import type { ToolRegistration } from "@earendil-works/pi-durable";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { BinaryReader } from "@earendil-works/pi-durable/env";
import { createHash } from "node:crypto";
import type { NativeExecutionReceipt } from "../../../shared/native-execution-receipt";

export const NATIVE_FILE_READ_ATTEMPT = "mybuddy.native-file-read-attempt";

/** Digest only bytes Pi actually consumed from the open descriptor. A bounded
 * prefix, partial selection, or growing file cannot prove the whole version. */
function observeReadBytes(reader: BinaryReader) {
  let captured: { buffer: Buffer; through: number; mtimeMs: number } | undefined;
  return {
    reader: new Proxy(reader, { get(target, key) {
      if (key === "info") return async (...input: Parameters<BinaryReader["info"]>) => {
        const info = await reader.info(...input);
        if (!info.ok || info.value.size > 64 * 1024) captured = undefined;
        else if (!captured || captured.buffer.length !== info.value.size || captured.mtimeMs !== info.value.mtimeMs)
          captured = { buffer: Buffer.alloc(info.value.size), through: 0, mtimeMs: info.value.mtimeMs };
        return info;
      };
      if (key === "read") return async (...input: Parameters<BinaryReader["read"]>) => {
        const result = await reader.read(...input);
        const offset = input[0];
        if (result.ok && captured && offset <= captured.through && offset + result.value.length <= captured.buffer.length) {
          captured.buffer.set(result.value, offset);
          captured.through = Math.max(captured.through, offset + result.value.length);
        }
        return result;
      };
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    } }),
    digest: () => captured && captured.through === captured.buffer.length
      ? createHash("sha256").update(captured.buffer).digest("hex") : undefined,
  };
}

/** Record the path Pi actually opened, including its filename fallbacks. */
export function withDurableFileReadEvidence(tool: ToolRegistration): ToolRegistration {
  return { ...tool, execute: async (args, api, context) => {
    const env = api.env;
    if (!env) return tool.execute(args, api, context);
    let attempt: NativeExecutionReceipt["fileReadAttempt"];
    let bytes: ReturnType<typeof observeReadBytes> | undefined;
    const observedEnv = new Proxy(env, { get(target, key) {
      if (key === "openBinaryReader") {
        return async (...input: Parameters<typeof env.openBinaryReader>) => {
          const reader = await env.openBinaryReader(...input);
          attempt = { target: input[0], ...(reader.ok ? {} : { openFailure: reader.error.code }) };
          bytes = reader.ok ? observeReadBytes(reader.value) : undefined;
          return reader.ok && bytes ? { ...reader, value: bytes.reader } : reader;
        };
      }
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    const observedApi = new Proxy(api, { get(target, key) {
      if (key === "env") return observedEnv;
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    try {
      const result = await tool.execute(args, observedApi, context);
      const contentSha256 = !result.isError ? bytes?.digest() : undefined;
      if (attempt && contentSha256) attempt.contentSha256 = contentSha256;
      return attempt ? { ...result, details: { ...result.details as object, [NATIVE_FILE_READ_ATTEMPT]: attempt } } : result;
    } catch (error) {
      if (attempt && !context.abortSignal?.aborted)
        await api.details({ [NATIVE_FILE_READ_ATTEMPT]: attempt }, withoutAbortSignal(context));
      throw error;
    }
  } };
}
