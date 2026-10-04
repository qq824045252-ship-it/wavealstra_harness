type Tone = "positive" | "attention" | "neutral" | "error";

export function HubStatusBadge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  return (
    <span className={`hub-status hub-status--${tone}`}>
      <span className="hub-status-dot" />{label}
    </span>
  );
}
