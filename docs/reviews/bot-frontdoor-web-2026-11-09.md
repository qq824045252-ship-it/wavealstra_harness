# Bot foreground web access verification

## Change

Bot foreground now mounts the existing `web_search` and `fetch_content` through the native Durable domain bridge. It shares ordinary mode's providers, extraction and network checks; no alternate network client, DNS bypass, new approval or user-data migration was introduced. Existing Bots receive these two default tools without recreating their stored configuration. Other extension tools are not exposed.

A weather/news lookup is answered in the conversation without a Work or a second confirmation. Longer operations still use Work. Creation and control descriptions are separate. Criticism is not cancellation; explicit stop remains stop. Search snippets, conflicting dates and failed extraction must remain qualified, including after the user asks for a shorter answer.

## Evidence

- Native phase2 regression: injected search/fetch operations execute for an existing Bot, failures reach the reply, unrelated extension tools stay unavailable, and no Task/Work is created. This is fixture evidence, not a live search claim.
- `pnpm -s test:bot-frontdoor:live`: real Electron from `pnpm dev`, isolated HOME, actual online DeepSeek model through the existing local Magpie endpoint. A transparent recording transport forwards every request and never supplies a canned answer.
- UI input `今天杭州天气怎么样`: actual `web_search` and `fetch_content`, answer in Bot conversation, zero Work. Follow-up `这他妈的能用？我就问个天气`: no cancellation or duplicate Work. `不用查了，停止查询`: no new search/fetch/create after that input.
- Final UI answer and shortened follow-up both retained the limitation that sources were search snippets rather than verified fetched pages. Screenshot was visually inspected.
- On this host public page extraction resolves through fake-IP 198.18.x.x and is rejected by the existing address check. That was preserved. Successful search does not mean direct page extraction passed; no real-time weather numbers were independently certified by this test.
- Typecheck passed. First full run after web integration had one `project-materials-dom` wait timeout (document textarea); standalone rerun passed. No baseline suppression was added. After rebasing onto `169c0b0` (including shared fetch-failure and model-picker fixes), typecheck passed and the complete default suite passed **397/397, 0 failures** with `TEST_ALL_JOBS=1`. The prior overlapping run also timed out in gateway-delivery-journal; both timeout cases passed in the final full run.

## Run

`pnpm -s test:bot-frontdoor:live` requires a real desktop and reachable model endpoint. Optional `BOT_FRONTDOOR_BASE_URL` and `BOT_FRONTDOOR_MODEL` select an existing test endpoint/model. Default endpoint is the local Magpie service; no production profile credentials are copied. The test starts/stops only its own isolated Electron process. Artifacts are under `out/diagnostics/bot-frontdoor/live/`.
