import type { z } from "zod";
import type { workExecutionObservationSchema } from "../../../shared/bot-work-phase3";

/** Persisted native execution observations shared by Goal and historical Work projections. */
export type WorkExecutionObservation = z.infer<typeof workExecutionObservationSchema>;
