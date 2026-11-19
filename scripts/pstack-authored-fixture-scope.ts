import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentService } from "../src/main/agent/AgentService";
import type { DurableDomainTools } from "../src/main/agent/durable/DurableDomainTools";

/** A live model must not search the machine for an external installation of
 * pstack during this test. Restrict this test instance at the native leaf,
 * retaining the complete production hook chain for every admitted call. */
export function restrictAuthoredFixture(app: AgentService, taskRoot: string, userProfile: string) {
  type Factory = (...args: unknown[]) => Promise<DurableDomainTools>;
  const factory = Reflect.get(app,"durableTaskTools") as Factory;
  Object.defineProperty(app,"durableTaskTools",{ value:async (...args: unknown[])=>{
    const domain=await factory.apply(app,args), production=domain.toolHooks;
    domain.toolHooks={...production,beforeTool:async(call,api,ctx)=>{
      let allowed=call.name.startsWith("pstack_") || ["skill_authoring_assess","skill_authoring_create","subagent"].includes(call.name);
      if(["bash","powershell"].includes(call.name)) allowed=/^node (?:\.\/)?catalog\.cjs$/.test(String(call.arguments.command).trim());
      if(["ls","read","find","grep"].includes(call.name)){
        const candidate=resolve(taskRoot,String(call.arguments.path ?? "."));
        allowed=[taskRoot,userProfile].some(root=>{
          const rel=relative(root,candidate);
          return rel!==".." && !rel.startsWith(".."+sep) && !isAbsolute(rel);
        });
      }
      return allowed ? production?.beforeTool?.(call,api,ctx)
        : {block:"Only the disposable task and its isolated profile may be read. The only approved shell command for this exercise is node catalog.cjs. Use pstack_workflow status, the authoring tools, and read."};
    }};
    return domain;
  }});
}
