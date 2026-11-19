export type PstackValue = string | number | boolean;

export interface PstackParameter {
  id: string;
  label: string;
  description: string;
  type: "boolean" | "number" | "text" | "select";
  defaultValue: PstackValue;
  min?: number;
  max?: number;
  options?: string[];
  multiline?: boolean;
}

export interface PstackSkill {
  id: string;
  label: string;
  kind: "method" | "principle" | "review";
  description: string;
  instructions: string;
  parameters: PstackParameter[];
  roleIds: string[];
  stages?: PstackStage[];
}

export interface PstackStage {
  id: string;
  label: string;
  instructions: string;
  skillIds: string[];
  roleId?: string;
}

export interface PstackPlaybook {
  id: string;
  label: string;
  description: string;
  parameters: PstackParameter[];
  stages: PstackStage[];
}

export interface PstackEntrySettings {
  enabled: boolean;
  parameters: Record<string, PstackValue>;
}

export interface PstackRoleSettings {
  model: string;
  count: number;
  effort: string;
  isolation: "auto" | "shared" | "worktree";
}

export interface PstackSettings {
  skills: Record<string, PstackEntrySettings>;
  playbooks: Record<string, PstackEntrySettings>;
  roles: Record<string, PstackRoleSettings>;
  thermos: {
    changedLines: number;
    fileLines: number;
    specialCases: number;
    onRequest: boolean;
    beforeMerge: boolean;
    reviewerRole: string;
    criteria: Record<string, boolean>;
  };
}
