import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardPage, BoardQuery } from "@shared/task-board";

// A background change should not move the card under the pointer. Navigation and explicit edits refresh immediately.
export function useTaskBoardPages(queries: BoardQuery[], enabled: boolean, revision: number) {
  const keys = queries.map((q) => JSON.stringify(q));
  const key = JSON.stringify(keys);
  const [value, setValue] = useState<Map<string, BoardPage>>();
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const last = useRef("");
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  useEffect(() => {
    let active = true,
      busy = false;
    last.current = "";
    setError("");
    setChanged(false);
    if (!enabled) return;
    async function read(background: boolean) {
      if (busy || (background && document.hidden)) return;
      busy = true;
      try {
        const db = window.api?.db;
        if (!db) throw new Error("桌面数据库未就绪");
        const queryKeys: string[] = JSON.parse(key);
        const pages = await Promise.all(queryKeys.map((query) => db.taskBoardPage(JSON.parse(query) as BoardQuery)));
        if (!active) return;
        const signature = JSON.stringify(pages);
        if (!background || !last.current) {
          last.current = signature;
          setValue(new Map(queryKeys.map((query, i) => [query, pages[i]])));
          setChanged(false);
        } else setChanged(signature !== last.current);
        setError("");
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "读取任务失败");
      } finally {
        busy = false;
      }
    }
    void read(false);
    const check = () => void read(true);
    const timer = setInterval(check, 15000);
    window.addEventListener("focus", check);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [key, enabled, revision, reload]);
  const pages = enabled ? keys.map((query) => value?.get(query)) : [];
  return { pages: pages.some(Boolean) ? pages : undefined, error, changed, refresh };
}
