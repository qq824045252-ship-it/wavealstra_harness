import { z } from "zod";
export interface BotDisplayGroup { id: string; name: string; collapsed: boolean }
export interface BotDisplayGroups { groups: BotDisplayGroup[]; membership: Record<string, string> }
export const botDisplayGroupCommand = z.discriminatedUnion('kind', [
 z.object({kind:z.literal('list')}),
 z.object({kind:z.literal('create'),name:z.string().trim().min(1).max(60),botId:z.string().optional()}),
 z.object({kind:z.literal('rename'),id:z.string(),name:z.string().trim().min(1).max(60)}),
 z.object({kind:z.literal('delete'),id:z.string()}),
 z.object({kind:z.literal('collapse'),id:z.string(),collapsed:z.boolean()}),
 z.object({kind:z.literal('move'),botId:z.string(),groupId:z.string().nullable()}),
]);
export type BotDisplayGroupCommand = z.infer<typeof botDisplayGroupCommand>;
