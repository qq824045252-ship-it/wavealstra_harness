import assert from "node:assert/strict";

type Call = [string,Record<string,unknown>];
const workflow = (action: string, args: Record<string,unknown> = {}): Call => ["pstack_workflow", { action, ...args }];
const workUnit = (action: string, args: Record<string,unknown> = {}): Call => ["pstack_orchestrate", { action, ...args }];
const unitDispatch = workUnit("dispatch", { id: "owner", role: "how-explorer" });
const stageDispatch: Call = ["pstack_delegate", { purpose: "stage", role: "how-explainer", tasks: ["UNIT_PROVIDER_STAGE: explain tested.txt."] }];
const auditDispatch: Call = ["pstack_delegate", { purpose: "decisions", role: "judgment", tasks: ["UNIT_PROVIDER_DECISIONS: inspect this decision."] }];

const steps = {
  UNIT_PROVIDER_BOARD: [workflow("start", {playbook:"orchestrate"}), workUnit("unit",{id:"owner", brief:"UNIT_PROVIDER_BOARD: inspect tested.txt."}),
    unitDispatch, workflow("resume"), unitDispatch, workUnit("status"), workflow("status")],
  UNIT_PROVIDER_STAGE: [workflow("start",{skill:"how"}), workflow("advance",{stage:"scope",note:"Single source file."}),
    workflow("advance",{stage:"investigate",note:"Inspected the entry."}), stageDispatch, workflow("resume"), stageDispatch, workflow("status")],
  UNIT_PROVIDER_DECISIONS: [workflow("start",{skill:"show-me-your-work"}), workflow("decision",{decision:{
    phase:"research",decision:"Keep the existing label.",why:"The API contract specifies this label.",evidence:"Read tested.txt.",result:"No rename."}}),
    auditDispatch, workflow("resume"), auditDispatch, workflow("status")],
};
const recovery = [workflow("resume"), unitDispatch, workUnit("status"), workflow("block",{note:"The caller will verify the returned unit."})];
const rounds = new Map<string,number>(), rejections = new Map<string,number>();
let recovered = false;
export function providerFixtureResponse(raw: string, model: string): {call?: Call; quota?: boolean; answer?: string} | undefined {
  const key = (Object.keys(steps) as (keyof typeof steps)[]).find(k=>raw.includes(k));
  if (!key) return;
  if (model === "cron" || model === "gpt-author") {
    const token = key + (recovered ? "_recovered" : "");
    const round = rounds.get(token) ?? 0;
    rounds.set(token, round + 1);
    return {call: (recovered ? recovery : steps[key])[round], answer:"Task status recorded."};
  }
  if (recovered) return {answer:"The owner inspected the requested input and returned."};
  rejections.set(key,(rejections.get(key) ?? 0) + 1);
  return {quota:true};
}

type Result = { phase?: string; run?: number; dispatchDependency?: { purpose: string; role: string; delegateTaskId: number;
  failures: { child: string; model: string; resetAt: string }[] };
  units?: {status:string;attempts:number;providerFailures:number;unknownFailures:number;receipt:number}[]; inbox?: {dispatch:number}[] };

export async function checkProviderRecovery(
  submit: (taskId: string, text: string, initial: boolean) => Promise<Result[]>, reopen: () => Promise<void>
) {
  let originalRun: number | undefined;
  for (const [key, role, purpose] of [["UNIT_PROVIDER_BOARD","how-explorer","stage"],["UNIT_PROVIDER_STAGE","how-explainer","stage"],["UNIT_PROVIDER_DECISIONS","judgment","decisions"]]) {
    const results = await submit(key,key+" Inspect the account-bound worker for this task.",true);
    const blocked = results.find(r=>r.phase==="blocked" && r.dispatchDependency);
    assert(blocked?.dispatchDependency, JSON.stringify(results).slice(-1200));
    const dep=blocked.dispatchDependency;
    assert.equal(dep.role,role); assert.equal(dep.purpose,purpose);
    assert.equal(dep.failures[0]?.model,key==="UNIT_PROVIDER_DECISIONS" ? "fixture/claude-observer" : "fixture/observer");
    assert.equal(dep.failures[0]?.resetAt,"2026-12-01T00:00:00Z");
    assert.equal(rejections.get(key),1);
    if (key==="UNIT_PROVIDER_BOARD") {
      originalRun=blocked.run;
      const board=results.find(r=>r.units?.[0]?.status==="failed");
      assert(board?.units && board.inbox);
      assert.deepEqual([board.units[0].attempts,board.units[0].providerFailures,board.units[0].unknownFailures],[1,1,0]);
      assert.equal(board.units[0].receipt,dep.delegateTaskId);
      assert.deepEqual(board.inbox.map(row=>row.dispatch),[dep.delegateTaskId]);
    }
  }
  await reopen();
  recovered=true;
  const results=await submit("UNIT_PROVIDER_BOARD","UNIT_PROVIDER_BOARD restored. Resume the same owner.",false);
  assert(results.some(r=>r.phase==="running" && r.run===originalRun && !r.dispatchDependency));
  const board=results.findLast(r=>r.units?.[0]?.status==="returned");
  assert.equal(board?.units?.[0]?.attempts,2,"One failed provider attempt and one recovered owner must be visible even with retryLimit=0");
  assert.equal(board?.units?.[0]?.providerFailures,1);
  assert.equal(rejections.get("UNIT_PROVIDER_BOARD"),1);
}
