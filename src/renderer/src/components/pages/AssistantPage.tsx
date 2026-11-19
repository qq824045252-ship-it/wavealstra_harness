import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/types";
import type {
  GatewayEventDto,
  GatewayMessageDto,
  GatewayStatusDto,
} from "../../../../shared/agent-ipc";
import MessageItem from "@/components/chat/MessageItem";
import { useAppStore } from "@/store/appStore";
import { gatewayRecordKey, gatewayRecordStatus, mergeGatewayRecords, type GatewayRecord } from "@/lib/gatewayPresentation";

const CHANNEL_LABEL: Record<string, string> = {
  "feishu-default": "飞书",
  "wecom-default": "企微",
  "wechat-default": "微信",
  "telegram-default": "Telegram",
  "slack-default": "Slack",
  "dingtalk-default": "钉钉",
  "discord-default": "Discord",
  "qq-default": "QQ",
  "weixin-default": "微信扫码",
  system: "系统",
};

interface Conversation {
  key: string; // `${channelId}:${chatId}`
  channelId: string;
  chatId: string;
  title: string;
  lastText: string;
  at: number;
  unread: number;
}

function messageToChatMessage(ev: GatewayEventDto | GatewayMessageDto): ChatMessage {
  const role = ev.direction === "in" ? "user" : "assistant";
  const text =
    ev.direction === "system"
      ? `[系统] ${ev.text}`
      : `${ev.senderName ?? ""}${ev.senderName ? "：" : ""}${ev.text}`;
  return {
    // direction 参与 id：同毫秒的 in/out 不冲突
    id: gatewayRecordKey(ev),
    role,
    createdAt: ev.at,
    // user 气泡读 blocks、assistant 读 finalBlocks，两处都要填
    blocks: [{ type: "text", text }],
    finalBlocks: [{ type: "text", text }],
  };
}

/** 助理页：IM Gateway 消息镜像（按会话分组，历史落库可查） */
export default function AssistantPage(): React.JSX.Element {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [records, setRecords] = useState<GatewayRecord[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const selectedRef = useRef<string | null>(null);
  const [status, setStatus] = useState<GatewayStatusDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const statusEpoch = useRef(0);
  const conversations = useMemo(() => {
    const map = new Map<string, Conversation>();
    for (const record of records) {
      const key = `${record.channelId}:${record.chatId ?? ""}`;
      map.set(key, { key, channelId: record.channelId, chatId: record.chatId ?? "",
        title: record.senderName ?? record.chatId ?? record.channelId,
        lastText: record.text.slice(0, 40), at: record.at, unread: 0 });
    }
    return [...map.values()].sort((a, b) => b.at - a.at);
  }, [records]);
  const selectedKey = activeKey ?? conversations[0]?.key ?? null;
  selectedRef.current = selectedKey;
  const messages = useMemo(() => records.filter(record =>
    `${record.channelId}:${record.chatId ?? ""}` === selectedKey), [records, selectedKey]);

  useEffect(() => {
    let alive = true;
    const refreshStatus = async () => {
      const epoch = ++statusEpoch.current;
      try {
        const next = await window.api?.gateway?.status();
        if (alive && epoch === statusEpoch.current) setStatus(next ?? null);
      } catch { if (alive && epoch === statusEpoch.current) setStatus(null); }
    };
    void window.api?.gateway?.listMessages({ limit: 300 }).then(history => {
      if (alive) { setRecords(current => mergeGatewayRecords(history, current)); setLoaded(true); }
    }).catch(() => { if (alive) { setLoadError("消息记录加载失败，请重新打开本地助理重试。"); setLoaded(true); } });
    const unsubscribe = window.api?.gateway?.onEvent(event => {
      if (!alive) return;
      const key = `${event.channelId}:${event.chatId ?? ""}`;
      if (selectedRef.current && key !== selectedRef.current) setUnread(current => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
      setRecords(current => mergeGatewayRecords(current, [event]));
      void refreshStatus();
    });
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 5000);
    return () => { alive = false; statusEpoch.current++; unsubscribe?.(); clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!selectedKey) return;
    setActiveKey(current => current ?? selectedKey);
    setUnread(current => current[selectedKey] ? { ...current, [selectedKey]: 0 } : current);
    let alive = true;
    const sep = selectedKey.indexOf(":");
    void window.api?.gateway?.listMessages({ channelId: selectedKey.slice(0, sep),
      chatId: selectedKey.slice(sep + 1), limit: 200 }).then(history => {
        // A late response may add records, but must never select or overwrite another conversation.
        if (alive) { setRecords(current => mergeGatewayRecords(history, current)); setLoadError(""); }
      }).catch(() => { if (alive) setLoadError("会话记录加载失败，已收到的消息仍保留。"); });
    return () => { alive = false; };
  }, [selectedKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }, [selectedKey, messages.length]);

  const connected = status?.channels.some((c) => c.connected) ?? false;
  const hint = connected
    ? status?.channels
        .filter((c) => c.connected)
        .map((c) => `${c.name}已连接`)
        .join(" · ")
    : status ? "未连接" : "连接状态未知";

  const activeConv = useMemo(
    () => conversations.find((c) => c.key === selectedKey) ?? null,
    [conversations, selectedKey],
  );

  return (
    <div className="content-col">
      <div className="chat-header">
        <div className="chat-header-title">本地助理</div>
        <span className="assistant-conn-hint">
          {hint}（仅连接状态）
          {" · "}
          <button className="link-btn" onClick={() => setSettingsOpen(true, "assistant")}>
            配置
          </button>
        </span>
        <div className="chat-header-sub" />
      </div>

      {loadError && <div role="alert">{loadError}</div>}
      <div className="assistant-body">
        <div className="assistant-conv-list">
          {!loaded && <div className="assistant-conv-empty">加载中…</div>}
          {loaded && conversations.length === 0 && (
            <div className="assistant-conv-empty">
              暂无会话。在「助理设置」连接所需渠道后，
              从 IM 发消息即可在这里看到。
            </div>
          )}
          {conversations.map((c) => (
            <button
              key={c.key}
              className={`assistant-conv-item ${c.key === selectedKey ? "active" : ""}`}
              onClick={() => setActiveKey(c.key)}
            >
              <div className="assistant-conv-row">
                <span className={`assistant-conv-badge ch-${c.channelId.split("-")[0]}`}>
                  {CHANNEL_LABEL[c.channelId] ?? c.channelId}
                </span>
                <span className="assistant-conv-title">{c.title}</span>
                {(unread[c.key] ?? 0) > 0 && <span className="assistant-conv-unread">{unread[c.key]}</span>}
              </div>
              <div className="assistant-conv-preview">{c.lastText}</div>
              <div className="assistant-conv-time">
                {new Date(c.at).toLocaleString("zh-CN", { hour12: false })}
              </div>
            </button>
          ))}
        </div>

        <div className="message-scroll" ref={scrollRef}>
          <div className="message-list">
            {!activeConv && loaded && (
              <div className="assistant-conv-empty" style={{ padding: 24 }}>
                选择左侧会话查看消息。
              </div>
            )}
            {activeConv && (
              <div className="assistant-conv-header">
                {CHANNEL_LABEL[activeConv.channelId] ?? activeConv.channelId} · {activeConv.title}
              </div>
            )}
            {messages.map((record) => (
              <MessageItem key={gatewayRecordKey(record)} message={messageToChatMessage(record)} btw gatewayStatus={gatewayRecordStatus(record)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
