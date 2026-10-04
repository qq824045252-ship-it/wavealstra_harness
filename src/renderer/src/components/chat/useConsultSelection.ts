import { useCallback, useEffect, useRef, useState } from "react";
import { consultEntryReadiness } from "@shared/consult-entry";

interface ConsultSelectionOptions {
  taskId: string | null;
  externalAgentId?: string;
  settingsOpen: boolean;
  openSettings: () => void;
  focusComposer: () => void;
}

/** One-message intent only. Configuration checks never open settings or run models. */
export function useConsultSelection(options: ConsultSelectionOptions) {
  const [requested, setRequested] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsConfiguration, setNeedsConfiguration] = useState(false);
  const epoch = useRef(0);
  const scope = JSON.stringify([options.taskId, options.externalAgentId ?? null]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const latest = useRef(options);
  latest.current = options;
  const pendingSetup = useRef<{ scope: string; opened: boolean } | null>(null);

  const clear = useCallback(() => {
    epoch.current += 1;
    pendingSetup.current = null;
    setRequested(false);
    setNotice(null);
    setNeedsConfiguration(false);
  }, []);

  useEffect(() => {
    clear();
    // A response arriving after a task change or unmount cannot select another message.
    return () => { epoch.current += 1; pendingSetup.current = null; };
  }, [scope, clear]);

  const select = useCallback(async (): Promise<void> => {
    const callEpoch = ++epoch.current;
    const callScope = liveScope.current;
    const current = () => epoch.current === callEpoch && liveScope.current === callScope;
    pendingSetup.current = null;
    setNeedsConfiguration(false);
    if (latest.current.externalAgentId) {
      setNotice("请先切回 MyBuddy 主模型，再使用多模型会诊。");
      return;
    }
    try {
      const read = window.api?.agent?.getBuiltinCapabilities;
      if (!read) throw new Error("会诊配置读取服务不可用，请重新打开 MyBuddy；不会跳转或覆盖已有配置。");
      const snapshot = await read();
      if (!current()) return;
      const result = consultEntryReadiness(snapshot?.config?.multiModelConsult);
      if (!result.ready) {
        setRequested(false);
        setNeedsConfiguration(true);
        setNotice(result.notice);
        return;
      }
      setRequested(true);
      setNotice(null);
      latest.current.focusComposer();
    } catch (error) {
      if (current()) {
        setRequested(false);
        setNotice(error instanceof Error ? error.message : String(error));
      }
    }
  }, []);

  const openConfiguration = useCallback(() => {
    // This is an explicit user navigation, not an asynchronous check redirect.
    epoch.current += 1;
    pendingSetup.current = { scope: liveScope.current, opened: false };
    latest.current.openSettings();
  }, []);

  useEffect(() => {
    const pending = pendingSetup.current;
    if (!pending || pending.scope !== scope) return;
    if (options.settingsOpen) pending.opened = true;
    else if (pending.opened) {
      // Re-read Main's saved configuration after closing settings, never the unsaved draft.
      pendingSetup.current = null;
      void select();
    }
  }, [options.settingsOpen, scope, select]);

  return { requested, notice, needsConfiguration, select, clear, setNotice, openConfiguration };
}
