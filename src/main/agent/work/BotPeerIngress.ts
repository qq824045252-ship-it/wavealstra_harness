import type Database from "better-sqlite3";
import { z } from "zod";
import { botPeerOriginSchema, type BotPeerOrigin } from "../../../shared/bot-peer-origin";

/** Read-only provenance for historical peer messages. */
export class BotPeerIngress {
  constructor(private readonly db: Database.Database) {}
  origin(messageId: string): BotPeerOrigin | undefined {
    const row = z.object({ origin_json: z.string() }).optional().parse(this.db.prepare(
      "SELECT origin_json FROM bot_peer_inputs WHERE user_message_id=? OR assistant_message_id=?").get(messageId, messageId));
    return row ? botPeerOriginSchema.parse(JSON.parse(row.origin_json)) : undefined;
  }

}
