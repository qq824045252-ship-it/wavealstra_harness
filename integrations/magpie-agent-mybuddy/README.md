# MyBuddy + Magpie

Add this directory as a local Magpie agent plugin (`magpie plugin add <absolute-path>`).
The plugin connects Magpie's model catalog to `~/.mybuddy/models.json`.
Packaged MyBuddy also ships this plugin at `resources/magpie-agent-mybuddy`; use
that absolute directory when the source checkout is not available.

`agent.library.skills` points to `~/.mybuddy/plugins/skills`, the directory MyBuddy
actually scans. Magpie Library can discover/import its skills and synchronize
selected skills there. MyBuddy applies its usual task skill policy and respects
`disable-model-invocation`; a Library entry does not grant task permissions.

MyBuddy uses Office Use for interactive Word, Excel, and PowerPoint editing. For
batch jobs, install OfficeCLI separately and add its directory to your PATH or
set `MYBUDDY_OFFICECLI` to the executable's absolute path before starting
MyBuddy. Install or synchronize the OfficeCLI skill separately if you want an
agent to use it. Existing installed skills remain available under the usual
task skill policy. [OfficeCLI releases](https://github.com/iOfficeAI/OfficeCLI).
