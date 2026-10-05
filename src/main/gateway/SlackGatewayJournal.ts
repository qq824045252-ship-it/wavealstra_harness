import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import type { SlackChannelHistory } from "./channels";

export interface SlackDelivery {
  eventId: string;
  appId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  /** Original mention timestamp; optional for older journal entries. */
  messageTs?: string;
  userId: string;
  text: string;
  acceptedAt: number;
  state: "pending" | "running" | "reply_pending" | "replied";
  replyText?: string;
  nextChunk?: number;
  /** Absent on legacy AgentSession receipts; never replay those as new Bot work. */
  backend?: "pi-durable";
  slackHistory?: SlackChannelHistory;
}

export function slackTaskId(delivery: Pick<SlackDelivery, "teamId" | "appId" | "channel" | "threadTs">): string {
  const key = [delivery.teamId, delivery.appId, delivery.channel, delivery.threadTs].join(":");
  return "gw-slack-" + createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export function slackTurnIds(delivery: Pick<SlackDelivery, "teamId" | "appId" | "eventId">): { userMessageId: string; assistantMessageId: string } {
  const hash = createHash("sha256").update([delivery.teamId, delivery.appId, delivery.eventId].join(":")).digest("hex").slice(0, 32);
  return { userMessageId: "slack-user-" + hash, assistantMessageId: "slack-asst-" + hash };
}

/** Credential-free transport journal. Commit before ACK; never replay an uncertain native tool run. */
export class SlackGatewayJournal {
  private entries = new Map<string, SlackDelivery>();
  private loaded = false;
  constructor(private readonly filePath: () => string) {}

  private key(delivery: Pick<SlackDelivery, "teamId" | "appId" | "eventId">): string {
    return [delivery.teamId, delivery.appId, delivery.eventId].join(":");
  }

  private load(): void {
    if (this.loaded) return;
    const path = this.filePath();
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf8")) as { version: number; deliveries: SlackDelivery[] };
      if (data.version !== 1 || !Array.isArray(data.deliveries)) throw new Error("Slack 消息恢复文件格式无效；未启动接收");
      for (const entry of data.deliveries) {
        if (!entry.eventId || !entry.teamId || !entry.appId || !entry.channel || !entry.threadTs || !entry.userId
          || typeof entry.text !== "string" || !["pending", "running", "reply_pending", "replied"].includes(entry.state)) {
          throw new Error("Slack 消息恢复文件损坏；未启动接收");
        }
        this.entries.set(this.key(entry), entry);
      }
    }
    this.loaded = true;
  }

  list(): SlackDelivery[] { this.load(); return [...this.entries.values()].map(entry => ({ ...entry })); }
  get(delivery: Pick<SlackDelivery, "teamId" | "appId" | "eventId">): SlackDelivery | undefined {
    this.load();
    const entry = this.entries.get(this.key(delivery));
    return entry ? { ...entry } : undefined;
  }

  accept(delivery: SlackDelivery): boolean {
    this.load();
    if (this.entries.has(this.key(delivery))) return false;
    this.save(delivery);
    return true;
  }

  update(delivery: SlackDelivery, patch: Partial<Pick<SlackDelivery, "state" | "replyText" | "nextChunk" | "backend" | "slackHistory">>): SlackDelivery {
    const previous = this.get(delivery);
    if (!previous) throw new Error("Slack 消息恢复记录不存在");
    const next = { ...previous, ...patch };
    this.save(next);
    return next;
  }

  private save(delivery: SlackDelivery): void {
    const next = new Map(this.entries);
    next.set(this.key(delivery), { ...delivery });
    // Keep at least 30 days of dedupe receipts; only terminal receipts may age out.
    const expiry = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [key, entry] of next) if (entry.state === "replied" && entry.acceptedAt < expiry) next.delete(key);
    const path = this.filePath();
    mkdirSync(dirname(path), { recursive: true });
    const temporary = path + ".tmp";
    writeFileSync(temporary, JSON.stringify({ version: 1, deliveries: [...next.values()] }), { mode: 0o600 });
    const descriptor = openSync(temporary, "r+");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
    this.entries = next;
  }
}
