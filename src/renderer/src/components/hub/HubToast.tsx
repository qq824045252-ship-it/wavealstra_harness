type Props = { toast: { kind: "ok" | "err" | "info"; text: string } | null };

export function HubToast({ toast }: Props) {
  if (!toast) return null;
  return (
    <div className={`hub-toast ${toast.kind}`} role="status" aria-live="polite">
      <span className="hub-toast-icon">{toast.kind === "ok" ? "✓" : toast.kind === "err" ? "!" : "i"}</span>
      <span className="hub-toast-text">{toast.text}</span>
    </div>
  );
}
