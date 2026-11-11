import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const CronExecutionSchema = Type.Object({
  reminder: Type.Optional(Type.Object({
    state: Type.Optional(Type.Union([Type.Literal("scheduled"), Type.Literal("paused"), Type.Literal("cancelled"), Type.Literal("delivered")])),
    kind: Type.Literal("bot-reminder"), userId: Type.String({ minLength: 1 }),
    botId: Type.String({ minLength: 1 }), conversationId: Type.String({ minLength: 1 }),
    result: Type.Optional(Type.Object({ workId: Type.String({ minLength: 1, maxLength: 2000 }),
      fileRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 20 })),
    }, { additionalProperties: false })),
    teamId: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false })),
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
