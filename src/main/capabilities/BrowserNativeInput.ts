import type { PageInspectionSession } from "../artifact/PageInspectionService";
import { UiAutomationError, type UiNativeInput } from "./UiAutomationService";

const virtualKeys: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91 };
const aliases: Record<string, string> = { Return: "Enter", Esc: "Escape", Left: "ArrowLeft", Up: "ArrowUp", Right: "ArrowRight", Down: "ArrowDown", " ": "Space" };

/** Trusted input through the same Electron debugger session used by inspection.
 * CDP addresses the pinned renderer, independent of native window focus. */
export function browserNativeInput(session: PageInspectionSession): UiNativeInput {
  return {
    insertText: text => session.inputCommand("Input.insertText", { text }),
    send: async event => {
      const flags = event.modifiers ?? [];
      const modifiers = (flags.includes("alt") ? 1 : 0) | (flags.includes("control") ? 2 : 0) | (flags.includes("meta") ? 4 : 0) | (flags.includes("shift") ? 8 : 0);
      if ("keyCode" in event) {
        const key = aliases[event.keyCode] ?? event.keyCode;
        const letter = /^[a-z]$/i.test(key), digit = /^\d$/.test(key), fn = /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
        const virtualKey = letter ? key.toUpperCase().charCodeAt(0) : digit ? key.charCodeAt(0) : fn ? 111 + Number(key.slice(1)) : virtualKeys[key];
        if (virtualKey === undefined) throw new UiAutomationError("INVALID_INPUT", `不支持的浏览器按键：${key}`);
        const printable = letter ? flags.includes("shift") ? key.toUpperCase() : key.toLowerCase() : digit ? key : key === "Space" ? " " : key === "Enter" ? "\r" : "";
        await session.inputCommand("Input.dispatchKeyEvent", { type: event.type === "keyUp" ? "keyUp" : "keyDown", key: key === "Space" ? " " : letter ? printable : key, code: letter ? `Key${key.toUpperCase()}` : digit ? `Digit${key}` : key, windowsVirtualKeyCode: virtualKey, modifiers,
          ...(event.type !== "keyUp" && !(modifiers & 7) && printable ? { text: printable, unmodifiedText: printable } : {}) });
        return;
      }
      const type = event.type === "mouseDown" ? "mousePressed" : event.type === "mouseUp" ? "mouseReleased" : event.type === "mouseWheel" ? "mouseWheel" : "mouseMoved";
      await session.inputCommand("Input.dispatchMouseEvent", { type, x: event.x, y: event.y, modifiers, button: event.button ?? "none", clickCount: "clickCount" in event ? event.clickCount : 0,
        ...("deltaX" in event ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 } : {}) });
    },
  };
}
