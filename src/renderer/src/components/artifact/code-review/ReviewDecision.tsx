import { IconCheck, IconCircleCheck, IconCopy, IconRotate, IconX } from "@/components/common/icons";

interface DecisionButtonProps {
  action: "accept" | "reject";
  label: string;
  title?: string;
  variant?: "batch" | "confirm";
  disabled?: boolean;
  onClick: () => void;
}

export function ReviewDecisionButton({
  action, label, title = label, variant, disabled, onClick,
}: DecisionButtonProps): React.JSX.Element {
  const Icon = action === "accept" ? IconCheck : variant === "confirm" ? IconRotate : IconX;
  const hint = variant ? label : action === "accept" ? "接受" : "拒绝";
  return <button type="button" className={`code-review-decision is-${action}${variant === "confirm" ? " is-confirm" : ""}`}
    aria-label={label} title={title} data-hint={hint} disabled={disabled} onClick={onClick}>
    {variant === "batch" ? <span className="code-review-batch-glyph" aria-hidden="true">
      <IconCopy size={16} />
      <Icon size={11} strokeWidth={2.1} className="code-review-batch-mark" />
    </span> : <Icon size={16} strokeWidth={2} />}
  </button>;
}

export function ReviewDecisionStatus({ status }: { status: "accepted" | "rejected" }): React.JSX.Element {
  const label = status === "accepted" ? "已接受" : "已拒绝";
  return <span className={`code-review-decision-status is-${status}`} role="img" aria-label={label} title={label}>
    {status === "accepted" ? <IconCircleCheck size={13} /> : <IconX size={9} />}
  </span>;
}
