import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

/** Small settings primitives; use the same classes as the rest of SettingsModal. */
export function SettingsSection({ title, description, children, collapsible = false, className = "", testId }: {
  title: string;
  description?: string;
  children: ReactNode;
  collapsible?: boolean;
  className?: string;
  testId?: string;
}): React.JSX.Element {
  const heading = <div><h3 className="settings-section-title">{title}</h3>{description && <div className="settings-section-desc">{description}</div>}</div>;
  const card = <div className="settings-section-card">{children}</div>;
  return collapsible ? (
    <details className={`settings-section settings-section-disclosure ${className}`} data-testid={testId}>
      <summary className="settings-section-head">{heading}<span className="settings-disclosure-chevron" aria-hidden="true">⌄</span></summary>
      {card}
    </details>
  ) : (
    <section className={`settings-section ${className}`} data-testid={testId}>
      <div className="settings-section-head">{heading}</div>{card}
    </section>
  );
}

export function SettingsToggle({ on, label, disabled, onChange }: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return <button type="button" className={`switch${on ? " on" : ""}`} aria-label={label} aria-pressed={on} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function SettingsInput({ label, hint, className = "", ...props }: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
}): React.JSX.Element {
  return <label className="settings-field">
    <span className="settings-field-label">{label}</span>
    <input {...props} className={`settings-input full ${className}`} aria-label={props["aria-label"] ?? label} />
    {hint && <span className="settings-field-hint">{hint}</span>}
  </label>;
}

export function SettingsSelect({ label, hint, className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
}): React.JSX.Element {
  return <label className="settings-field">
    <span className="settings-field-label">{label}</span>
    <select {...props} className={`settings-input full ${className}`} aria-label={props["aria-label"] ?? label}>{children}</select>
    {hint && <span className="settings-field-hint">{hint}</span>}
  </label>;
}

export function SettingsSecretField({ label = "API Key", value, clear, configured, disabled, onChange, onClearChange }: {
  label?: string;
  value: string;
  clear?: boolean;
  configured: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  onClearChange: (clear: boolean) => void;
}): React.JSX.Element {
  const hint = clear ? "保存时移除已保存的密钥。" : value ? "已填写，保存后生效。" : configured ? "已保存；留空保留原密钥。" : "粘贴服务提供的 " + label + "。";
  return <div className="settings-secret-field">
    <SettingsInput label={label} type="password" value={value} autoComplete="new-password" spellCheck={false} disabled={disabled || clear} placeholder={configured ? "已保存的密钥不会显示" : "粘贴 " + label} hint={hint} onChange={event => onChange(event.target.value)} />
    {(configured || clear) && <button type="button" className="btn settings-secret-clear" disabled={disabled} onClick={() => onClearChange(!clear)}>{clear ? "撤销移除" : "移除已保存密钥"}</button>}
  </div>;
}
