import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import AnswerRoutingTab, { type TeachingResult } from "@/components/settings/AnswerRoutingTab";

export default function ChatAnswerRuleDialog({ taskId }: { taskId: string }) {
  const seed = useAppStore(s => s.answerRuleSeed?.turn?.taskId === taskId ? s.answerRuleSeed : undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<TeachingResult>();
  useBlockNativeSurfaces(!!seed);
  useEffect(() => {
    const element = dialog.current;
    if (!seed || !element) return;
    setResult(undefined);
    element.showModal();
    return () => element.close();
  }, [seed]);
  useEffect(() => () => {
    if (useAppStore.getState().answerRuleSeed?.turn?.taskId === taskId) useAppStore.setState({ answerRuleSeed: undefined });
  }, [taskId]);
  useEffect(() => {
    if (!result || result.review) return;
    const timer = window.setTimeout(() => setResult(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [result]);

  const finish = (confirmation?: TeachingResult) => {
    useAppStore.setState({ answerRuleSeed: undefined });
    setResult(confirmation);
  };
  if (seed) return <dialog ref={dialog} className="answer-rule-dialog" aria-label="教它下次怎么答"
    onCancel={event => { event.preventDefault(); if (!dialog.current?.querySelector('fieldset[aria-busy="true"]')) finish(); }}>
    <AnswerRoutingTab finishTeaching={finish} />
  </dialog>;
  if (!result) return null;
  return <div role="status" className="answer-rule-confirmation">{result.message}
    {result.review && <>
      <button type="button" className="btn" onClick={() => { setResult(undefined); useAppStore.getState().setSettingsOpen(true, "dots"); }}>查看规则</button>
      <button type="button" className="btn" onClick={() => setResult(undefined)}>关闭</button>
    </>}
  </div>;
}
