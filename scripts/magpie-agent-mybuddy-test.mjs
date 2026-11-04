/** The magpie agent plugin that adds MyBuddy (integrations/magpie-agent-mybuddy):
 * a connect-only agent whose connect writes MyBuddy's Pi-shaped models.json
 * provider block. Runs the module magpie runs, with no magpie and no app needed. */
import assert from "node:assert/strict";
import { agent, connect } from "../integrations/magpie-agent-mybuddy/mybuddy.agent.js";

const checks = [];
const pass = (label) => { checks.push(label); console.log("PASS " + label); };

// The descriptor magpie's Agents page is built from. No "model" key: MyBuddy
// picks its model in its own window, so magpie's one field is provider.
assert.equal(agent.id, "mybuddy");
assert.equal(agent.name, "MyBuddy");
assert.equal(agent.config, "~/.mybuddy/models.json");
assert.equal(agent.format, "json");
assert.equal(agent.dir, "~/.mybuddy");
assert.deepEqual(agent.ua, ["MyBuddy"]);
assert.deepEqual(agent.library, { skills: "~/.mybuddy/plugins/skills" });
assert.equal(agent.model, undefined);
assert.equal(typeof connect, "function");
pass("descriptor is a connect-only agent on ~/.mybuddy/models.json");

// A gateway catalog as agentplug hands it to connect: id, name, context,
// output, images, efforts, and what /v1/models says of each model.
const gateway = { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "magpie-mybuddy" };
const catalog = [
  {
    id: "auto/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash · routing group",
    context: 1048000,
    output: 328000,
    images: true,
    efforts: ["none", "low", "high", "max"],
    native_endpoints: ["/v1/chat/completions"],
    pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.00000003" },
  },
  {
    id: "vendor/gpt-responses",
    name: "GPT · Responses",
    context: 272000,
    output: 128000,
    images: false,
    efforts: ["low"],
    native_endpoints: ["/v1/responses"],
  },
  {
    id: "vendor/claude-messages",
    name: "Claude · Messages",
    context: 200000,
    output: 64000,
    images: false,
    efforts: ["high"],
    native_endpoints: ["/v1/messages"],
  },
  { id: "bare/model", name: "Bare", context: 0, output: 0, images: false, efforts: [] },
];

const out = connect({ gateway, models: catalog });
assert.deepEqual(Object.keys(out), ["providers.magpie"], "connect writes only the provider block");

const provider = out["providers.magpie"];
assert.equal(provider.baseUrl, "http://127.0.0.1:3425/v1");
assert.equal(provider.api, "openai-completions");
assert.equal(provider.apiKey, "magpie-mybuddy");
assert.deepEqual(provider.headers, { "User-Agent": "MyBuddy" });
assert.deepEqual(provider.compat, { sendSessionAffinityHeaders: true });
assert.equal(provider.models.length, catalog.length);
pass("connect writes magpie's gateway, agent key and the MyBuddy User-Agent");

const [flash, responses, messages, bare] = provider.models;
assert.equal(flash.id, "auto/deepseek-v4.1-flash");
assert.equal(flash.name, "DeepSeek V4.1 Flash · routing group");
assert.equal(flash.reasoning, true);
assert.deepEqual(flash.thinkingLevelMap, {
  off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max",
});
assert.deepEqual(flash.input, ["text", "image"]);
assert.equal(flash.contextWindow, 1048000);
assert.equal(flash.maxTokens, 328000);
assert.deepEqual(flash.cost, { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 });
assert.equal(flash.api, undefined, "a Chat model keeps the provider API");
pass("a Chat model keeps Pi's window, output, images, thinking levels and price");

assert.equal(responses.api, "openai-responses", "a Responses model shares the provider's /v1 base");
assert.equal(responses.contextWindow, 272000);
assert.equal(responses.reasoning, true);
assert.deepEqual(responses.thinkingLevelMap, {
  off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null,
});
pass("a Responses-native model is written on openai-responses");

assert.equal(messages.api, undefined, "a Messages-only model stays on Chat, which the gateway translates");
pass("a Messages-only model stays on Chat");

assert.deepEqual(Object.keys(bare).sort(), ["id", "name"], "unknown window, output or levels add no empty fields");
pass("a model with no catalog facts stays a bare id and name");

// magpie stores this as JSON text: nothing may carry undefined, NaN or Infinity.
const roundTrip = JSON.parse(JSON.stringify(out));
assert.deepEqual(roundTrip, out);
pass("the block survives JSON as magpie writes it");

console.log(`\nALL ${checks.length} CHECKS PASSED`);
