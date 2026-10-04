import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@/types";
import type {
  GatewayEventDto,
  GatewayMessageDto,
  GatewayStatusDto,
} from "../../../../shared/agent-ipc";
import MessageItem from "@/components/chat/MessageItem";
import { useAppStore } from "@/store/appStore";
import { IconClock, IconMore, IconSearch, IconShare } from "@/components/common/icons";

const CHANNEL_LABEL: Record<string, string> = {
  "feishu-default": "飞书",
  "wecom-default": "企微",
  "wechat-default": "微信",
  "telegram-default": "Telegram",
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
    id: `gw-${ev.channelId}-${ev.chatId}-${ev.direction}-${ev.at}`,
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
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<GatewayStatusDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 初始加载：历史消息落库回放（重启不丢）
  useEffect(() => {
    let alive = true;
    void window.api?.gateway
      ?.listMessages({ limit: 300 })
      .then((history) => {
        if (!alive) return;
        const map = new Map<string, Conversation>();
        const byChat = new Map<string, GatewayMessageDto[]>();
        for (const m of history) {
          const key = `${m.channelId}:${m.chatId}`;
          const list = byChat.get(key) ?? [];
          list.push(m);
          byChat.set(key, list);
        }
        for (const [key, list] of byChat) {
          const last = list[list.length - 1];
          map.set(key, {
            key,
            channelId: last.channelId,
            chatId: last.chatId,
            title: last.senderName ?? (last.channelId === "system" ? "系统" : last.chatId),
            lastText: last.text.slice(0, 40),
            at: last.at,
            unread: 0,
          });
        }
        const convs = [...map.values()].sort((a, b) => b.at - a.at);
        setConversations(convs);
        if (convs.length > 0 && !activeKey) {
          const first = convs[0];
          setActiveKey(first.key);
          setMessages(byChat.get(first.key)?.map(messageToChatMessage) ?? []);
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => {
    void window.api?.gateway?.status().then(setStatus);
    return window.api?.gateway?.onEvent((ev) => {
      const key = `${ev.channelId}:${ev.chatId ?? ""}`;
      setConversations((list) => {
        const title =
          ev.senderName ??
          (ev.channelId === "system" ? "系统" : (ev.chatId ?? ev.channelId));
        const existing = list.find((c) => c.key === key);
        if (existing) {
          return list.map((c) =>
            c.key === key
              ? {
                  ...c,
                  title,
                  lastText: ev.text.slice(0, 40),
                  at: ev.at,
                  unread: c.key === activeKey ? 0 : c.unread + 1,
                }
              : c,
          );
        }
        return [
          ...list,
          { key, channelId: ev.channelId, chatId: ev.chatId ?? "", title, lastText: ev.text.slice(0, 40), at: ev.at, unread: 0 },
        ];
      });
      if (key === activeKey) {
        setMessages((list) => [...list, messageToChatMessage(ev)]);
      }
      void window.api?.gateway?.status().then(setStatus);
    });
  }, [activeKey]);

  const selectConversation = (key: string): void => {
    setActiveKey(key);
    setConversations((list) =>
      list.map((c) => (c.key === key ? { ...c, unread: 0 } : c)),
    );
    const sep = key.indexOf(":");
    const channelId = key.slice(0, sep);
    const chatId = key.slice(sep + 1);
    void window.api
      ?.gateway?.listMessages({ channelId, chatId: chatId === "" ? undefined : chatId, limit: 200 })
      .then((history) => setMessages(history.map(messageToChatMessage)));
  };

  const connected = status?.channels.some((c) => c.connected) ?? false;
  const hint = connected
    ? status?.channels
        .filter((c) => c.connected)
        .map((c) => `${c.name}已连接`)
        .join(" · ")
    : "未连接";

  const activeConv = useMemo(
    () => conversations.find((c) => c.key === activeKey) ?? null,
    [conversations, activeKey],
  );

  return (
    <div className="content-col">
      <div className="chat-header">
        <div className="chat-header-title">本地助理</div>
        <span className="assistant-conn-hint">
          {hint}
          {" · "}
          <button className="link-btn" onClick={() => setSettingsOpen(true, "assistant")}>
            配置
          </button>
        </span>
        <div className="chat-header-sub" />
        <button className="icon-btn" title="搜索">
          <IconSearch size={15} />
        </button>
        <button className="icon-btn" title="分享">
          <IconShare size={15} />
        </button>
        <button className="icon-btn" title="历史提问">
          <IconClock size={15} />
        </button>
        <button className="icon-btn" title="更多">
          <IconMore size={15} />
        </button>
      </div>

      <div className="assistant-body">
        <div className="assistant-conv-list">
          {!loaded && <div className="assistant-conv-empty">加载中…</div>}
          {loaded && conversations.length === 0 && (
            <div className="assistant-conv-empty">
              暂无会话。在「助理设置」连接 Telegram / 飞书 / 企微 / 微信后，
              从 IM 发消息即可在这里看到。
            </div>
          )}
          {conversations.map((c) => (
            <button
              key={c.key}
              className={`assistant-conv-item ${c.key === activeKey ? "active" : ""}`}
              onClick={() => selectConversation(c.key)}
            >
              <div className="assistant-conv-row">
                <span className={`assistant-conv-badge ch-${c.channelId.split("-")[0]}`}>
                  {CHANNEL_LABEL[c.channelId] ?? c.channelId}
                </span>
                <span className="assistant-conv-title">{c.title}</span>
                {c.unread > 0 && <span className="assistant-conv-unread">{c.unread}</span>}
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
            {messages.map((msg) => (
              <MessageItem key={msg.id} message={msg} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
