import { botAvatarCommandSchema, type BotAvatarResult } from "../../../shared/bot-avatar";
import { isMainAppWindowRequest } from "../../AppWindowIpc";
import type { BotAvatarService } from "./BotAvatarService";

type Event = Parameters<typeof isMainAppWindowRequest>[0];
export function createBotAvatarIpcHandler(options: {
  service: BotAvatarService;
  getWindow: () => Parameters<typeof isMainAppWindowRequest>[1];
  rendererUrl: string;
  pick: () => Promise<string | undefined>;
  normalize: (bytes: Buffer) => Buffer | Promise<Buffer>;
}) {
  return async (event: Event, request: unknown): Promise<BotAvatarResult> => {
    const authorize = () => { if (!isMainAppWindowRequest(event,options.getWindow(),options.rendererUrl)) throw new Error("只能从应用主窗口管理头像"); };
    try {
      authorize();
      const input = botAvatarCommandSchema.parse(request), service = options.service;
      if (input.kind === "list") return {ok:true,snapshot:service.snapshot()};
      if (input.kind === "read") return {ok:true,snapshot:service.snapshot(),image:service.read(input.assetId,input.variant)};
      if (input.kind === "set") return {ok:true,snapshot:service.set(input.botId,input.assetId,input.expectedRevision)};
      if (input.kind === "remove") return {ok:true,snapshot:service.remove(input.assetId)};
      if (input.kind === "motion") return {ok:true,snapshot:service.motion(input.enabled)};
      const path = await options.pick();
      authorize();
      if (!path) return {ok:true,snapshot:service.snapshot(),cancelled:true};
      const importedId = await service.importSelected(path,options.normalize,authorize);
      return {ok:true,snapshot:service.snapshot(),importedId};
    } catch (error) { return {ok:false,message:error instanceof Error ? error.message : "头像操作失败"}; }
  };
}
