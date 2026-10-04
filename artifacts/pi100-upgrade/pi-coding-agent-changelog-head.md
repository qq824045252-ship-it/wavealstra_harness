# Changelog

## [1.0.0] - 2026-10-01

### New Features

- **Fullscreen by default** — The TUI now runs fullscreen. Set `tuiMode` to `"regular"` to keep the terminal's normal scrollback. See [Terminal and display](docs/settings.md#terminal-and-display).
- **Leaner codemode** — About 40% fewer prompt tokens, and errors that tell the model how to recover. See [Codemode](docs/codemode.md).
- **Image generation in codemode** — Scripts call `models.generateImages()` with the session's credentials. See [Generate images](docs/codemode.md#generate-images) and [Use image models](docs/models.md#use-image-models).
- **Radius in `/login`** — Sign in with Radius and set up its MCP server in one step. See [Radius](docs/providers.md#radius).
- **Anthropic copy code login** — Sign in when the browser runs on another machine. See [Authenticate interactively](docs/providers.md#authenticate-interactively).
- **MCP OAuth hardening** — `oauth.authServerMetadataUrl`, RFC 9207 `iss` checks, credentials per server, and step-up sign-in that keeps granted scopes. See [Authenticate with OAuth](docs/mcp.md#authenticate-with-oauth).
- **Header-only quiet startup** — `quietStartup: "header"` keeps the version and key hints and hides the rest. See [Terminal and display](docs/settings.md#terminal-and-display).

### Added

- Added an `oauth.authServerMetadataUrl` setting for MCP servers that advertise a wrong OAuth authorization server or none. Pi uses the configured metadata document instead of discovery ([#10172](https://github.com/earendil-works/pi/issues/10172)).
- Added `quietStartup: "header"`, which keeps the startup header with version and key hints but hides the model scope line and loaded-resource listing.
- Added `models.generateImages()` to codemode scripts. It runs image models such as OpenRouter's with the session's credentials and returns base64 image blocks that `image()` attaches to the result; usage counts toward the session cost like `models.classify()`. Extensions can call `ctx.modelRegistry.generateImages()`. See [Use image models](docs/models.md#use-image-models).
- Added a copy code login method to Anthropic `/login` for headless setups where the browser runs on another machine ([#10194](https://github.com/earendil-works/pi/pull/10194) by [@lucasmeijer](https://github.com/lucasmeijer)).

### Changed

- Changed the default TUI mode to fullscreen. Set `tuiMode` to `"regular"` or pass `--tui-mode regular` to keep the terminal's normal scrollback.
- `/login` now offers "Sign in with Radius" at the top level, as the last option, with its status. After a Radius sign-in, `/login` offers to configure the Radius MCP server in the global `mcp.json` with `"auth": { "provider": "radius" }` and reloads. Cancelling a login returns to the menu it was started from.
- The provider docs page is renamed to [Providers](docs/providers.md), its "Cloud Providers" section is now "Provider Specific Config", and it documents Radius first.
- MCP OAuth credentials are now stored per server name and URL, so MCP servers with the same URL can sign in with different accounts. Credentials stored by URL alone move to the first server that uses them ([#10252](https://github.com/earendil-works/pi/issues/10252)).
- Codemode costs far fewer prompt tokens: with the default tools and codemode active, a GPT-5.6 request shrinks from about 5,300 to 3,300 tokens. The `codemode` description lists the script globals in one line each and points to the new [Codemode](docs/codemode.md) reference for the `models` API, which the model reads when it needs it. Declared tools say in one line how scripts call them and what the call resolves to, instead of repeating their full declaration, and the system prompt's codemode guidance and MCP server section are shorter.
- Codemode errors now say how to recover: reading a tool or `models` member that does not exist names the close matches (`tools.Bash` suggests `tools.bash`), `models.classify()` and `models.generateImages()` reject malformed arguments with the expected shape, an unknown model points to `models.getAvailableOfType()`, an oversized `store()` value explains what the store is for, and a script that generates images without showing them gets a note. Scripts that probed for a tool with `typeof tools.name` must use `"name" in tools`.
- `/login` and `/logout` now label providers without credentials as "not configured" instead of "unconfigured".
- OAuth browser pages now show the color Pi logo.

### Fixed

- Fixed MCP OAuth sign-in accepting an authorization response whose `iss` parameter names another authorization server; the code is now rejected before it is exchanged (RFC 9207).
- Fixed MCP OAuth sign-in failing with `Invalid scope` when the token response contains `"scope": ""`, and similar failures for other empty or `null` optional OAuth fields ([#10266](https://github.com/earendil-works/pi/issues/10266)).
- Fixed the sign-in URL printed by `/mcp login` not being clickable when it wraps ([#10186](https://github.com/earendil-works/pi/issues/10186)).
- Fixed `--provider` without `--model` being silently ignored and running the default model from another provider; it now fails with an error ([#10236](https://github.com/earendil-works/pi/issues/10236)).
- Fixed MCP servers that ask for more scope (`insufficient_scope`) requesting sign-in over and over. The new sign-in requested only the missing scopes, so the new token lost access the previous one had; it now keeps the granted scopes.
- Fixed user messages in the transcript keeping two full-width copies of every rendered line; they keep one, with identical output.
- Fixed `/login` and `/logout` labeling every OAuth sign-in, including Radius, as a subscription; only subscription-backed providers say "subscription", other OAuth sign-ins say "account".
- Fixed the startup header logo rendering with gaps in Apple Terminal; it now shows a colored "Pi" with the version instead.
- Fixed deferred MCP tools that `tool_search` loaded being dropped on resume and `/reload` even when their server reconnected before the next prompt, because the session restored its tools before the MCP servers reconnected.
- Fixed the system theme making pastel palettes such as Catppuccin Frappe much more vivid; palette colors now keep their chroma ([#10255](https://github.com/earendil-works/pi/issues/10255), [#10293](https://github.com/earendil-works/pi/pull/10293) by [@dgtlntv](https://github.com/dgtlntv)).
- Fixed slash command autocompletion not triggering when the input starts with whitespace ([#10218](https://github.com/earendil-works/pi/pull/10218) by [@haoqixu](https://github.com/haoqixu)).
- Fixed color bleeding past mouse selections and search highlights in fullscreen mode when a styled token ends at the highlight boundary ([#10169](https://github.com/earendil-works/pi/issues/10169)).
- Fixed memory retained per rendered message in the transcript; a long assistant message keeps about a fifth of the heap it kept before.

## [0.99.2] - 2026-09-30

### New Features

- MCP servers stay out of the way: servers with the default `codemode` exposure are no longer listed in the `codemode` description and no longer block the first prompt. They appear in a short system prompt section, and scripts find their tools with `searchTools()` and `describeNamespace()`. See [Control tool exposure](docs/mcp.md#control-tool-exposure).
- More MCP authentication options: `oauth.clientName` for servers that only accept known OAuth clients, and `"auth": { "provider": "<provider>" }` to authenticate HTTP servers with a provider's `/login` token. See [Authenticate with OAuth](docs/mcp.md#authenticate-with-oauth).
- Anthropic workload identity federation from the Anthropic SDK environment variables. See [Use an API key from the environment](docs/providers.md#use-an-api-key-from-the-environment).
- `/reload` enables tools newly added to the `defaultTools` setting. See [Tools](docs/settings.md#tools).

### Added

- Added a `description` field for MCP servers (`pi mcp add --description`), shown with the server in the system prompt and used to rank its tools in tool search, and a `describeNamespace(name)` codemode helper that returns a namespace's instructions and tool names. `describeNamespace()` and `searchTools()` accept a namespace as `mcp__dev-radius`, `mcp__dev_radius`, `dev-radius`, or `dev_radius`.
- Added an `oauth.clientName` setting for MCP servers (`pi mcp add --oauth-client-name`) to change the client name sent during OAuth client registration, for servers that only accept known clients ([#10226](https://github.com/earendil-works/pi/issues/10226)).
- Added `"auth": { "provider": "<provider>" }` for HTTP MCP servers to send a provider's current `/login` token as the bearer token instead of using MCP OAuth. The token is read on every request, so provider refreshes apply. Only allowed in the global `mcp.json` and from extensions, and requires https except on loopback hosts.
- Added Anthropic workload identity federation from the `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, and `ANTHROPIC_IDENTITY_TOKEN_FILE` environment variables (see [Providers](docs/providers.md)) ([#10177](https://github.com/earendil-works/pi/issues/10177), [#10242](https://github.com/earendil-works/pi/pull/10242) by [@philfreo](https://github.com/philfreo)).
- `/reload` now enables tools newly added to the `defaultTools` setting. Tools removed from it stay enabled, tools turned off during the session stay off unless newly added, and `--tools`, `--no-tools`, and `--no-builtin-tools` still override the setting ([#10245](https://github.com/earendil-works/pi/issues/10245)).

### Changed

- MCP servers with the default `codemode` exposure no longer appear in the `codemode` description; scripts find them with `searchTools()`. `codemode-deferred` is now an alias for `codemode`. Use `direct` exposure for tools the model should see without searching ([#10212](https://github.com/earendil-works/pi/issues/10212)).
- The `codemode` description no longer includes deferred tools, tool counts, or MCP server instructions, so it no longer changes when MCP servers connect or change their tools. The `tool_search` description no longer lists the servers whose tools it can load, for the same reason. Servers are listed instead in an `mcp_servers` system prompt section with a one-line summary, updated at the start of each prompt; a changed section is appended to the conversation. Scripts read server instructions with `describeNamespace()` ([#10212](https://github.com/earendil-works/pi/issues/10212)).
- The first prompt no longer waits for MCP servers without `direct` tools. They connect in the background and are waited for when a codemode script names them, a script searches tools, or `tool_search` runs ([#10212](https://github.com/earendil-works/pi/issues/10212)).

### Fixed

- Fixed new sessions intermittently ignoring the saved default model, or warning that no models are available, when it belongs to an extension-registered native provider with a stored credential ([#9962](https://github.com/earendil-works/pi/issues/9962), [#10190](https://github.com/earendil-works/pi/pull/10190) by [@davidbrai](https://github.com/davidbrai)).
- Fixed the `/mcp` sign-in URL not being clickable when it wraps across lines, by emitting it as a terminal hyperlink with a `Cmd/Ctrl+click to open` line like `/login` ([#10186](https://github.com/earendil-works/pi/issues/10186)).
- Fixed codemode `image()` accepting malformed base64 data or unsupported image types, which persisted an invalid image block that made every later provider request fail with HTTP 400 ([#10215](https://github.com/earendil-works/pi/issues/10215)).
- Fixed codemode failing to start its script worker from the standalone Windows executable ([#10204](https://github.com/earendil-works/pi/issues/10204)).
- Fixed prompt submission slowing down with session length, because resolving the session's model selection looked up the model catalog once per assistant message ([#10198](https://github.com/earendil-works/pi/issues/10198)).
- Fixed model lookups slowing down for providers with a refreshed pi.dev catalog, because merging remote catalog models took quadratic time.
- Fixed the `built-in-tool-renderer.ts` and `minimal-mode.ts` extension examples removing the built-in tools' summaries and guidelines from the system prompt ([#10072](https://github.com/earendil-works/pi/issues/10072), [#10193](https://github.com/earendil-works/pi/pull/10193) by [@christianklotz](https://github.com/christianklotz)).
- Fixed context overflow detection for Z.AI CN endpoint `Prompt exceeds max length` errors ([#10208](https://github.com/earendil-works/pi/issues/10208)).
- Fixed Anthropic requests failing when a tool schema uses keywords Anthropic strict tool use rejects, such as `minimum`/`maximum`; such tools are now sent non-strict ([#9953](https://github.com/earendil-works/pi/issues/9953)).
- Fixed provider retries firing immediately when a `Retry-After` header contains an unparseable date; they now use exponential backoff ([#9571](https://github.com/earendil-works/pi/issues/9571)).
- Fixed extension commands registered without a string name or handler crashing pi when typing `/`; the extension now fails to load with an error instead ([#10054](https://github.com/earendil-works/pi/issues/10054)).
- Fixed collapsed `codemode` and MCP tool results filling the screen when the output is one long line, such as minified JSON. Like bash output, the preview is now limited to wrapped lines instead of logical lines.
- Fixed `codemode.mode: "only"` listing `read`, `bash`, `edit`, and `write` in the system prompt's tool list although requests only declare `codemode` ([#10192](https://github.com/earendil-works/pi/issues/10192)).
- Fixed codemode scripts calling the wrong MCP tool when two tool names differ only in `-` and `_`, such as `read-file` and `read_file`. Like in Codex, MCP tool and namespace names now replace `-` with `_` (`mcp__my-server__x` is now `mcp__my_server__x`), colliding tools of a server all get a hash suffix, and server names that differ only in `-` and `_` are rejected ([#10239](https://github.com/earendil-works/pi/issues/10239)).

## [0.99.1] - 2026-09-29

### New Features

- **GPT-6.1 Sol** — Available on OpenAI, Azure OpenAI, and OpenAI Codex, and now the default OpenAI Codex model. See [Select a model](docs/models.md#select-a-model).

### Added

- Added GPT-6.1 Sol (`gpt-6.1-sol`) to the OpenAI, Azure OpenAI Responses, and OpenAI Codex providers.

### Changed

- Changed the default OpenAI Codex model to GPT-6.1 Sol (`gpt-6.1-sol`).

### Fixed

- Fixed `/login` with OpenAI failing in the bundled release with a missing `openai-chatgpt.js` module error.

## [0.99.0] - 2026-09-29

### New Features

- **Codemode and MCP** — Connect MCP servers and let models run JavaScript that calls tools in parallel. See [MCP Servers](docs/mcp.md) and [Enable codemode](docs/cli.md#enable-codemode).
- **System theme** — Pi's colors now come from your terminal's own palette by default. See [Use your terminal's colors](docs/themes.md#use-your-terminals-colors).
- **Sign in with ChatGPT** — Use a ChatGPT subscription with the OpenAI provider through `/login openai`. See [Authenticate interactively](docs/providers.md#authenticate-interactively).
- **Virtual models** — Extensions can route each request to a different physical model. See [Virtual Models](docs/virtual-models.md).
- **Classifier models** — Run Jev classifiers from codemode scripts, or use any llama.cpp model as a classifier. See [How codemode works](docs/cli.md#how-codemode-works) and [Classification](docs/llama-cpp.md#classification).

### Added

- Added codemode, tool search, and MCP support as built-in extensions. The `codemode` tool runs model-written JavaScript in a QuickJS sandbox that calls pi's tools; enable it with `defaultTools` or `--tools` and configure it with `codemode.mode` and `codemode.inlineBudget`. `tool_search` finds tools that are not declared to the model and declares them. MCP servers over stdio or streamable HTTP, with OAuth, come from `mcp.json` (global, or per project once trusted) or `pi.registerMcpServer()` and are managed with `/mcp` and `pi mcp add|remove|list|login|logout`. See [MCP Servers](docs/mcp.md) and [Enable codemode](docs/cli.md#enable-codemode) ([#10040](https://github.com/earendil-works/pi/issues/10040)).
- Added extension tool APIs for orchestrating tools: `exposure` (`direct`, `model-only`, `codemode`, `deferred`, or `hidden`), `namespace`, `annotations`, `outputSchema` with `structuredContent`, `isError` results, `prepareLoadout()`, and `ctx.executeTool()` for nested tool calls, which emit events with `parentToolCallId` and are recorded as bounded `nestedCalls` on the calling tool's result. See [Tool exposure](docs/extensions.md#tool-exposure).
- Added a warning when an extension that registers the same tool, command, or flag replaces a built-in extension ([#10174](https://github.com/earendil-works/pi/pull/10174) by [@cristinaponcela](https://github.com/cristinaponcela)).
- Added experimental virtual models: extensions register them with `pi.registerVirtualModel()` and pick a physical model and thinking level for each request. The footer shows the routed model, `/session` lists cost per physical model, and `examples/extensions/jev-router.ts` routes with the Jev classifier. See [Virtual Models](docs/virtual-models.md).
- Added Sign in with ChatGPT to the OpenAI provider in `/login`, which uses a ChatGPT subscription with the OpenAI API. Pi stores a stable `deviceId` in the global settings for this login and omits it from bug reports.
- Added the `system` theme, now the default, which derives pi's colors from the terminal's reported foreground, background, and ANSI palette and rebuilds them when the terminal switches between light and dark. See [Use your terminal's colors](docs/themes.md#use-your-terminals-colors).
- Added `#rgb`, `oklch()`, and `okhsl()` colors and an optional `appearance` field to theme files, and `theme.style()`, `theme.colors`, and `theme.appearance` for extensions. See [Themes](docs/themes.md) and [TUI](docs/tui.md).
- Added a classifier model for every llama.cpp chat model, answered from next-token label probabilities. See [Classification](docs/llama-cpp.md#classification).
- Added inherited Jev classifier models on OpenRouter, Cloudflare Workers AI, Vercel AI Gateway, and OpenCode Zen.
- Added the `fullscreenWheelScrollLines` setting and `/settings` entry for fullscreen mouse-wheel scrolling. The default `"auto"` accelerates fast wheel spins outside local macOS terminals ([#9758](https://github.com/earendil-works/pi/issues/9758)).
- Added per-input disposition to successful RPC `prompt`, `steer`, and `follow_up` responses, `AgentSession.steer()`/`followUp()`, and `RpcClient.prompt()`/`steer()`/`followUp()`; `RpcClient.prompt()` also accepts `streamingBehavior` ([#9098](https://github.com/earendil-works/pi/issues/9098), [#9803](https://github.com/earendil-works/pi/issues/9803)).
- Added image generation to `ModelRuntime`: `generateImages()` with runtime-resolved auth (stored credentials, OAuth, runtime API keys, `models.json` headers), plus `getModelsOfType()`, `getModelOfType()`, `getAvailableOfType()`, `getAllModels()`, and `getAllAvailable()`. OpenRouter image models are listed under the `openrouter` provider and share its credential; an upstream ID can have separate chat and image entries. `models.json` providers and extension registrations without a model list keep built-in image generation. Extension model lists can include discriminated chat, image, and classifier entries with operation implementations; when supplied, they replace the provider catalog across every operation. Chat-facing reads (`getModels()`, `getAvailableSnapshot()`, the model picker) are unchanged.
- Added classifier support to `ModelRuntime`, including `classify()`, classifier model accessors, runtime-resolved authentication, and the built-in TypeSafe `jev-latest` model.
- Added `types=chat,image,classifier` to pi.dev model catalog requests so remote refreshes overlay every supported model type; entries of unknown model types are ignored.
- Added the `provider_stream_event` extension event for observing parsed provider events before normalization, with an opt-in `/debug-provider` example viewer ([#9784](https://github.com/earendil-works/pi/issues/9784), [#9901](https://github.com/earendil-works/pi/pull/9901) by [@davidbrai](https://github.com/davidbrai)).
- Added a show/hide toggle (`H`) in HTML exports for custom messages marked `display: false`. Messages remain hidden by default and can also be revealed from the sidebar ([#8896](https://github.com/earendil-works/pi/issues/8896), [#10020](https://github.com/earendil-works/pi/pull/10020) by [@rwachtler](https://github.com/rwachtler)).
- Added inherited Claude Sonnet 5.5 support for Anthropic with adaptive thinking and a 1M context window.
- Added a Built-in section in `pi config` to disable the built-in `mcp`, `llama.cpp`, `codemode`, and `tool-search` extensions globally or per project, stored as `-builtin:<name>` in the `extensions` setting. SDK inline extensions opt in with `builtin: true`.
- Added `+name` and `-name` entries to the `defaultTools` setting to add or remove tools without repeating the defaults, for example `"defaultTools": ["+codemode"]`. Project entries of this form apply on top of the user setting. Documented how to enable `codemode` without MCP and how to use classifier models such as Jev from codemode scripts.
- Added the token usage and cost of codemode `models.classify()` calls to the codemode tool result, so they count toward the session cost; the codemode result shows each call's cost.

### Changed

- Switched the build from the TypeScript native preview to TypeScript 7.0 with an ES2024 target, and replaced `tsx` with Node's built-in type stripping for running from source ([#9965](https://github.com/earendil-works/pi/issues/9965)).
- Removed the `[Themes]` section from the startup banner. Custom themes remain available in `/settings`, and theme conflicts are still reported.
- Changed the startup header to show the pi logo with the version instead of the app name.
- Changed the built-in `dark` and `light` themes to the revised pi colors, written in OKHSL.
- Changed light/dark terminal detection to use the reported background color first, then the terminal's light/dark report, then `COLORFGBG`. The first-time setup no longer shows the detected appearance.
- Renamed the inherited OpenAI Codex provider to "OpenAI Codex (legacy)"; Sign in with ChatGPT on the OpenAI provider supersedes it.
- Changed inherited terminal detection to treat `TERM=*-direct` as truecolor.
- Built-in extensions and tools are named `builtin:<name>` (for example `builtin:mcp` and `builtin:read`) in errors, diagnostics, RPC source info, and bug reports, instead of `<inline:name>` and `<builtin:name>`. Their slash commands no longer carry a `[t]` autocomplete tag.
- `--no-extensions` also disables the built-in extensions, including the llama.cpp provider. Load one explicitly with `-e builtin:<name>`, for example `pi -ne -e builtin:mcp`.
- Tool calls without a custom call renderer, including direct MCP tool calls, now show their arguments: as `key=value` pairs on the title line when collapsed and one `key: value` line per argument when expanded. MCP calls are titled `server/tool` and their results collapse to 5 lines.
- `bash` and `powershell` structured results, which codemode scripts receive, now hold up to 1 MiB of output instead of the model-facing 2000 lines or 50KB, and add `truncated` and `full_output_path`. Longer output keeps its first and last 512 KiB. Empty output is `""` instead of `(no output)`.

### Fixed

- Fixed X11 clipboard text being misidentified as an image when the clipboard owner accepts unadvertised image targets ([#9786](https://github.com/earendil-works/pi/issues/9786)).
- Prevented managed git 