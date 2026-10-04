/** Refresh the bundled Command Code catalog from its own public sources. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

// Exact model identities only. Never carry a different provider's URL, API,
// prices, context limit or transport compatibility into Command Code.
const nativeProviders = {
  deepseek: "deepseek", google: "google", meta: "meta", minimaxai: "minimax",
  moonshotai: "moonshotai", nvidia: "nvidia", qwen: "alibaba",
  xai: "xai", xiaomi: "xiaomi", "z-ai": "zai", "zai-org": "zai",
};
function nativeModel(id) {
  const [vendor, ...parts] = id.toLowerCase().split("/");
  const localId = parts.length ? parts.join("/") : vendor;
  const provider = parts.length ? nativeProviders[vendor]
    : id.startsWith("claude-") ? "anthropic" : id.startsWith("gpt-") ? "openai" : undefined;
  for (const candidate of [provider, "opencode", "opencode-go"].filter(Boolean)) {
    const matches = getBuiltinModels(candidate).filter((model) =>
      model.id.toLowerCase() === id.toLowerCase() || model.id.toLowerCase() === localId);
    if (matches.length === 1) return matches[0];
  }
}

// Xiaomi's API reference explicitly covers these IDs, including the new V2.6
// models that are not yet in the installed Pi catalog. Command Code's website
// incorrectly labels them reasoning=false; its /models API declares no such fact.
const mimoIds = new Set([
  "xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro", "xiaomi/mimo-v2.6-flash",
  "xiaomi/mimo-v2.6-pro", "xiaomi/mimo-v2.6-pro-ultraspeed",
]);
const mimoSource = "https://mimo.mi.com/docs/en-US/api/chat/responses";

const listUrl = "https://api.commandcode.ai/provider/v1/models";
const metadataUrl = "https://commandcode.ai/models/deepseek-v4-1-flash";
const signal = AbortSignal.timeout(20_000);
const [listResponse, pageResponse] = await Promise.all([
  fetch(listUrl, { signal }), fetch(metadataUrl, { signal }),
]);
if (!listResponse.ok || !pageResponse.ok) throw new Error("Command Code catalog request failed");
const list = await listResponse.json();
const html = await pageResponse.text();

// React Router serializes loader data as an indexed JSON graph. Parse data only;
// never evaluate website scripts. The model page includes the full official list.
const encoded = html.match(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/)?.[1];
if (!encoded) throw new Error("Command Code model metadata format changed");
const graph = JSON.parse(JSON.parse(encoded));
const memo = new Map();
function read(index) {
  if (index < 0) return undefined;
  if (memo.has(index)) return memo.get(index);
  const value = graph[index];
  if (value === null || typeof value !== "object") return value;
  const result = Array.isArray(value) ? [] : Object.create(null);
  memo.set(index, result);
  if (Array.isArray(value)) for (const item of value) result.push(read(item));
  else for (const [key, item] of Object.entries(value)) {
    result[key.startsWith("_") ? read(Number(key.slice(1))) : key] = read(item);
  }
  return result;
}
const data = read(0)?.loaderData?.["routes/models/[slug]"]?.all;
if (!Array.isArray(data) || !Array.isArray(list.data)) throw new Error("Invalid Command Code catalog");
const metadata = new Map(data.map((model) => [model.id, model]));
const models = list.data.filter((model) => model.supported_endpoints?.some(
  (endpoint) => ["/messages", "/responses", "/chat/completions"].includes(endpoint),
)).map((model) => {
  const names = data.filter((entry) => entry.name.toLowerCase() === model.name.toLowerCase());
  const facts = metadata.get(model.id) ?? (names.length === 1 ? names[0] : undefined);
  const native = nativeModel(model.id);
  const nativeSource = native ? `Pi: ${native.provider}/${native.id}` : undefined;
  const isMiMo = mimoIds.has(model.id);
  const maxTokens = isMiMo ? 131_072 : native?.maxTokens;
  // A missing/false website badge is not a negative capability declaration.
  const reasoning = isMiMo || native?.reasoning || facts?.reasoning || undefined;
  const reasoningEfforts = isMiMo ? ["none", "high"] : facts?.reasoningEfforts ?? [];
  const reasoningControl = isMiMo ? "toggle" : reasoningEfforts.length ? "effort"
    : model.supported_endpoints.includes("/messages") && native?.reasoning ? "budget"
      : reasoning ? "provider-default" : "unknown";
  const parameterSources = {
    maxTokens: isMiMo ? mimoSource : nativeSource,
    reasoning: isMiMo ? mimoSource : native?.reasoning ? nativeSource : facts?.reasoning ? metadataUrl : undefined,
  };
  if (!(model.context_length > 0)) throw new Error(`Missing official context limit for ${model.id}`);
  return {
    id: model.id, name: model.name, context_length: model.context_length,
    supported_endpoints: model.supported_endpoints,
    maxTokens,
    reasoning,
    reasoningControl,
    parameterSources,
    input: typeof facts?.vision === "boolean" ? facts.vision ? ["text", "image"] : ["text"] : undefined,
    reasoningEfforts,
    // Anthropic's native budget/adaptive distinction is part of its wire format.
    ...(model.supported_endpoints.includes("/messages") && native ? {
      ...(reasoningControl === "budget" ? { thinkingLevelMap: native.thinkingLevelMap ?? {} } : {}),
      compat: { forceAdaptiveThinking: native.compat?.forceAdaptiveThinking },
    } : {}),
    cost: {
      input: facts?.inputCost ?? 0, output: facts?.outputCost ?? 0,
      cacheRead: facts?.cacheReadCost ?? 0, cacheWrite: facts?.cacheWriteCost ?? 0,
    },
  };
}).sort((a, b) => a.id.localeCompare(b.id, "en"));
if (!models.length) throw new Error("Empty Command Code catalog");
const path = fileURLToPath(new URL("../src/main/agent/providers/command-code.models.json", import.meta.url));
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify({ listUrl, metadataUrl, fetchedAt: new Date().toISOString(), models }, null, 2)}\n`);
console.log(`Command Code official catalog: ${models.length} models`);
console.log(`Models without published capability metadata: ${models.filter((model) => model.reasoning === undefined).map((model) => model.id).join(", ") || "none"}`);
