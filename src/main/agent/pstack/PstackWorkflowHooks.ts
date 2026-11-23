import type { GenerationHooks, HookApi, ToolHooks } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { live, runSettings, state, transcript, WorkflowFiles, type WorkflowOptions } from "./PstackState";
import { measureWorkspace, reviewScope, verificationCheckout } from "./PstackWorkspace";
import { reviewMatchesVerification } from "./PstackVerificationEvidence";
import { MERGE_REVIEW_BLOCK } from "./PstackReviewIntent";
import { authoredFiles, captureAuthoredSkill } from "./PstackAuthoredSkills";
import { codingTagRoute } from "../../../shared/pstack/coding-tags";
import { formatPstackBlock } from "./PstackBlockReport";

const mutatingTools = new Set(["write", "edit", "bash", "powershell", "subagent", "terminal_exec", "execute_code", "apply_patch", "skill_authoring_create"]);
export const textMessage = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.filter(item => item.type === "text").map(item => item.text).join("\n");

export function createPstackWorkflowHooks(options: WorkflowOptions) {
  const beforeTool: ToolHooks["beforeTool"] = async (call, api, ctx) => {
    if (!options.active()) return;
    const defaultRoute = codingTagRoute(options.tag);
    const tagObservation = defaultRoute && defaultRoute !== "auto" && ["read", "find", "grep", "ls"].includes(call.name);
    if (!mutatingTools.has(call.name) && !tagObservation) return;
    const run = await state(api, ctx);
    if (run?.task === options.taskId) {
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
    }
    return { block: defaultRoute && defaultRoute !== "auto" ?
      "当前标签默认流程为 " + defaultRoute + "。先调用 pstack_workflow(action=start)，已暂停的任务用 resume；若默认流程停用请用 status 选择。" :
      "This coding task needs an active pstack workflow. Call pstack_workflow status and start or resume before this tool." };
  };

  async function gate(api: HookApi, ctx: Context) {
    if (!options.active()) return;
    const active = await live(api, ctx);
    if (!active?.first || !active.inputs.length) return;
    const run = await state(api, ctx);
    const taskScoped = run?.task === options.taskId && (run.phase !== "complete" || run.inputs.some(id => active.inputs.includes(id as typeof active.inputs[number])));
    if (taskScoped && run.phase === "complete") return { complete: true, thermosOutcome: run.thermosOutcome, attention: run.attention,
      answerDraft: run.playbook === "investigation" && run.review?.passed ? run.review.answerDraft : undefined } as const;
    if (taskScoped && run.phase === "blocked") {
      if (run.inputs.some(id => active.inputs.includes(id as typeof active.inputs[number]))) return { blocked: run.block } as const;
      // A follow-up can acknowledge or discuss a blocked run. Resume explicitly rebinds the new input.
      return;
    }
    const history = await transcript(api, ctx, active.first);
    const inputs = history.filter(e => e.kind === "pi.user" || e.kind === "mybuddy.user").flatMap(e =>
      (e.model ?? []).flatMap(m => m.role === "user" ? [textMessage(m.content)] : []));
    const identity = "[MyBuddy pstack " + active.inputs.join(",") + "]";
    const nudges = inputs.filter(text => text.startsWith(identity)).length;
    if (nudges >= 2) return { unfinished: "pstack 工作流尚未通过完成检查。" + (taskScoped ? "当前剧本为 " + run.playbook + "。" : "尚未开始本轮流程。") + "请查看当前阶段，补齐证据，或记录具体阻碍。" } as const;
    return { continue: identity + " The native workflow has not completed. Call pstack_workflow status, then finish the required phase or call block with the specific dependency and explain it to the user." } as const;
  }
  const afterResponse: GenerationHooks["afterResponse"] = async (answer, api, ctx) => {
    if (!options.active() || !["stop", "length", "toolUse"].includes(answer.stopReason) || answer.content.some(c => c.type === "toolCall")) return;
    // Pi classifies this terminal response immediately after afterResponse.
    // Extension exceptions are diagnostic only, so throwing cannot veto a yield.
    let result: Awaited<ReturnType<typeof gate>>;
    try { result = await gate(api, ctx); } catch (error) {
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
    const result = await gate(api, ctx);
    return result?.continue ? { continue: result.continue } : undefined;
  };
  return { beforeTool, onYield, afterResponse, afterTool: captureAuthoredSkill(options) };
}
