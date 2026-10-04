import type { BlueprintDefinition, ResolvedBlueprint } from "../../shared/blueprint-types";
import type { TemplateCapabilityRegistries } from "../../shared/project-template/types";
import { resolveCapabilityReferences } from "../../shared/project-template/resolver";
import { migrateBlueprintDefinition } from "./BlueprintDefinitionMigrator";

export class BlueprintResolver {
  resolve(value: BlueprintDefinition | unknown, registries?: TemplateCapabilityRegistries): ResolvedBlueprint {
    const definition = migrateBlueprintDefinition(value);
    const capabilities = resolveCapabilityReferences(definition.capabilities ?? {}, registries);
    return {
      definition,
      resolved: capabilities.resolved,
      missing: capabilities.missing,
      warnings: capabilities.warnings,
    };
  }
}
