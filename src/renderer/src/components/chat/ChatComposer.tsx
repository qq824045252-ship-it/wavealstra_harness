import { forwardRef, useCallback, useLayoutEffect, useRef, type ReactNode, type TextareaHTMLAttributes } from "react";

export interface ChatComposerProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Presentation only. The owning adapter keeps its own identity, draft and send semantics. */
  toolbar: ReactNode;
  toolbarClassName?: string;
  maxHeight?: number;
}

/** The same controlled editor and toolbar surface for task chat and Bot conversation. */
const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(function ChatComposer({
  toolbar, toolbarClassName = "input-toolbar", maxHeight = 180,
  onKeyDown, onChange, className = "input-textarea", ...textareaProps
}, forwardedRef) {
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const resize = useCallback(() => {
    const node = editor.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, maxHeight)}px`;
  }, [maxHeight]);
  useLayoutEffect(resize, [resize, textareaProps.value]);
  return <>
    <textarea {...textareaProps} className={className}
      aria-label={textareaProps["aria-label"] ?? "输入消息"}
      ref={node => {
        editor.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
      onCompositionStart={event => { composing.current = true; textareaProps.onCompositionStart?.(event); }}
      onCompositionEnd={event => { composing.current = false; textareaProps.onCompositionEnd?.(event); }}
      onKeyDown={event => {
        // Enter confirms IME candidates, not a message. 229 covers older Chromium IMEs.
        if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) return;
        onKeyDown?.(event);
      }}
      onChange={event => { onChange?.(event); resize(); }}
    />
    <div className={toolbarClassName}>{toolbar}</div>
  </>;
});
export default ChatComposer;
