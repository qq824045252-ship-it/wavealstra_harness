import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationService, type BotConversationServiceOptions } from "../src/main/agent/work/BotConversationService";
import type { GatewayBotTurnRequest } from "../src/main/gateway/GatewayAgentTurn";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import type { BotSettingsDto } from "../src/shared/bot-settings";

/** Isolated real foreground admission/runtime. Only the provider and fixture tools are supplied. */
export function createGatewayBotFixture(input: { db: AppDatabase; models: ModelRuntime; root: string;
  tools?: ToolRegistration[] | (() => Promise<ToolRegistration[]>); botId?: string; authority?: () => boolean;
  deliverPeerReturn?: BotConversationServiceOptions["deliverPeerReturn"] }) {
  const bots = new BotRegistry(input.db.connection);
  const botId = input.botId ?? "gateway-fixture-bot";
  if (!bots.getBot(botId)) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: "Gateway fixture",
    authorization: DESKTOP_USER_GRANTS });
  const works = new WorkService(input.db.connection, { bots });
  const directory = join(input.root, "bot-conversations");
  mkdirSync(directory, { recursive: true });
  const settings: BotSettingsDto = { botId, revision: 0, workspacePath: "", effectiveWorkspacePath: directory,
    spaceId: "fixture-space", modelId: "fixture/native", expertId: "", skillIds: [], mcpIds: [], connectorIds: [] };
  const botConversations = new BotConversationService({ db: input.db.connection, userId: LOCAL_USER_ID,
    bots, works, models: input.models, directory, defaultModel: () => "fixture/native",
    isAuthority: input.authority ?? (() => true), memorySearch: () => [], schedule: () => {}, wake: () => {},
    deliverPeerReturn: input.deliverPeerReturn,
    messageSettings: () => ({ settings, profile: bots.activeSnapshot(botId)! }),
    composerTools: async () => ({ tools: typeof input.tools === "function" ? await input.tools() : input.tools ?? [],
      instructions: "", close: async () => {} }),
  });
  const runGatewayTurn = async (request: GatewayBotTurnRequest) => {
    const receipt = botConversations.acceptGateway({ botId, requestId: `gateway:${request.userMessageId}`,
      text: request.displayText ?? request.text, attachments: request.attachments, origin: request.gatewayOrigin,
      referenceContext: request.displayText !== undefined && request.displayText !== request.text ? request.text : undefined });
    return botConversations.awaitReply(receipt);
  };
  botConversations.recover();
  return { botConversations, bots, works, botId, runGatewayTurn, close: () => botConversations.close() };
}
