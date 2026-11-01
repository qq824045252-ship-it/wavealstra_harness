/**
 * 原生 / 内置工具权威清单（单一真相源）。
 *
 * 凡涉及「工具身份识别 / native 豁免 / 会话工具选择 / 副作用判定」的模块
 * 都应从这里引用，禁止各自硬编码清单，避免漂移：
 *  - McpSideEffectPolicy.parseMcpToolIdentity：用 PI_BUILTIN_TOOL_NAMES +
 *    NATIVE_CAPABILITY_TOOL_NAMES 判定 native 豁免（否则自研工具会被误判为
 *    未知 MCP provider，触发多余 / 重复审批）。
 *  - PromptAssembly：用 MUTATING_BUILTIN_TOOLS / READONLY_EXTRA_ACTIVE /
 *    NATIVE_CAPABILITY_TOOL_NAMES 生成会话工具选择。
 *  - pi-event-mapper.isSideEffectTool：用 MUTATING_BUILTIN_TOOLS 判定写类工具。
 */

/** pi 内置工具（SDK 自带，非 MCP） */
export const PI_BUILTIN_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
  "codemode",
  "tool_search",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;

/** pi-web-access 注册的工具名（磁盘扩展 + inline 注入共用） */
export const WEB_ACCESS_TOOL_NAMES = [
  "web_search",
  "fetch_content",
  "source_check",
  "get_search_content",
] as const;

/** MyBuddy 自研原生能力工具（builtin-capability-extension 注册，非 MCP） */
export const NATIVE_CAPABILITY_TOOL_NAMES = [
  ...WEB_ACCESS_TOOL_NAMES,
  "describe_image",
  "image_generate",
  "video_generate",
  "speech_to_text",
  "ocr_file",
  "text_to_speech",
  "browser_exec",
  "ui_exec",
  "computer_exec",
  "runtime_probe",
  "execute_code",
  "multi_model_consult",
  "skill_authoring_assess",
  "skill_authoring_create",
] as const;

/** Product-owned ExtensionFactory tools. Exact names only: never use provider-like prefixes here. */
export const MYBUDDY_NATIVE_EXTENSION_TOOL_NAMES = [
  // Conversation runtime
  "request_user_input",
  "conversation_goal_get",
  "conversation_goal_create",
  "conversation_goal_update",
  "conversation_goal_propose_complete",
  // Library / Memory
  "library_list",
  "library_search",
  "library_read",
  "library_attach_to_task",
  "library_detach_from_task",
  "library_create_text",
  "library_update_text",
  "library_save_artifact",
  "library_create_collection",
  "library_move",
  "memory_search",
  "memory_get",
  "memory_create",
  "memory_update",
  "memory_promote",
  "memory_history",
  // Project runtime
  "project_status_get",
  "project_review",
  "project_actions_list",
  "project_context_get",
  "project_context_update",
  "project_context_pin",
  "project_context_unpin",
  "project_event_import_file",
  "project_event_ingest_document",
  "project_event_list",
  "project_event_read",
  "project_event_dismiss",
  "project_event_reopen",
  "project_event_promote_to_memory",
  "project_event_promote_to_todo",
  "project_event_promote_to_library",
  "project_knowledge_search",
  "project_knowledge_read",
  "project_memory_list",
  "project_memory_get",
  "project_memory_create",
  "project_memory_search",
  "project_memory_update",
  "project_plan_list",
  "project_plan_get",
  "project_plan_create",
  "project_plan_update",
  // Other product-owned extensions
  "gadget_create",
  "query_work_graph",
  "search_workspace_resources",
  "subagent",
  "subagent_list",
  "subagent_steer",
] as const;

const MYBUDDY_NATIVE_EXTENSION_TOOL_SET = new Set<string>(MYBUDDY_NATIVE_EXTENSION_TOOL_NAMES);

export function isMyBuddyNativeExtensionToolName(toolName: string): boolean {
  return MYBUDDY_NATIVE_EXTENSION_TOOL_SET.has(toolName);
}

/** Mutating tools used for explicit readonly loadout and observation metadata. */
export const MUTATING_BUILTIN_TOOLS = [
  "write",
  "edit",
  "bash",
  "powershell",
  "execute_code",
  "image_generate",
  "video_generate",
  "text_to_speech",
  "skill_authoring_create",
] as const;

/** readonly 时补上不在 pi 默认 active 集里的只读内置工具 */
export const READONLY_EXTRA_ACTIVE = ["grep", "find", "ls"] as const;
