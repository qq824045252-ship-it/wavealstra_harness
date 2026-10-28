import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconGlobe, IconLink, IconRefresh, IconShield } from "@/components/common/icons";
import type { RemoteDeviceSummary, RemotePairWindowDto, RemoteStatus } from "@shared/remote-access";

function RemoteToggle({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      aria-label={on ? "关闭远程访问" : "启用远程访问"}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    />
  );
}

function formatLastSeen(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

/**
 * 远程连接设置（与 Android 端同一套模型）：
 * 手机端只做两件事——填「连接地址」+ 填电脑端现给的 6 位配对码。
 * 因此桌面端这里也只有三块：连接地址、配对新设备、已配对设备。
 */
export default function RemoteAccessTab(): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDeviceSummary[]>([]);
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pairWindow, setPairWindow] = useState<RemotePairWindowDto | null>(null);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const pairWindowRef = useRef<RemotePairWindowDto | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const [nextStatus, nextDevices] = await Promise.all([
      window.api?.remoteAccess?.status?.(),
      window.api?.remoteAccess?.listDevices?.(),
    ]);
    if (nextStatus) {
      setStatus(nextStatus);
      setBaseUrlDraft(nextStatus.baseUrl);
    }
    setDevices(nextDevices ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!pairWindow) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairWindow]);

  // 窗口开着时轮询设备列表：手机一配对成功，桌面端立刻出现这台设备
  useEffect(() => {
    if (!pairWindow) return;
    const timer = window.setInterval(() => {
      void window.api?.remoteAccess?.listDevices?.().then((list) => { if (list) setDevices(list); });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [pairWindow]);

  useEffect(() => {
    pairWindowRef.current = pairWindow;
  }, [pairWindow]);

  useEffect(() => () => {
    if (pairWindowRef.current) void window.api?.remoteAccess?.closePairWindow?.();
  }, []);

  const configure = async (request: { enabled?: boolean; baseUrl?: string }): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const next = await window.api?.remoteAccess?.configure?.(request);
      if (next) {
        setStatus(next);
        setBaseUrlDraft(next.baseUrl);
      }
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveBaseUrl = async (): Promise<void> => {
    const value = baseUrlDraft.trim();
    if (!value) {
      setNotice({ text: "请填写手机端能访问到的连接地址（https 域名）", error: true });
      return;
    }
    await configure({ baseUrl: value });
    setNotice({ text: "连接地址已保存" });
  };

  const openPairWindow = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const opened = await window.api?.remoteAccess?.openPairWindow?.();
      if (!opened) return;
      setPairWindow(opened);
      setNow(Date.now());
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  const closePairWindow = (expired = false): void => {
    setPairWindow(null);
    void window.api?.remoteAccess?.closePairWindow?.();
    if (expired) setNotice({ text: "接入窗口已过期：60 秒内没有手机完成配对，需要时请重新开启。" });
    void load();
  };

  const revoke = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await window.api?.remoteAccess?.revokeDevice?.(id);
      await load();
      setNotice({ text: "设备授权已撤销" });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ text: `${label}已复制` });
    } catch {
      setNotice({ text: "复制失败，请手动选中复制", error: true });
    }
  };

  const activeDevices = useMemo(
    () => devices.filter((device) => !device.revokedAt).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    [devices],
  );
  const running = status?.running === true;
  const port = status?.port ?? 3352;
  const savedBaseUrl = status?.baseUrl.trim() ?? "";
  const pairSecondsLeft = pairWindow ? Math.max(0, Math.ceil((pairWindow.expiresAt - now) / 1000)) : 0;

  useEffect(() => {
    if (!pairWindow || pairWindow.expiresAt > now) return;
    setPairWindow(null);
    void window.api?.remoteAccess?.closePairWindow?.();
    setNotice({ text: "接入窗口已过期：60 秒内没有手机完成配对，需要时请重新开启。" });
  }, [pairWindow, now]);

  return (
    <div className="remote-access-page">
      <section className="remote-hero">
        <div className="remote-hero-main">
          <div>
            <div className="remote-eyebrow">REMOTE ACCESS</div>
            <h2>远程连接</h2>
            <p>手机连上后，任务仍然在这台电脑执行。电脑端只监听 127.0.0.1，手机通过你填的 https 域名进来。</p>
          </div>
          <div className="remote-hero-control">
            <div className={`remote-service-pill ${running ? "good" : status?.error ? "warn" : "neutral"}`}>
              <span className="remote-status-dot" />
              {running ? "运行中" : status?.configuredEnabled ? "启动失败" : "已关闭"}
            </div>
            <RemoteToggle
              on={status?.configuredEnabled === true}
              disabled={busy}
              onChange={(enabled) => void configure({ enabled })}
            />
          </div>
        </div>
      </section>

      {notice && <div className={`remote-notice ${notice.error ? "error" : ""}`}>{notice.text}</div>}
      {status?.error && !running && status.configuredEnabled && (
        <div className="remote-notice error">{status.error}</div>
      )}

      <section className="remote-panel">
        <div className="remote-panel-head">
          <div className="remote-panel-icon"><IconGlobe size={16} /></div>
          <div className="remote-panel-copy">
            <div className="remote-panel-title">连接地址</div>
            <div className="remote-panel-desc">手机端「连接电脑端 Mybuddy」里要填的地址。Tailscale Serve 或 Cloudflare 隧道都行，必须是 https。</div>
          </div>
        </div>
        <div className="remote-panel-body">
          <div className="remote-field-line">
            <input
              className="settings-input"
              placeholder="https://remote.vivioninst.uk"
              value={baseUrlDraft}
              disabled={busy}
              onChange={(event) => setBaseUrlDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void saveBaseUrl(); }}
            />
            <button
              type="button"
              className="btn primary"
              disabled={busy || baseUrlDraft.trim() === status?.baseUrl}
              onClick={() => void saveBaseUrl()}
            >
              保存
            </button>
          </div>
          {savedBaseUrl ? (
            <div className="remote-setting-hint">
              手机端填：<b>{savedBaseUrl}</b>
              <button type="button" className="btn remote-note-action" onClick={() => void copy(savedBaseUrl, "地址")}>复制</button>
            </div>
          ) : (
            <div className="remote-setting-hint">还没填地址：手机端就拿不到你的电脑。</div>
          )}
          <div className="remote-command-row">
            <code>tailscale serve --bg {port}</code>
            <button type="button" className="btn" onClick={() => void copy(`tailscale serve --bg ${port}`, "命令")}>复制命令</button>
          </div>
          <div className="remote-setting-hint">Serve 只对 tailnet 内可见；MyBuddy 不会自动登录 Tailscale、改 ACL 或开 Funnel。</div>
        </div>
      </section>

      <section className="remote-panel">
        <div className="remote-panel-head">
          <div className="remote-panel-icon"><IconShield size={16} /></div>
          <div className="remote-panel-copy">
            <div className="remote-panel-title">配对新设备</div>
            <div className="remote-panel-desc">点下面的按钮，电脑会给一个 6 位配对码；在手机端填上地址和这个码就完成配对。窗口 60 秒后自动关闭。</div>
          </div>
          <div className="remote-panel-action">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !running || Boolean(pairWindow)}
              title={running ? "开启 60 秒接入窗口" : "请先启用上面的开关"}
              onClick={() => void openPairWindow()}
            >
              允许新设备接入
            </button>
          </div>
        </div>
        <div className="remote-panel-body">
          {pairWindow ? (
            <div className="remote-pairing-body" style={{ alignItems: "center", gap: 12 }}>
              <div className="remote-pair-code">{pairWindow.code}</div>
              <div className="remote-pairing-timer">{pairSecondsLeft} 秒后自动关闭</div>
              <div className="remote-pairing-actions">
                <button type="button" className="btn" onClick={() => void copy(pairWindow.code, "配对码")}>复制配对码</button>
                <button type="button" className="btn" onClick={() => closePairWindow()}>关闭窗口</button>
              </div>
            </div>
          ) : (
            <div className="remote-setting-hint">
              {running
                ? "手机端：连接地址 + 6 位配对码 → 连接。配对成功后手机记住令牌，以后不用再配。"
                : "先打开上面的开关，让服务跑起来才能配对。"}
            </div>
          )}
        </div>
      </section>

      <section className="remote-panel remote-devices-panel">
        <div className="remote-panel-head">
          <div className="remote-panel-icon"><IconLink size={16} /></div>
          <div className="remote-panel-copy">
            <div className="remote-panel-title">已配对设备（{activeDevices.length}）</div>
            <div className="remote-panel-desc">撤销后，这台手机上的令牌立即失效，需要重新配对。</div>
          </div>
          <div className="remote-panel-action">
            <button type="button" className="remote-icon-button" disabled={busy} title="刷新设备列表" onClick={() => void load()}>
              <IconRefresh size={15} />
            </button>
          </div>
        </div>
        <div className="remote-panel-body">
          {activeDevices.length === 0 ? (
            <div className="remote-empty-state">暂无已配对设备。</div>
          ) : (
            <div className="remote-paired-list">
              {activeDevices.map((device) => (
                <div className="remote-paired-device" key={device.id}>
                  <div className="remote-device-avatar online">{device.name.trim().slice(0, 1).toUpperCase() || "A"}</div>
                  <div className="remote-device-copy">
                    <div className="remote-device-name">{device.name}</div>
                    <div className="remote-device-meta">最近在线 {formatLastSeen(device.lastSeenAt)}</div>
                  </div>
                  <button type="button" className="remote-revoke-button" disabled={busy} onClick={() => void revoke(device.id)}>撤销</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
