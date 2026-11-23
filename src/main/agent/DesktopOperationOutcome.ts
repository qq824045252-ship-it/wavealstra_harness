import { z } from "zod";

/** The operation verdict and the evidence about delivery answer different questions. */
const desktopOperationOutcomeSchema = z.object({
  status: z.enum(["failed", "inconclusive"]),
  sideEffects: z.enum(["none", "known", "unknown"]),
  causeCode: z.string(),
});

export type DesktopOperationOutcome = z.infer<typeof desktopOperationOutcomeSchema>;

const desktopDetailsSchema = z.object({ desktopOutcome: desktopOperationOutcomeSchema });

export function readDesktopOperationOutcome(details: unknown): DesktopOperationOutcome | undefined {
  return desktopDetailsSchema.safeParse(details).data?.desktopOutcome;
}
