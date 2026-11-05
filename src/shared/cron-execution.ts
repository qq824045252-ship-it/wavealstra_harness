import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const CronExecutionSchema = Type.Object({
  sourceTaskId: Type.Optional(Type.String({ minLength: 1 })),
  target: Type.Optional(Type.Union([
    Type.Object({ kind: Type.Literal("new-task") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("task"), taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  ])),
  maxRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  restartPolicy: Type.Optional(Type.Union([Type.Literal("resume"), Type.Literal("pause")])),
}, { additionalProperties: false });

export type CronExecutionSettings = Static<typeof CronExecutionSchema>;

export function parseCronExecution(value: unknown): CronExecutionSettings {
  if (!Check(CronExecutionSchema, value)) throw new Error("Invalid automation execution settings");
  return value;
}
