import {
  normalizeBlueprintDefinition,
  type BlueprintDefinition,
} from "../../shared/blueprint-types";

/** Current-only definition gate. Historical Blueprint JSON is intentionally unsupported. */
export function migrateBlueprintDefinition(value: unknown): BlueprintDefinition {
  return normalizeBlueprintDefinition(value);
}
