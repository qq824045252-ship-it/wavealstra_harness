import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  initialFollowState, keyboardIntent, onHistoryJump, onPointerCancel, onPointerDown,
  onPointerUp, onResetForTask, onScroll, onUserScrollDown, onUserScrollUp,
  onWheelUpCandidate, type FollowState,
} from "@/lib/scrollFollow";

/** Same explicit user-intent contract as ChatView. A streaming reply never owns
 * an upward scroll: concurrent replies may update anywhere in the conversation. */
export function useBotThreadScroll(
  ref: RefObject<HTMLDivElement | null>, conversationKey: string, visible: boolean,
  messages: readonly unknown[],
) {
  const state = useRef(initialFollowState());
  const followLatest = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const frame = useRef(0);
  const enabled = useRef(visible); enabled.current = visible;
  const previousTop = useRef(0);
  const target = useRef<number | null>(null);
  const commit = useCallback((next: FollowState) => {
    state.current = next; followLatest.current = next.follow;
    setAwayFromBottom(!next.follow);
  }, []);
  const cancel = useCallback(() => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);
  const writeTop = useCallback((top: number) => {
    const el = ref.current;
    if (!el) return;
    const next = Math.max(0, Math.min(top, el.scrollHeight - el.clientHeight));
    if (Math.abs(el.scrollTop - next) > 1) { target.current = next; el.scrollTop = next; }
    previousTop.current = el.scrollTop;
  }, [ref]);
  const schedule = useCallback(() => {
    cancel();
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      // Recheck after DOM commit: a wheel/keyboard gesture can arrive between
      // scheduling and paint. Never let a queued output frame undo it.
      const s = state.current, el = ref.current;
      if (!enabled.current || !el || !s.follow || s.pointerScrolling || s.wheelUpPending) return;
      if (el.scrollTop < previousTop.current - 1 && el.scrollHeight - el.clientHeight - el.scrollTop > 48) {
        // A scrollbar/navigation move can precede its scroll event. A queued
        // resize/output frame must not overwrite that intervening movement.
        target.current = null; previousTop.current = el.scrollTop;
        commit(onUserScrollUp(s)); return;
      }
      writeTop(el.scrollHeight);
    });
  }, [cancel, commit, ref, writeTop]);
  const pauseFollowing = useCallback(() => {
    cancel(); target.current = null; commit(onHistoryJump(state.current));
  }, [cancel, commit]);
  const followBottom = useCallback(() => {
    commit(onResetForTask(state.current)); schedule();
  }, [commit, schedule]);
  const restoreScroll = useCallback((top: number, follow: boolean) => {
    cancel();
    commit(follow ? onResetForTask(state.current) : onHistoryJump(state.current));
    writeTop(top);
  }, [cancel, commit, writeTop]);

  useLayoutEffect(() => {
    cancel(); target.current = null; previousTop.current = 0;
    commit(initialFollowState());
  }, [conversationKey, cancel, commit]);
  useLayoutEffect(() => {
    if (visible) schedule(); else cancel();
    return cancel;
  }, [conversationKey, visible, messages, schedule, cancel]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !visible) return;
    previousTop.current = el.scrollTop;
    const distance = () => Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
    const handleScroll = () => {
      const top = el.scrollTop, delta = top - previousTop.current;
      previousTop.current = top;
      if (target.current !== null) {
        const resolved = Math.abs(top - Math.min(target.current, Math.max(0, el.scrollHeight - el.clientHeight))) <= 2;
        target.current = null;
        if (resolved) return;
      }
      let s = state.current;
      // Distance alone (including browser scroll anchoring / content collapse)
      // must never re-enable follow. Downward intent comes from user input only.
      if (!s.pointerScrolling && !s.direction && !s.wheelUpPending && delta < -1 && distance() > 48) s = onUserScrollUp(s);
      const next = onScroll(s, distance(), delta);
      commit(next.follow && next.direction === "down" ? { ...next, direction: null } : next);
    };
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      cancel(); target.current = null;
      commit(event.deltaY < 0 ? onWheelUpCandidate(state.current) : onUserScrollDown(state.current));
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target !== el && event.pointerType !== "touch") return;
      cancel(); target.current = null; commit(onPointerDown(state.current, distance()));
    };
    const pointerUp = () => commit(onPointerUp(state.current, distance()));
    const pointerCancel = () => commit(onPointerCancel(state.current));
    const key = (event: KeyboardEvent) => {
      const node = event.target;
      if (!(node instanceof HTMLElement) || !el.contains(node)) return;
      const intent = keyboardIntent(event.key, event.shiftKey,
        node.matches("input, textarea") || node.isContentEditable,
        node.matches("button, a, select, [role=button]"));
      if (!intent) return;
      cancel(); target.current = null;
      commit(intent === "up" ? onUserScrollUp(state.current) : onUserScrollDown(state.current));
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("pointerdown", pointerDown, { passive: true });
    document.addEventListener("pointerup", pointerUp);
    document.addEventListener("pointercancel", pointerCancel);
    el.addEventListener("keydown", key);
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    const list = el.querySelector(".bot-message-list");
    if (list) observer.observe(list);
    return () => {
      cancel(); observer.disconnect();
      el.removeEventListener("scroll", handleScroll); el.removeEventListener("wheel", wheel);
      el.removeEventListener("pointerdown", pointerDown); el.removeEventListener("keydown", key);
      document.removeEventListener("pointerup", pointerUp); document.removeEventListener("pointercancel", pointerCancel);
    };
  }, [conversationKey, visible, messages.length > 0, cancel, commit, ref, schedule]);
  return { followLatest, awayFromBottom, pauseFollowing, restoreScroll, followBottom };
}
