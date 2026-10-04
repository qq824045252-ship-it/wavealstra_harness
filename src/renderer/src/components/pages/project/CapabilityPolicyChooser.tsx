interface CapabilityOption {
  id: string;
  name: string;
  description?: string;
}

export default function CapabilityPolicyChooser<State extends string>({
  label,
  options,
  states,
  getState,
  onStateChange,
}: {
  label: string;
  options: CapabilityOption[];
  states: ReadonlyArray<{ value: State; label: string }>;
  getState: (id: string) => State;
  onStateChange: (id: string, state: State) => void;
}): React.JSX.Element {
  return (
    <div className="new-project-field">
      <div className="new-project-label-row">
        <span className="new-project-label">{label}</span>
        <span className="new-project-cap-optional">候选能力 · 最终仍受 Mode / Tag 裁决</span>
      </div>
      <div className="project-cap-options">
        {options.map((option) => {
          const state = getState(option.id);
          return (
            <label key={option.id} className={`project-cap-option ${state !== "inherit" ? "active" : ""}`} title={option.description}>
              <span className="project-cap-name">{option.name}</span>
              <select
                className={`project-cap-state state-${state}`}
                value={state}
                aria-label={`${option.name} 策略`}
                onChange={(event) => onStateChange(option.id, event.target.value as State)}
              >
                {states.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
          );
        })}
        {options.length === 0 && <span className="project-cap-empty">暂无可用项</span>}
      </div>
    </div>
  );
}
