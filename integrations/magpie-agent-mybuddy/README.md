# MyBuddy + Magpie

Add this directory as a local Magpie agent plugin (`magpie plugin add <absolute-path>`).
The plugin connects Magpie's model catalog to `~/.mybuddy/models.json`.
Packaged MyBuddy also ships this plugin at `resources/magpie-agent-mybuddy`; use
that absolute directory when the source checkout is not available.

`agent.library.skills` points to `~/.mybuddy/plugins/skills`, the directory MyBuddy
actually scans. Magpie Library can discover/import its skills and synchronize
selected skills there. MyBuddy applies its usual task skill policy and respects
`disable-model-invocation`; a Library entry does not grant task permissions.

MyBuddy uses its built-in Office Use tools to create, inspect and edit Word,
Excel and PowerPoint files in a task.
