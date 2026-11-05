# MyBuddy + Magpie

Add this directory as a local Magpie agent plugin (`magpie plugin add <absolute-path>`).
The plugin connects Magpie's model catalog to `~/.mybuddy/models.json`.
Packaged MyBuddy also ships this plugin at `resources/magpie-agent-mybuddy`; use
that absolute directory when the source checkout is not available.

`agent.library.skills` points to `~/.mybuddy/plugins/skills`, the directory MyBuddy
actually scans. Magpie Library can discover/import its skills and synchronize
selected skills there. MyBuddy applies its usual task skill policy and respects
`disable-model-invocation`; a Library entry does not grant task permissions.

MyBuddy seeds the bundled OfficeCLI skill here on first startup, preserving any
existing user or Magpie copy. Its references and Apache-2.0 license ship with it.
Windows/Linux x64 packages carry OfficeCLI at `resources/officecli`; task shells,
execute_code, and child agents inherit its PATH from MyBuddy. Nothing is installed
globally and Magpie's own process environment is not changed. Skill synchronization
alone does not install OfficeCLI into other agents.

Supported assets are listed in `src/shared/officecli-builds.json`. When no binary
is present, the build downloads the latest upstream release and verifies its published
SHA-256: https://github.com/iOfficeAI/OfficeCLI
Run `pnpm prepare:officecli` for development; packaging prepares the target binary
automatically and checks the executable and skill references. Task processes disable
OfficeCLI's in-place auto-update to avoid replacing a running executable. To upgrade,
run `node scripts/prepare-officecli.cjs --refresh` and rebuild MyBuddy; no version is fixed.
