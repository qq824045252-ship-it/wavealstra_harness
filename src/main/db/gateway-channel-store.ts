import type Database from "better-sqlite3";

/** Persisted channel configuration, not the redacted IPC view. */
export interface GatewayChannelRecord {
  id: string;
  type: string;
  name: string;
  configJson: string;
  connected: boolean;
  statusText?: string;
}

export function listGatewayChannels(db: Database.Database): GatewayChannelRecord[] {
  const rows = db.prepare(`SELECT * FROM gateway_channels`).all() as Array<{
    id: string;
    type: string;
    name: string;
    config_json: string;
    connected: number;
    status_text: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    configJson: r.config_json,
    connected: Boolean(r.connected),
    statusText: r.status_text ?? undefined,
  }));
}

export function upsertGatewayChannel(db: Database.Database, channel: GatewayChannelRecord): void {
  db
    .prepare(
      `INSERT INTO gateway_channels (id, type, name, config_json, connected, status_text)
       VALUES (@id, @type, @name, @configJson, @connected, @statusText)
       ON CONFLICT(id) DO UPDATE SET
         type=excluded.type, name=excluded.name, config_json=excluded.config_json,
         connected=excluded.connected, status_text=excluded.status_text`,
    )
    .run({
      id: channel.id,
      type: channel.type,
      name: channel.name,
      configJson: channel.configJson,
      connected: channel.connected ? 1 : 0,
      statusText: channel.statusText ?? null,
    });
}
