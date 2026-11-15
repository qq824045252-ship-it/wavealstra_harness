import { modelNativeCapabilitySchema, nativeCapabilityPatch, nativeCapabilityValue } from "@shared/model-native-settings";

export default function NativeCapabilityFields({ model, disabled, onPatch }: {
  model: unknown; disabled: boolean; onPatch: (patch: Record<string, unknown>) => void;
}): React.JSX.Element | null {
  const schema = modelNativeCapabilitySchema(model);
  if (!schema) return null;
  const supported = schema.supported(model);
  return <>
    <div className="models-adv-title">模型原生能力</div>
    <div className="models-modal-sub">{supported ? schema.description : schema.unavailableDescription}</div>
    {schema.fields.map(field => <label className="models-field" key={field.id}>
      {field.kind === "boolean" ? <span className="models-native-option">
        <input type="checkbox" aria-label={field.accessibleName} disabled={disabled || !supported}
          checked={nativeCapabilityValue(model, schema, field) === true}
          onChange={event => onPatch(nativeCapabilityPatch(model, field.id, event.target.checked))} /> {field.label}
      </span> : <>
        <span>{field.label}</span>
        <select aria-label={field.accessibleName} disabled={disabled || !supported}
          value={String(nativeCapabilityValue(model, schema, field))}
          onChange={event => onPatch(nativeCapabilityPatch(model, field.id, event.target.value))}>
          {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </>}
      {field.hint && <small>{field.hint}</small>}
    </label>)}
  </>;
}
