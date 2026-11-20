import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import type { CadCraftSource } from "@shared/cadcraft";
import "./OfficeDocumentView.css";

type OfficeApi = NonNullable<Window["api"]>["officeUse"];
export type OfficeDocumentSource = Parameters<OfficeApi["open"]>[0]["source"];
const releases = new Map<string, Promise<void>>();

type Props = ({ kind?: "office"; source: OfficeDocumentSource } | { kind: "cad"; source: CadCraftSource }) & {
  name: string;
  blocked?: boolean;
}

function dimensions(host: HTMLDivElement, blocked: boolean) {
  const { left, top, right, bottom } = host.getBoundingClientRect();
  let x = Math.max(0, left);
  let y = Math.max(0, top);
  let endX = Math.min(window.innerWidth, right);
  let endY = Math.min(window.innerHeight, bottom);
  for (let parent = host.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const rect = parent.getBoundingClientRect();
    if (style.overflowX !== "visible") {
      const edge = rect.left + parent.clientLeft;
      x = Math.max(x, edge);
      endX = Math.min(endX, edge + parent.clientWidth);
    }
    if (style.overflowY !== "visible") {
      const edge = rect.top + parent.clientTop;
      y = Math.max(y, edge);
      endY = Math.min(endY, edge + parent.clientHeight);
    }
  }
  x = Math.ceil(x);
  y = Math.ceil(y);
  const width = Math.floor(endX) - x;
  const height = Math.floor(endY) - y;
  if (blocked || width <= 0 || height <= 0 || getComputedStyle(host).visibility !== "visible") {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x, y, width, height };
}

export default function OfficeDocumentView({ kind = "office", source, name, blocked = false }: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<string>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const sourceKey = JSON.stringify([kind, source]);

  useEffect(() => {
    let current = true;
    const api = window.api?.officeUse;
    setError("");
    setSession(undefined);
    const cadApi = window.api?.cadCraft;
    if (!api || (kind === "cad" && !cadApi)) {
      setError(`${kind === "cad" ? "CADCraft" : "Office Use"} 接口不可用，请重启 MyBuddy 后重试。`);
      return;
    }
    const previous = releases.get(sourceKey);
    const opening = Promise.resolve().then(async () => {
      await previous;
      if (!current) return undefined;
      const [, stableSource] = JSON.parse(sourceKey);
      const { id } = kind === "cad" && cadApi
        ? await cadApi.open(stableSource)
        : await api.open({ source: stableSource, name, modelId: useAppStore.getState().activeModelId ?? undefined });
      if (current) setSession(id);
      return id;
    });
    void opening.catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      current = false;
      const released = opening.then(async (id) => { if (id) await api.close(id); }).catch(() => {});
      releases.set(sourceKey, released);
      void released.then(() => { if (releases.get(sourceKey) === released) releases.delete(sourceKey); });
    };
  }, [sourceKey, kind, name, attempt]);

  useEffect(() => {
    if (!session) return;
    return window.api?.officeUse?.onFailure?.((id, message) => {
      if (id !== session) return;
      setError(message);
      setSession(undefined);
    });
  }, [session]);

  useLayoutEffect(() => {
    const api = window.api?.officeUse;
    const element = host.current;
    if (!api || !element || !session) return;
    let previous = "";
    let frame = 0;
    const report = (): void => {
      frame = 0;
      const bounds = dimensions(element, blocked);
      const key = [bounds.x, bounds.y, bounds.width, bounds.height].join(",");
      if (key === previous) return;
      previous = key;
      void Promise.resolve(api.bounds(session, bounds)).catch(() => {});
    };
    const schedule = (): void => {
      if (!frame) frame = window.requestAnimationFrame(report);
    };
    report();
    const resize = new ResizeObserver(schedule);
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) resize.observe(parent);
    const intersection = new IntersectionObserver(schedule, { threshold: [0, 1] });
    intersection.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule);
      void Promise.resolve(api.bounds(session, { x: 0, y: 0, width: 0, height: 0 })).catch(() => {});
    };
  }, [session, blocked]);

  return <div ref={host} className="office-document-view" aria-label={name}>
    {error ? <div className="office-document-status">
      <p role="alert">{error}</p>
      <button type="button" onClick={() => setAttempt((value) => value + 1)}>重新打开</button>
    </div> : !session ? <p className="office-document-status" role="status">正在打开 {name}…</p> : null}
  </div>;
}
