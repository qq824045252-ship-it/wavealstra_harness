import type Database from "better-sqlite3";

/** Read-only presentation association. In particular, never link a peer return
 * to the user's control-target or delivery-origin columns. Source replies and
 * both ends of authenticated peer turns use the same immutable Work identity. */
export function delegatedReplyWorkIds(db: Pick<Database.Database, "prepare">, userId: string, messageId: string): string[] {
  const rows = db.prepare(`
    SELECT c.work_id FROM bot_messages m
      JOIN bot_send_receipts r ON r.assistant_message_id=m.message_id AND r.bot_id=m.bot_id
        AND r.request_id=m.request_id AND r.conversation_id=m.conversation_id
      JOIN bot_conversations v ON v.conversation_id=m.conversation_id AND v.user_id=r.user_id AND v.bot_id=m.bot_id
      JOIN bot_collaboration_requests q ON q.assistant_message_id=r.assistant_message_id
        AND q.user_message_id=r.user_message_id AND q.request_id=r.request_id AND q.conversation_id=r.conversation_id
      JOIN bot_collaborations c ON c.collaboration_id=q.collaboration_id AND c.user_id=r.user_id AND c.source_bot_id=m.bot_id
        AND c.source_conversation_id=r.conversation_id
        AND json_extract(c.value_json,'$.sourceRequestId')=r.request_id
        AND json_extract(c.value_json,'$.sourceUserMessageId')=r.user_message_id
        AND json_extract(c.value_json,'$.sourceAssistantMessageId')=r.assistant_message_id
      JOIN works w ON w.work_id=c.work_id AND w.user_id=c.user_id
    WHERE m.message_id=? AND m.role='assistant' AND r.user_id=? AND v.team_id IS NULL
    UNION
    SELECT c.work_id FROM bot_messages m
      JOIN bot_send_receipts r ON r.assistant_message_id=m.message_id AND r.bot_id=m.bot_id
        AND r.request_id=m.request_id AND r.conversation_id=m.conversation_id
      JOIN bot_conversations v ON v.conversation_id=m.conversation_id AND v.user_id=r.user_id AND v.bot_id=m.bot_id
      JOIN bot_peer_inputs p ON p.assistant_message_id=r.assistant_message_id AND p.user_message_id=r.user_message_id
      JOIN bot_peer_deliveries d ON d.accepted_message_id=m.message_id AND d.user_id=r.user_id
        AND d.target_bot_id=r.bot_id AND d.request_id=r.request_id
        AND d.operation_id=json_extract(p.origin_json,'$.exchangeId') AND d.origin_json=p.origin_json
      JOIN bot_collaborations c ON c.collaboration_id=json_extract(p.origin_json,'$.collaborationId') AND c.user_id=r.user_id
      JOIN works w ON w.work_id=c.work_id AND w.user_id=c.user_id
      JOIN bot_collaboration_requests q ON q.collaboration_id=c.collaboration_id
        AND q.assistant_message_id=json_extract(p.origin_json,'$.sourceAssistantMessageId')
        AND q.user_message_id=json_extract(p.origin_json,'$.sourceUserMessageId')
        AND q.request_id=json_extract(p.origin_json,'$.sourceRequestId')
        AND q.conversation_id=json_extract(p.origin_json,'$.sourceConversationId')
      JOIN bot_send_receipts s ON s.user_id=c.user_id AND s.bot_id=c.source_bot_id
        AND s.conversation_id=q.conversation_id AND s.request_id=q.request_id
        AND s.user_message_id=q.user_message_id AND s.assistant_message_id=q.assistant_message_id
    WHERE m.message_id=? AND m.role='assistant' AND r.user_id=? AND v.team_id IS NULL
      AND json_extract(p.origin_json,'$.sourceBotId')=c.source_bot_id
      AND ((json_extract(p.origin_json,'$.kind')='return' AND m.bot_id=c.source_bot_id
        AND m.conversation_id=q.conversation_id AND json_extract(p.origin_json,'$.senderBotId')=c.target_bot_id)
        OR (json_extract(p.origin_json,'$.kind')='request' AND m.bot_id=c.target_bot_id
        AND json_extract(p.origin_json,'$.senderBotId')=c.source_bot_id))
    ORDER BY 1`).all(messageId, userId, messageId, userId) as Array<{ work_id: string }>;
  return rows.map(row => row.work_id);
}
