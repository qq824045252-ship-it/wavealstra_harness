# pstack statechart runtime

Unmodified runtime files from [cursor/plugins pstack 0.15.48](https://github.com/cursor/plugins/tree/9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc/pstack/skills/statechart). `UPSTREAM.json` records the commit and SHA-256 of every copied runtime file. The MIT license is preserved in `LICENSE`.

MyBuddy invokes `scripts/statechart.ts` through its existing native shell tool, retaining shell permissions and execution receipts. There is no additional agent or workflow runtime. Node 22.18+ (23.x requires 23.6+) executes the TypeScript directly. The runtime needs Java and TLC; upstream pins TLC 1.7.4 and its checksum, supports `TLA2TOOLS`/`JAVA`, and otherwise uses mise to install its pinned tools. A missing tool or blocked installation remains an explicit dependency failure.

Only runtime source is vendored. Upstream tests and their development-only fast-check dependency are not installed. `scripts/pstack-statechart-test.ts` exercises the pinned compiler with real TLC when TLA2TOOLS is provided and validates all vendored hashes on every run.
