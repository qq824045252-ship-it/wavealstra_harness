import {
  createContext, useCallback, useContext, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type Dispatch, type ReactNode, type RefObject, type SetStateAction, type UIEventHandler,
} from "react";
import { createPortal } from "react-dom";
import { IconPanel } from "@/components/common/icons";

type LeaveGuard = () => boolean | Promise<boolean>;
type NavigationAction = () => void | Promise<void>;

interface DesktopSectionContext {
  target: HTMLElement | null;
  collapseList?: () => void;
  session: Map<string, unknown>;
  registerGuard: (guard: LeaveGuard) => () => void;
  navigate: (action: NavigationAction) => Promise<boolean>;
}

const DesktopContext = createContext<DesktopSectionContext | null>(null);
const DesktopSectionVisible = createContext(true);

export function DesktopSectionVisibility({ visible, children }: { visible: boolean; children: ReactNode }): React.JSX.Element {
  return <DesktopSectionVisible.Provider value={visible}>{children}</DesktopSectionVisible.Provider>;
}

export function DesktopSectionProvider({ target, collapseList, children }: {
  target: HTMLElement | null;
  collapseList?: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const session = useRef(new Map<string, unknown>());
  const guards = useRef(new Set<LeaveGuard>());
  const pending = useRef(false);
  const registerGuard = useCallback((guard: LeaveGuard) => {
    guards.current.add(guard);
    return () => { guards.current.delete(guard); };
  }, []);
  const navigate = useCallback(async (action: NavigationAction): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    try {
      for (const guard of [...guards.current]) {
        if (!await guard()) return false;
      }
      await action();
      return true;
    } catch (error) {
      console.error("Desktop navigation failed", error);
      return false;
    } finally {
      pending.current = false;
    }
  }, []);

  return <DesktopContext.Provider value={{ target, collapseList, session: session.current, registerGuard, navigate }}>{children}</DesktopContext.Provider>;
}

export function useDesktopShell(): boolean {
  return useContext(DesktopContext) !== null;
}

export function useDesktopNavigate(): ((action: NavigationAction) => Promise<boolean>) | undefined {
  return useContext(DesktopContext)?.navigate;
}

export function useDesktopSectionScroll(ref: RefObject<HTMLDivElement | null>, scrollKey?: string): UIEventHandler<HTMLDivElement> {
  const { target, session } = useContext(DesktopContext) ?? {};
  const visible = useContext(DesktopSectionVisible);
  const key = scrollKey ? `scroll:${scrollKey}` : undefined;
  const restoring = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    const saved = key ? Number(session?.get(key) ?? 0) : 0;
    if (!visible || !element || !saved) return;
    const observer = new MutationObserver(restore);
    const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(restore) : undefined;
    function stop(): void {
      restoring.current = false;
      observer.disconnect();
      resize?.disconnect();
    }
    function restore(): void {
      if (!element || element.clientHeight === 0 || element.scrollHeight - element.clientHeight < saved) return;
      element.scrollTop = saved;
      stop();
    }
    restoring.current = true;
    observer.observe(element, { childList: true, subtree: true });
    resize?.observe(element);
    restore();
    element.addEventListener("wheel", stop, { once: true, passive: true });
    element.addEventListener("pointerdown", stop, { once: true });
    return () => {
      stop();
      element.removeEventListener("wheel", stop);
      element.removeEventListener("pointerdown", stop);
    };
  }, [ref, key, target, session, visible]);
  return event => {
    if (key && !restoring.current && event.currentTarget.clientHeight > 0) session?.set(key, event.currentTarget.scrollTop);
  };
}

export function useDesktopLeaveGuard(guard: LeaveGuard | undefined): void {
  const register = useContext(DesktopContext)?.registerGuard;
  const current = useRef(guard);
  current.current = guard;
  const enabled = Boolean(guard);
  useLayoutEffect(() => {
    if (!enabled) return;
    return register?.(() => current.current?.() ?? true);
  }, [register, enabled]);
}

export function useDesktopSectionState<T>(key: string | null, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const session = useContext(DesktopContext)?.session;
  const [value, setValue] = useState(() => {
    const saved = key ? session?.get(key) : undefined;
    return saved === undefined ? initial : saved as T;
  });
  useLayoutEffect(() => {
    if (key) session?.set(key, value);
  }, [key, session, value]);
  return [value, setValue];
}

export function DesktopSectionSidebar({ title, actions, children, scrollKey, ownScroll = false }: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
  scrollKey?: string;
  ownScroll?: boolean;
}): React.ReactPortal | null {
  const desktop = useContext(DesktopContext);
  const scroller = useRef<HTMLDivElement>(null);
  const target = desktop?.target;
  const visible = useContext(DesktopSectionVisible);
  const rememberScroll = useDesktopSectionScroll(scroller, scrollKey);
  if (!desktop || !target || !visible) return null;

  return createPortal(
    <>
      <div className="desktop-section-heading">
        <h2>{title}</h2>
        {(actions || desktop.collapseList) && (
          <div className="desktop-section-actions">
            {actions}
            {desktop.collapseList && (
              <button type="button" className="icon-btn" title="收起模块列表" aria-label="收起模块列表"
                aria-controls="desktop-module-list" aria-expanded={true} onClick={desktop.collapseList}>
                <IconPanel size={15} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className={ownScroll ? "desktop-section-content desktop-section-content--own" : "desktop-section-content"}
        ref={scroller} onScroll={rememberScroll}>
        {children}
      </div>
    </>,
    target,
  );
}

export function DesktopSectionRow({ active, icon, meta, className = "", children, ...button }: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  icon?: ReactNode;
  meta?: ReactNode;
}): React.JSX.Element {
  return <button type="button" aria-current={active ? "true" : undefined} {...button} className={`desktop-section-row ${className}`}>
    {icon}
    <span className="desktop-section-label">{children}</span>
    {meta != null && <span className="desktop-section-meta">{meta}</span>}
  </button>;
}
