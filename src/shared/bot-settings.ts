import { z } from "zod";
const ids = z.array(z.string().trim().min(1).max(240)).max(100);
export const botSettingsSchema = z.object({
  botId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  workspacePath: z.string().trim().max(4096), modelId: z.string().trim().max(500),
  expertId: z.string().trim().max(240), skillIds: ids, mcpIds: ids, connectorIds: ids,
}).strict();
export type BotSettingsSaveRequest = z.infer<typeof botSettingsSchema>;
export interface BotSettingsDto extends Omit<BotSettingsSaveRequest, "expectedRevision"> {
  revision: number; spaceId: string; effectiveWorkspacePath: string;
}
export interface BotSettingsChoice { id: string; name: string; available: boolean; }
export interface BotSettingsView {
  settings: BotSettingsDto;
  models: BotSettingsChoice[]; experts: BotSettingsChoice[]; skills: BotSettingsChoice[];
  mcps: BotSettingsChoice[]; connectors: BotSettingsChoice[];
}
export type BotSettingsResult = { ok: true; view: BotSettingsView } | { ok: false; message: string };
