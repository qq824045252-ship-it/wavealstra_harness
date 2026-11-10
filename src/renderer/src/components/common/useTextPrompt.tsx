import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TextPromptOptions {
  title: string;
  description?: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  allowEmpty?: boolean;
  multiline?: boolean;
  maxLength?: number;
}

interface PendingPrompt {
  options: TextPromptOptions;
  resolve: (value: string | null) => void;
}

interface TextPromptController {
  requestText: (options: TextPromptOptions) => Promise<string | null>;
  textPromptDialog: React.JSX.Element | null;
  promptOpen: boolean;
}

/** Electron does not implement window.prompt, so renderer input prompts use this React dialog. */
export function useTextPrompt(): TextPromptController {
  const titleId = useId();
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [value, setValue] = useState("");
  const pendingRef = useRef<PendingPrompt | null>(null);

  const requestText = useCallback((options: TextPromptOptions): Promise<string | null> => {
    return new Promise((resolve) => {
      pendingRef.current?.resolve(null);
      const next = { options, resolve };
      pendingRef.current = next;
      setValue(options.initialValue ?? "");
      setPending(next);
    });
  }, []);

  const finish = useCallback((result: string | null): void => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(result);
  }, []);

  useEffect(() => {
    if (!pending) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [finish, pending]);

  useEffect(() => () => {
    pendingRef.current?.resolve(null);
    pendingRef.current = null;
  }, []);

  if (!pending) return { requestText, textPromptDialog: null, promptOpen: false };

  const { options } = pending;
  const confirmDisabled = options.allowEmpty !== true && !value.trim();
  const field = options.multiline ? (
    <textarea
      autoFocus
      value={value}
      maxLength={options.maxLength}
      placeholder={options.placeholder}
      onChange={(event) => setValue(event.target.value)}
    />
  ) : (
    <input
      autoFocus
      value={value}
      maxLength={options.maxLength}
      placeholder={options.placeholder}
      onChange={(event) => setValue(event.target.value)}
    />
  );

  const textPromptDialog = createPortal(
    <div
      className="modal-overlay full-access-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) finish(null);
      }}
    >
      <form
        className="full-access-dialog text-prompt-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!confirmDisabled) finish(value);
        }}
      >
        <div className="full-access-dialog-head">
          <h2 id={titleId} className="full-access-dialog-title">{options.title}</h2>
        </div>
        <label className="text-prompt-field">
          {options.label && <span>{options.label}</span>}
          {field}
        </label>
        {options.description && <p className="text-prompt-description">{options.description}</p>}
        <div className="full-access-dialog-actions">
          <button type="button" className="btn" onClick={() => finish(null)}>取消</button>
          <button type="submit" className="btn primary" disabled={confirmDisabled}>
            {options.confirmLabel ?? "确认"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );

  return { requestText, textPromptDialog, promptOpen: true };
}
