// MyBuddy (this repository's desktop app) keeps its providers in Pi's
// models.json format at ~/.mybuddy/models.json (src/main/paths.ts,
// ModelsConfigStore.ts). The app has no command line magpie could run and
// no settings file magpie's own writers know, so this plugin adds it as a
// third-party agent: connect writes magpie's provider block into its
// models.json, and MyBuddy's own model picker lists the models — the app
// reads the gateway catalog through that provider and reloads external
// models.json edits at read/turn boundaries, so nothing has to restart.
//
//	"providers": {
//	  "magpie": {
//	    "name": "magpie", "baseUrl": "http://127.0.0.1:3425/v1",
//	    "api": "openai-completions", "apiKey": "magpie-mybuddy",
//	    "headers": { "User-Agent": "MyBuddy" },
//	    "compat": { "sendSessionAffinityHeaders": true },
//	    "models": [ { "id": "opendesign/deepseek-v4.1-flash", … } ]
//	  }
//	}
//
// MyBuddy's Pi runtime sends the provider's User-Agent with each request,
// so the gateway attributes its turns to mybuddy instead of pi, and
// magpie's agent key (magpie-mybuddy) names them on loopback as well.
// The provider block keeps Pi's own shape: an id per gateway model, the
// API a model goes on untranslated (Responses only, as MyBuddy's own
// gateway refresh decides — see src/main/agent/providers/magpie.ts),
// images, thinking levels, window and output ceiling.
//
// No "model" key: MyBuddy picks its model in its own window, not in a
// config key, so this is a connect-only agent (magpie's one field is
// provider: magpie or nothing).

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Pi thinkingLevelMap: every Pi level, null where the model does not offer it. */
function thinkingLevelMap(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
  const map = {};
  for (const level of PI_LEVELS) {
    const offered = level === "off" ? "none" : level;
    map[level] = efforts.includes(offered) ? offered : null;
  }
  return map;
}

/** The gateway paths a model goes on untranslated, without trailing slashes. */
function nativeEndpoints(model) {
  return Array.isArray(model.native_endpoints)
    ? model.native_endpoints.map((path) => String(path).replace(/\/+$/u, ""))
    : [];
}

/** USD-a-token decimal strings (catalog.OpenRouterPricing) as Pi's USD-a-million. */
function perMillion(perToken) {
  const value = Number(perToken);
  return Number.isFinite(value) ? Number((value * 1e6).toPrecision(12)) : 0;
}

/** One gateway model as a model of models.json's magpie provider. */
function piModel(model) {
  const out = { id: model.id, name: model.name };
  const levels = thinkingLevelMap(model.efforts);
  if (levels) {
    out.reasoning = true;
    out.thinkingLevelMap = levels;
  }
  // Only the Responses API shares the provider-level "/v1" baseUrl. A
  // Messages-only model stays on Chat, which the gateway translates, as
  // MyBuddy's own catalog refresh does.
  if (nativeEndpoints(model).some((path) => path.endsWith("/responses"))) {
    out.api = "openai-responses";
  }
  if (model.images) out.input = ["text", "image"];
  if (model.context > 0) out.contextWindow = model.context;
  if (model.output > 0) out.maxTokens = model.output;
  const pricing = model.pricing;
  if (pricing && pricing.prompt !== undefined && pricing.completion !== undefined) {
    out.cost = {
      input: perMillion(pricing.prompt),
      output: perMillion(pricing.completion),
      cacheRead: perMillion(pricing.input_cache_read ?? 0),
      cacheWrite: perMillion(pricing.input_cache_write ?? 0),
    };
  }
  return out;
}

export const agent = {
  id: "mybuddy",
  name: "MyBuddy",
  config: "~/.mybuddy/models.json",
  format: "json",
  // MyBuddy installs no CLI: its folder is what says it is here.
  dir: "~/.mybuddy",
  ua: ["MyBuddy"],
  notice: "Pick magpie's models in MyBuddy's own model picker; MyBuddy reloads models.json without a restart.",
};

export function connect({ gateway, models }) {
  return {
    "providers.magpie": {
      name: "magpie",
      baseUrl: gateway.v1,
      api: "openai-completions",
      apiKey: gateway.key,
      headers: { "User-Agent": "MyBuddy" },
      compat: { sendSessionAffinityHeaders: true },
      models: models.map(piModel),
    },
  };
}
