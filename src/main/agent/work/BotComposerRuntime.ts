import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { McpOAuthCredentialStore, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { ExpertConfigSnapshotDto } from "../../../shared/bot-work";
import { DurableMcp, durableMcpToolName } from "../durable/DurableMcp";
import { McpConfigService } from "../../mcp/McpConfigService";
import { McpCredentialBackend } from "../../mcp/McpCredentialBackend";
import { toNativeMcpConfig } from "../../mcp/NativeMcpConfig";
import { emptyMcpFilterResult } from "../../mcp/McpModeFilter";
import { classifyMcpToolCall } from "../../security/McpSideEffectPolicy";
import { getPluginDirectory } from "../../plugins/PluginStorage";

export interface BotComposerRuntime {
  tools: ToolRegistration[];
  instructions: string;
  close(): Promise<void>;
}
/** The ordinary native MCP transport, one instance per foreground request. */
export async function openBotComposerRuntime(input: {
  profile: ExpertConfigSnapshotDto; cwd: string; models: ModelRuntime;
  connectorSkillRoots: string[]; connectorContext?: string; enabledMcpIds: string[]; readOnly: () => boolean;
}): Promise<BotComposerRuntime> {
  const skillRoots = new Map((input.profile.skillPackages ?? []).map(item => [item.id, realpathSync(item.directory)]));
  for (const directory of input.connectorSkillRoots) {
    if (existsSync(join(directory,"SKILL.md"))) skillRoots.set(`connector:${directory.split(/[\\/]/).at(-2)}`, realpathSync(directory));
    else for (const entry of readdirSync(directory,{withFileTypes:true})) {
      if (entry.isDirectory() && existsSync(join(directory,entry.name,"SKILL.md"))) skillRoots.set(`connector:${entry.name}`,realpathSync(join(directory,entry.name)));
    }
  }
  const tools: ToolRegistration[] = [];
  if (skillRoots.size) tools.push(defineTool({ name:"read_skill", description:"Read a selected skill's SKILL.md or a relative reference file before using it. Available skill ids: " + [...skillRoots.keys()].join(", "),
    parameters:Type.Object({skillId:Type.String(),path:Type.Optional(Type.String())}),replay:"safe",
    execute:async ({skillId,path}) => {
      const root = skillRoots.get(skillId); if (!root) throw Error("技能不属于本条消息："+skillId);
      const file=realpathSync(resolve(root,path||"SKILL.md")), rel=relative(root,file);
      if (rel.startsWith("..") || isAbsolute(rel)) throw Error("技能引用超出已选包目录");
      const content=readFileSync(file,"utf8"); if(content.length>128000) throw Error("技能引用文件过大，请选择较小的具体引用");
      return {output:[{type:"text",text:content}]};
    }}));
  let mcp:DurableMcp|undefined;
  const selected = input.profile.allowedMcpIds;
  if (selected.length) {
    const config = new McpConfigService();
    const raw = config.loadRuntimeConfig();
    const allowed = selected.filter(id=>input.enabledMcpIds.includes(id));
    const missing=selected.filter(id=>!allowed.includes(id));
    if(missing.length) throw Error("本条消息的 MCP 已停用或不适用："+missing.join("、"));
    const loaded=toNativeMcpConfig(emptyMcpFilterResult({...raw,mcpServers:Object.fromEntries(Object.entries(raw.mcpServers??{}).filter(([id])=>allowed.includes(id)))}),config.getAppGlobalConfigPath(),false);
    const credentials=new McpOAuthCredentialStore(new McpCredentialBackend(join(getPluginDirectory("mcp"),"mcp-native-auth.encrypted.json")),join(getPluginDirectory("mcp"),"mcp-native-refresh-locks"));
    mcp=await DurableMcp.open(loaded,credentials,input.models,input.cwd);
    for(const tool of mcp.tools) tools.push({...tool,execute:async(args,api,context)=>{
      if(tool.name==="mcp_call_tool" && input.readOnly()) {
        const call=args as {server:string;tool:string;arguments:Record<string,unknown>};
        const verdict=classifyMcpToolCall(durableMcpToolName(call.server,call.tool),call.arguments,selected);
        if(!verdict || verdict.sideEffect || !verdict.clearlyReadonly)
          throw Error("应用当前为只读模式，此工具不能证明只读；未执行。请使用查询工具，或在后台任务处理写入。");
      }
      return tool.execute(args,api,context);
    }});
  }
  return {tools,instructions:[input.connectorContext, skillRoots.size?`本条消息已挂载技能：${[...skillRoots.keys()].join("、")}。使用前先 read_skill 读取 SKILL.md，可继续读取包内相对引用。技能要求长耗时文件/代码操作时派发 Work，所选技能及 MCP/连接器配置会随原请求传入。`:""].filter(Boolean).join("\n\n"),close:async()=>{await mcp?.close();}};
}
