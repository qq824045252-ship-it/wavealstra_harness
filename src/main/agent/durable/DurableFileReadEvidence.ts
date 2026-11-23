import type { ToolRegistration } from "@earendil-works/pi-durable";

export const NATIVE_OPENED_READ_PATH = "mybuddy.native-opened-read-path";

/** Record the path Pi actually opened, including its filename fallbacks. */
export function withDurableFileReadEvidence(tool: ToolRegistration): ToolRegistration {
  return { ...tool, execute: async (args, api, context) => {
    const env = api.env;
    if (!env) return tool.execute(args, api, context);
    let opened: string | undefined;
    const observedEnv = new Proxy(env, { get(target, key) {
      if (key === "openBinaryReader") {
        return async (...input: Parameters<typeof env.openBinaryReader>) => {
          const reader = await env.openBinaryReader(...input);
          if (reader.ok) opened = input[0];
          return reader;
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
    const result = await tool.execute(args, observedApi, context);
    if (!opened) return result;
    return { ...result, details: { ...result.details as object, [NATIVE_OPENED_READ_PATH]: opened } };
  } };
}
