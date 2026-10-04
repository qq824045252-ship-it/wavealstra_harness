/** Project Template 纯共享层公开 API（禁止 import electron / node 模块） */

export {
  PROJECT_TEMPLATES,
  listProjectTemplates,
  getProjectTemplate,
  isBlankTemplate,
} from "./builtins";
export { resolveProjectTemplate, resolveCapabilityReferences } from "./resolver";
export {
  createDraftFromTemplate,
  applyTemplateToDraft,
  isDraftDirty,
  validateProjectName,
  buildProjectCreationPlan,
  normalizeIdList,
} from "./creation-plan";
export type {
  ProjectTemplateDefinition,
  TemplateCapabilityRegistries,
  ResolvedProjectTemplate,
  ProjectCreationDraft,
} from "./types";
