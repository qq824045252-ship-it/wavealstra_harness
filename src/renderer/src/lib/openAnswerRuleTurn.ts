import { DOTS_TASK_ID } from "@shared/dots";
import type { AnswerRuleUse } from "@shared/answer-routing";
import { useAppStore } from "@/store/appStore";

export async function openAnswerRuleTurn({ taskId, inputId }: Pick<AnswerRuleUse, "taskId" | "inputId">): Promise<void> {
  const store = useAppStore.getState();
  store.setSettingsOpen(false);
  if (taskId === DOTS_TASK_ID) await store.openDots();
  else store.setActiveTask(taskId);
  useAppStore.setState({ answerRuleTurnTarget: { taskId, inputId } });
}
