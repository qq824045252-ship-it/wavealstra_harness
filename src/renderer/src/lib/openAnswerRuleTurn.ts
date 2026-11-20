import type { AnswerRuleUse } from "@shared/answer-routing";
import { useAppStore } from "@/store/appStore";

export function openAnswerRuleTurn({ taskId, inputId }: Pick<AnswerRuleUse, "taskId" | "inputId">): void {
  const store = useAppStore.getState();
  store.setActiveTask(taskId);
  store.setSettingsOpen(false);
  useAppStore.setState({ answerRuleTurnTarget: { taskId, inputId } });
}
