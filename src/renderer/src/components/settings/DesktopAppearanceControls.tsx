import type { CSSProperties, JSX } from "react";
import {
  DESKTOP_ACCENTS, DESKTOP_PALETTES, normalizeDesktopAppearance,
  type AppTheme, type DesktopAppearance,
} from "@shared/desktop-theme";

export default function DesktopAppearanceControls({ appearance, theme, disabled, onChange }: {
  appearance: DesktopAppearance;
  theme: AppTheme;
  disabled: boolean;
  onChange: (value: Partial<DesktopAppearance>) => void;
}): JSX.Element {
  return (
    <div className="appearance-controls">
      <div className="typography-flat-row">
        <label className="settings-row-label" htmlFor="appearance-mode">应用外观</label>
        <select id="appearance-mode" className="settings-input typography-value-select" value={appearance.mode} disabled={disabled}
          onChange={(event) => onChange({ mode: normalizeDesktopAppearance({ mode: event.target.value }).mode })}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <fieldset className="appearance-palette-group" disabled={disabled}>
        <legend className="settings-row-label">配色主题</legend>
        <div className="appearance-palette-options">
          {DESKTOP_PALETTES.map(({ id, label, ...previews }) => {
            const preview = previews[theme];
            return (
              <label className="appearance-palette-option" key={id}>
                <input type="radio" name="desktop-palette" value={id} checked={appearance.palette === id}
                  onChange={() => onChange({ palette: id })} />
                <span className="appearance-palette-swatch" aria-hidden="true" style={{
                  "--sample-bg": preview.background,
                  "--sample-fg": preview.foreground,
                  "--sample-accent": preview.sample,
                } as CSSProperties} />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="typography-flat-row">
        <label className="settings-row-label" htmlFor="appearance-accent">强调色</label>
        <select id="appearance-accent" className="settings-input typography-value-select" value={appearance.accent} disabled={disabled}
          onChange={(event) => onChange({ accent: normalizeDesktopAppearance({ accent: event.target.value }).accent })}>
          {DESKTOP_ACCENTS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>
    </div>
  );
}
