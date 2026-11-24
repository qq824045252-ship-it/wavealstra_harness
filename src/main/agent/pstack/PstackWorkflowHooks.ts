import type { GenerationHooks, HookApi, ToolHooks } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { live, runSettings, state, transcript, WorkflowFiles, type WorkflowOptions } from "./PstackState";
import { measureWorkspace, reviewScope, verificationCheckout } from "./PstackWorkspace";
import { reviewMatchesVerification } from "./PstackVerificationEvidence";
import { MERGE_REVIEW_BLOCK } from "./PstackReviewIntent";
import { authoredFiles, captureAuthoredSkill } from "./PstackAuthoredSkills";
import { formatPstackBlock } from "./PstackBlockReport";

const mutatingTools = new Set(["write", "edit", "bash", "powershell", "subagent", "terminal_exec", "execute_code", "apply_patch", "skill_authoring_create"]);
export const textMessage = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.filter(item => item.type === "text").map(item => item.text).join("\n");

export function createPstackWorkflowHooks(options: WorkflowOptions) {
  async function currentWorkflow(api: HookApi, ctx: Context) {
    if (!options.active()) return;
    const active = await live(api, ctx);
    if (!active?.first || !active.inputs.length) return;
    const run = await state(api, ctx);
    if (run?.task === options.taskId && active.inputs.some(id => run.inputs.includes(id))) return { first: active.first, inputs: active.inputs, run };
  }

  const beforeTool: ToolHooks["beforeTool"] = async (call, api, ctx) => {
    if (!mutatingTools.has(call.name)) return;
    const current = await currentWorkflow(api, ctx);
    if (!current) return;
    const { run } = current;
    if (run.playbook === "investigation" && ["write", "edit", "apply_patch", "skill_authoring_create"].includes(call.name))
      return { block: "This investigation is read-only. Cite the files in the chat reply; do not create a report or change the workspace." };
    const command = String(call.arguments.command ?? "");
    const merge = /\b(?:git(?:\.exe)?(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s;&|]+))*\s+merge|gh(?:\.exe)?\s+pr\s+merge)(?:\s|$)/i.test(command);
    if (["bash", "powershell", "terminal_exec"].includes(call.name) && merge && !/\bmerge\s+--(?:abort|quit|help)\b/i.test(command)) {
      const settings = runSettings(run);
      if (settings.thermos.beforeMerge && settings.skills["thermo-nuclear-code-quality-review"]?.enabled) {
        const base = (await api.snapshot(WorkflowFiles, api.conversationId, ctx))?.base;
        if (!base || !run.review?.passed) return { block: MERGE_REVIEW_BLOCK };
        try {
          const owned=await authoredFiles(api,ctx,run);
          const scope = reviewScope(base, run.reviewCommit);
          const reviewDelta = await measureWorkspace(scope, settings.thermos.fileLines, ctx.abortSignal, owned);
          const workspace = scope === base ? reviewDelta : await measureWorkspace(base, settings.thermos.fileLines, ctx.abortSignal, owned);
          const history = await transcript(api, ctx, run.first);
          if (reviewDelta.fingerprint !== run.review.fingerprint ||
            !reviewMatchesVerification(run, workspace, history, await verificationCheckout(base, ctx.abortSignal)))
            return { block: MERGE_REVIEW_BLOCK };
        } catch(error) { ctx.abortSignal?.throwIfAborted(); return {block:MERGE_REVIEW_BLOCK+" "+(error as Error).message}; }
        if (run.phase === "complete") return;
      }
    }
    if (run.phase === "running") return;
    return { block: "本轮已启动 pstack 流程。当前流程已暂停或完成，请查看状态后再继续操作。" };
  };

  async function gate(api: HookApi, ctx: Context, { first, inputs, run }: NonNullable<Awaited<ReturnType<typeof currentWorkflow>>>) {
    if (run.phase === "complete") return { complete: true, thermosOutcome: run.thermosOutcome, attention: run.attention,
      answerDraft: run.playbook === "investigation" && run.review?.passed ? run.review.answerDraft : undefined } as const;
    if (run.phase === "blocked") return { blocked: run.block } as const;
    const history = await transcript(api, ctx, first);
    const messages = history.filter(e => e.kind === "pi.user" || e.kind === "mybuddy.user").flatMap(e =>
      (e.model ?? []).flatMap(m => m.role === "user" ? [textMessage(m.content)] : []));
    const identity = "[MyBuddy pstack " + inputs.join(",") + "]";
    const nudges = messages.filter(text => text.startsWith(identity)).length;
    if (nudges >= 2) return { unfinished: "pstack 工作流尚未通过完成检查。当前剧本为 " + run.playbook + "。请查看当前阶段，补齐证据，或记录具体阻碍。" } as const;
    return { continue: identity + " The native workflow has not completed. Call pstack_workflow status, then finish the required phase or call block with the specific dependency." } as const;
  }
  const afterResponse: GenerationHooks["afterResponse"] = async (answer, api, ctx) => {
    if (!options.active() || !["stop", "length", "toolUse"].includes(answer.stopReason) || answer.content.some(c => c.type === "toolCall")) return;
    const current = await currentWorkflow(api, ctx);
    if (!current) return;
    // Pi classifies this terminal response immediately after afterResponse.
    // Extension exceptions are diagnostic only, so throwing cannot veto a yield.
    let result: Awaited<ReturnType<typeof gate>>;
    try { result = await gate(api, ctx, current); } catch (error) {
      ctx.abortSignal?.throwIfAborted();
      result = { unfinished: "pstack 无法读取本轮完成凭据：" + (error as Error).message };
    }
    if (!options.active()) return;
    if (result?.complete) {
      if (result.answerDraft) answer.content = [{type:"text",text:result.answerDraft}];
      if (result.thermosOutcome && !answer.content.some(part => part.type === "text" && part.text.includes(result.thermosOutcome!)))
        answer.content = [...answer.content, { type: "text", text: "\n\n" + result.thermosOutcome }];
      if (result.attention) {
        const { models, flags } = result.attention;
        answer.content = [...answer.content, { type: "text", text: "\n\n## Attention\n\nreviewed by " + models.join(", ") + "\n\n" + (flags.length ? flags.map(flag => "- " + flag).join("\n") : "No flags") }];
      }
    } else if (result?.blocked) {
      answer.content = [{ type: "text", text: formatPstackBlock(result.blocked) }];
    } else if (result?.unfinished) {
      answer.content = [{ type: "text", text: result.unfinished }];
      answer.stopReason = "aborted";
      answer.errorMessage = result.unfinished;
    } else if (result?.continue) {
      answer.content = [{ type: "text", text: "pstack 工作流尚未完成验证，正在继续。" }];
    }
  };
  const onYield: GenerationHooks["onYield"] = async (_answer, api, ctx) => {
    const current = await currentWorkflow(api, ctx);
    if (!current) return;
    const result = await gate(api, ctx, current);
    return result?.continue ? { continue: result.continue } : undefined;
  };
  return { beforeTool, onYield, afterResponse, afterTool: captureAuthoredSkill(options) };
}
