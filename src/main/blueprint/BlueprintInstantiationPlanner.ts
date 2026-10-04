import type {
  BlueprintGadgetDefinition,
  BlueprintInstantiationPlan,
  ResolvedBlueprint,
  WorkspaceBlueprintNode,
} from "../../shared/blueprint-types";

export class BlueprintInstantiationPlanner {
  build(resolved: ResolvedBlueprint): BlueprintInstantiationPlan {
    const plan: BlueprintInstantiationPlan = {
      kind: resolved.definition.kind,
      workspaces: [],
      tasks: [],
      files: [],
      libraryBindings: [],
      gadgets: [],
      missing: resolved.missing,
      warnings: [...resolved.warnings],
    };
    const visit = (node: WorkspaceBlueprintNode, parentKey?: string): void => {
      plan.workspaces.push({
        key: node.key,
        name: node.name,
        ...(parentKey ? { parentKey } : {}),
        ...(node.defaultContext ? { defaultContext: node.defaultContext } : {}),
      });
      for (const task of node.tasks ?? []) plan.tasks.push({ ...task, workspaceKey: node.key });
      for (const file of node.files ?? []) plan.files.push({ ...file, workspaceKey: node.key });
      for (const binding of node.libraryBindings ?? []) plan.libraryBindings.push({ ...binding, workspaceKey: node.key });
      for (const gadget of node.gadgets ?? []) {
        plan.gadgets.push({ ...gadget, workspaceKey: node.key, targetScopeType: gadget.scopeType ?? "workspace" });
      }
      for (const child of node.children ?? []) visit(child, node.key);
    };
    const definition = resolved.definition;
    if (definition.kind === "workspace") visit(definition.workspace);
    if (definition.kind === "gadget") {
      plan.gadgets.push({ ...definition.gadget, targetScopeType: definition.gadget.scopeType ?? "global" });
    }
    if (definition.kind === "composite") {
      if (definition.workspace) visit(definition.workspace);
      for (const gadget of definition.gadgets ?? []) {
        plan.gadgets.push({ ...gadget, targetScopeType: gadget.scopeType ?? (gadget.workspaceKey ? "workspace" : gadget.taskKey ? "task" : "global") });
      }
    }
    this.validateReferences(plan);
    return plan;
  }

  private validateReferences(plan: BlueprintInstantiationPlan): void {
    const workspaceKeys = new Set(plan.workspaces.map((item) => item.key));
    const taskKeys = new Set(plan.tasks.map((item) => item.key));
    for (const task of plan.tasks) if (!workspaceKeys.has(task.workspaceKey)) throw new Error(`Blueprint task 引用未知 workspace key：${task.workspaceKey}`);
    for (const file of plan.files) if (!workspaceKeys.has(file.workspaceKey)) throw new Error(`Blueprint file 引用未知 workspace key：${file.workspaceKey}`);
    for (const binding of plan.libraryBindings) if (!workspaceKeys.has(binding.workspaceKey)) throw new Error(`Blueprint binding 引用未知 workspace key：${binding.workspaceKey}`);
    for (const gadget of plan.gadgets) {
      if (gadget.targetScopeType === "workspace" && (!gadget.workspaceKey || !workspaceKeys.has(gadget.workspaceKey))) {
        throw new Error(`Blueprint Gadget ${gadget.key} 缺少有效 workspaceKey`);
      }
      if (gadget.targetScopeType === "task" && (!gadget.taskKey || !taskKeys.has(gadget.taskKey))) {
        throw new Error(`Blueprint Gadget ${gadget.key} 缺少有效 taskKey`);
      }
    }
  }
}
