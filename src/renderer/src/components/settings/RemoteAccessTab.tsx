import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  IconGlobe,
  IconHardDrive,
  IconLink,
  IconQr,
  IconRefresh,
  IconShield,
} from "@/components/common/icons";
import type {
  RemoteDeviceSummary,
  RemotePairingSession,
  RemoteStatus,
  RemoteUsbStatus,
} from "@shared/remote-access";

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

function StatCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "good" | "warn" | "neutral";
}): React.JSX.Element {
  return (
    <div className={`remote-stat-card ${tone}`}>
      <div className="remote-stat-label">{label}</div>
      <div className="remote-stat-value">{value}</div>
      <div className="remote-stat-detail">{detail}</div>
    </div>
  );
}

function Panel({
  icon: Icon,
  title,
  desc,
  action,
  className = "",
  children,
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  desc: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={`remote-panel ${className}`}>
      <div className="remote-panel-head">
        <div className="remote-panel-icon"><Icon size={16} /></div>
        <div className="remote-panel-copy">
          <div className="remote-panel-title">{title}</div>
          <div className="remote-panel-desc">{desc}</div>
        </div>
        {action && <div className="remote-panel-action">{action}</div>}
      </div>
      <div className="remote-panel-body">{children}</div>
    </section>
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

function endpointLabel(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return "未配置";
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function endpointDetail(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return "未配置";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && /(?:^|\.)ts\.net$/i.test(url.hostname)) return "Tailscale HTTPS · 已保存";
    if (url.protocol === "https:") return "HTTPS · 已保存";
    if (url.protocol === "http:") return "私网 HTTP · 已保存";
  } catch {
    // Backend validation owns the authoritative verdict.
  }
  return "地址待验证";
}

export default function RemoteAccessTab(): React.JSX.Element {
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null);
  const [remoteDevices, setRemoteDevices] = useState<RemoteDeviceSummary[]>([]);
  const [remotePort, setRemotePort] = useState("3352");
  const [remoteBaseUrl, setRemoteBaseUrl] = useState("");
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [usbStatus, setUsbStatus] = useState<RemoteUsbStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairingSession | null>(null);
  const pairingRef = useRef<RemotePairingSession | null>(null);
  const [pairingQr, setPairingQr] = useState("");
  const [pairingNow, setPairingNow] = useState(Date.now());
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const loadRemote = useCallback(async (): Promise<void> => {
    const [nextStatus, devices, nextUsbStatus] = await Promise.all([
      window.api?.remoteAccess?.status?.(),
      window.api?.remoteAccess?.listDevices?.(),
      window.api?.remoteAccess?.usbStatus?.(),
    ]);
    if (nextStatus) {
      setRemoteStatus(nextStatus);
      setRemotePort(String(nextStatus.port));
      setRemoteBaseUrl(nextStatus.baseUrl);
    }
    setRemoteDevices(devices ?? []);
    setUsbStatus(nextUsbStatus ?? null);
  }, []);

  useEffect(() => {
    void loadRemote();
  }, [loadRemote]);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setPairingNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (!pairing) return;
    const refreshDevices = async (): Promise<void> => {
      try {
        const devices = await window.api?.remoteAccess?.listDevices?.();
        if (devices) setRemoteDevices(devices);
      } catch {
        // Pairing remains usable even if a background refresh fails.
      }
    };
    const timer = window.setInterval(() => void refreshDevices(), 1500);
    return () => window.clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (!pairing || pairing.expiresAt > pairingNow) return;
    void window.api?.remoteAccess?.cancelPairingSession?.(pairing.pairingId);
    setPairing(null);
    setPairingQr("");
    setNotice({ text: "配对链接已过期，请重新添加设备" });
  }, [pairing, pairingNow]);

  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => () => {
    const active = pairingRef.current;
    if (active) void window.api?.remoteAccess?.cancelPairingSession?.(active.pairingId);
  }, []);

  const configureRemote = async (request: { enabled?: boolean; port?: number; baseUrl?: string; bindMode?: "loopback" | "lan" }): Promise<void> => {
    setRemoteBusy(true);
    setNotice(null);
    try {
      const next = await window.api?.remoteAccess?.configure?.(request);
      if (next) {
        setRemoteStatus(next);
        setRemotePort(String(next.port));
        setRemoteBaseUrl(next.baseUrl);
      }
      setNotice({ text: "远程连接设置已应用" });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      await loadRemote();
    } finally {
      setRemoteBusy(false);
    }
  };

  const createRemotePairing = async (): Promise<void> => {
    setRemoteBusy(true);
    setNotice(null);
    try {
      const session = await window.api?.remoteAccess?.createPairingSession?.();
      if (!session) return;
      setPairing(session);
      setPairingNow(Date.now());
      setPairingQr(await QRCode.toDataURL(session.pairingUrl, { width: 220, margin: 1 }));
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setRemoteBusy(false);
    }
  };

  const closeRemotePairing = (): void => {
    if (pairing) void window.api?.remoteAccess?.cancelPairingSession?.(pairing.pairingId);
    setPairing(null);
    setPairingQr("");
    void loadRemote();
  };

  const pairRemoteUsb = async (serial: string): Promise<void> => {
    setRemoteBusy(true);
    setNotice(null);
    try {
      let current = remoteStatus;
      if (!current?.configuredEnabled) {
        current = await window.api?.remoteAccess?.configure?.({ enabled: true }) ?? null;
        if (current) {
          setRemoteStatus(current);
          setRemotePort(String(current.port));
          setRemoteBaseUrl(current.baseUrl);
        }
      }
      const result = await window.api?.remoteAccess?.pairUsb?.(serial);
      if (!result) return;
      setNotice({ text: `USB 通道已建立，已在 ${result.device.model || result.device.serial} 上打开 MyBuddy Remote` });
      window.setTimeout(() => void loadRemote(), 1200);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      await loadRemote();
    } finally {
      setRemoteBusy(false);
    }
  };

  const revokeDevice = async (id: string): Promise<void> => {
    setRemoteBusy(true);
    setNotice(null);
    try {
      await window.api?.remoteAccess?.revokeDevice?.(id);
      setNotice({ text: "设备授权已撤销" });
      await loadRemote();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setRemoteBusy(false);
    }
  };

  const activeDevices = useMemo(
    () => remoteDevices.filter((device) => !device.revokedAt).sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    [remoteDevices],
  );
  const usbConnected = usbStatus?.devices.filter((device) => device.state === "device") ?? [];
  const serviceTone = remoteStatus?.running ? "good" : remoteStatus?.error ? "warn" : "neutral";
  const serviceText = remoteStatus?.running ? "运行中" : remoteStatus?.configuredEnabled ? "启动失败" : "已关闭";
  const tailscaleCommand = `tailscale serve --bg ${remoteStatus?.port ?? 3352}`;
  const lanUrl = remoteStatus?.lanUrls?.[0] ?? "";
  const savedBaseUrl = remoteStatus?.baseUrl ?? "";
  const hasNetworkPairingAddress = Boolean(savedBaseUrl.trim()) || (remoteStatus?.bindMode === "lan" && Boolean(lanUrl));
  const canCreateNetworkPairing = remoteStatus?.running === true && hasNetworkPairingAddress;
  const remotePortNumber = Number(remotePort);
  const remotePortValid = Number.isInteger(remotePortNumber) && remotePortNumber >= 1024 && remotePortNumber <= 65535;
  const serviceEndpoint = remoteStatus?.bindMode === "lan"
    ? (lanUrl || `0.0.0.0:${remoteStatus?.port ?? 3352}`)
    : `127.0.0.1:${remoteStatus?.port ?? 3352}`;

  return (
    <div className="remote-access-page">
      <section className="remote-hero">
        <div className="remote-hero-main">
          <div>
            <div className="remote-eyebrow">REMOTE ACCESS</div>
            <h2>远程连接</h2>
            <p>任务仍在这台电脑执行。默认仅本机监听；需要局域网直连时可显式开启 LAN 模式。</p>
          </div>
          <div className="remote-hero-control">
            <div className={`remote-service-pill ${serviceTone}`}>
              <span className="remote-status-dot" />
              {serviceText}
            </div>
            <RemoteToggle
              on={remoteStatus?.configuredEnabled === true}
              disabled={remoteBusy}
              onChange={(enabled) => void configureRemote({ enabled })}
            />
          </div>
        </div>
        <div className="remote-stat-grid">
          <StatCard
            label="服务"
            value={serviceText}
            detail={serviceEndpoint}
            tone={serviceTone}
          />
          <StatCard
            label="USB"
            value={usbStatus?.adbAvailable ? `${usbConnected.length} 台` : "不可用"}
            detail={usbStatus?.adbAvailable ? "ADB 调试通道" : (usbStatus?.error || "正在检测 ADB")}
            tone={usbConnected.length > 0 ? "good" : "neutral"}
          />
          <StatCard
            label="已配对"
            value={`${activeDevices.length} 台`}
            detail={activeDevices[0] ? `最近 ${formatLastSeen(activeDevices[0].lastSeenAt)}` : "暂无授权设备"}
          />
          <StatCard
            label="外部入口"
            value={endpointLabel(savedBaseUrl)}
            detail={endpointDetail(savedBaseUrl)}
          />
        </div>
      </section>

      {notice && <div className={`remote-notice ${notice.error ? "error" : ""}`}>{notice.text}</div>}

      <div className="remote-layout-grid">
        <Panel
          icon={IconShield}
          title="服务配置"
          desc="配置监听端口与访问范围。默认仅本机；LAN 模式只建议在受信任局域网使用。"
        >
          <div className="remote-setting-row">
            <div>
              <div className="remote-setting-label">访问范围</div>
              <div className="remote-setting-hint">切换后服务会自动重启</div>
            </div>
            <div className="remote-inline-control">
              <button type="button" className={`btn ${remoteStatus?.bindMode !== "lan" ? "primary" : ""}`} disabled={remoteBusy} onClick={() => void configureRemote({ bindMode: "loopback" })}>仅本机</button>
              <button type="button" className={`btn ${remoteStatus?.bindMode === "lan" ? "primary" : ""}`} disabled={remoteBusy} onClick={() => void configureRemote({ bindMode: "lan" })}>局域网</button>
            </div>
          </div>
          <div className="remote-setting-row">
            <div>
              <div className="remote-setting-label">监听端口</div>
              <div className="remote-setting-hint">USB reverse 与 Tailscale Serve 共用此端口</div>
            </div>
            <div className="remote-inline-control">
              <input
                className="settings-input remote-port-input"
                inputMode="numeric"
                value={remotePort}
                disabled={remoteBusy}
                onChange={(event) => setRemotePort(event.target.value.replace(/\D/g, "").slice(0, 5))}
              />
              <button
                type="button"
                className="btn"
                disabled={remoteBusy || !remotePortValid || remotePortNumber === remoteStatus?.port}
                onClick={() => void configureRemote({ port: remotePortNumber })}
              >
                应用
              </button>
            </div>
          </div>
          {!remotePortValid && remotePort.length > 0 && (
            <div className="remote-setting-hint">端口范围必须为 1024–65535。</div>
          )}
          <div className="remote-binding-note">
            <span className="remote-binding-dot" />
            <div>
              <b>{remoteStatus?.bindMode === "lan" ? "LAN listening" : "127.0.0.1 only"}</b>
              <span>{remoteStatus?.bindMode === "lan"
                ? (lanUrl ? `局域网入口：${lanUrl} · 自动发现 mDNS + UDP 3353` : "已监听 0.0.0.0，但暂未发现可用 RFC1918 IPv4 地址")
                : "局域网设备不能直接访问 MyBuddy Remote 服务。"}</span>
            </div>
          </div>
        </Panel>

        <Panel
          icon={IconHardDrive}
          title="USB 数据线"
          desc="推荐的本地连接方式。MyBuddy 自动建立 ADB reverse，不需要开放任何网络端口。"
          action={
            <button type="button" className="remote-icon-button" disabled={remoteBusy} title="刷新 USB 设备" onClick={() => void loadRemote()}>
              <IconRefresh size={15} />
            </button>
          }
        >
          {!usbStatus?.adbAvailable && (
            <div className="remote-empty-state">{usbStatus?.error || "正在检查 Android SDK / ADB…"}</div>
          )}
          {usbStatus?.adbAvailable && usbStatus.devices.length === 0 && (
            <div className="remote-empty-state">插入数据线，开启 USB 调试并在手机上允许此电脑。</div>
          )}
          {usbStatus?.devices.map((device) => {
            const ready = device.state === "device";
            return (
              <div className="remote-usb-device" key={device.serial}>
                <div className={`remote-device-avatar ${ready ? "online" : ""}`}>A</div>
                <div className="remote-device-copy">
                  <div className="remote-device-name">{device.model || device.device || "Android 设备"}</div>
                  <div className="remote-device-meta">{device.serial}</div>
                  <div className={`remote-device-state ${ready ? "online" : ""}`}>
                    <span className="remote-status-dot" />
                    {ready ? "USB 调试已连接" : device.state === "unauthorized" ? "等待手机授权" : device.state}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary remote-device-primary"
                  disabled={remoteBusy || !ready}
                  onClick={() => void pairRemoteUsb(device.serial)}
                >
                  USB 配对
                </button>
              </div>
            );
          })}
        </Panel>

        <Panel
          icon={IconGlobe}
          title="Tailscale 远程入口"
          className="remote-tailscale-panel"
          desc="可选。Tailscale Serve 把本机服务映射为 tailnet 内 HTTPS；保存 Serve 地址后即可生成远程配对链接。"
        >
          <label className="remote-field">
            <span>访问地址</span>
            <div className="remote-field-line">
              <input
                className="settings-input"
                placeholder="https://device.tailnet.ts.net"
                value={remoteBaseUrl}
                disabled={remoteBusy}
                onChange={(event) => setRemoteBaseUrl(event.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={remoteBusy || remoteBaseUrl === remoteStatus?.baseUrl}
                onClick={() => void configureRemote({ baseUrl: remoteBaseUrl })}
              >
                保存
              </button>
            </div>
            <div className="remote-setting-hint">这里只保存 Serve 的 HTTPS 地址；MyBuddy 不会自动登录 Tailscale、修改 ACL 或启用 Funnel。</div>
          </label>
          <div className="remote-command-row">
            <code>{tailscaleCommand}</code>
            <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(tailscaleCommand)}>复制命令</button>
          </div>
          <div className={`remote-binding-note ${remoteStatus?.bindMode === "lan" ? "warn" : ""}`}>
            <span className="remote-binding-dot" />
            <div>
              <b>{remoteStatus?.bindMode === "lan" ? "Tailscale 不需要 LAN 监听" : "仅 tailnet 内可访问"}</b>
              <span>{remoteStatus?.bindMode === "lan"
                ? "Serve 可以直接代理本机端口；建议切回“仅本机”以减少局域网暴露。"
                : "Serve 不会把 MyBuddy 公开到互联网。更改监听端口后，需要重新执行上面的 Serve 命令。"}</span>
              {remoteStatus?.bindMode === "lan" && (
                <button type="button" className="btn remote-note-action" disabled={remoteBusy} onClick={() => void configureRemote({ bindMode: "loopback" })}>
                  切回仅本机
                </button>
              )}
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        icon={IconLink}
        title="已配对设备"
        desc="这些设备持有 Remote API 授权。撤销后对应 Token 会立即失效。"
        className="remote-devices-panel"
        action={
          <button
            type="button"
            className="btn primary"
            disabled={remoteBusy || !canCreateNetworkPairing}
            title={!remoteStatus?.running
              ? "请先启用并确认 Remote Access 服务运行正常"
              : !hasNetworkPairingAddress
                ? "请先配置 Tailscale HTTPS 地址，或切换到局域网模式"
                : undefined}
            onClick={() => void createRemotePairing()}
          >
            添加设备
          </button>
        }
      >
        {activeDevices.length === 0 && <div className="remote-empty-state">暂无已配对设备。</div>}
        <div className="remote-paired-list">
          {activeDevices.map((device) => (
            <div className="remote-paired-device" key={device.id}>
              <div className="remote-device-avatar online">{device.name.trim().slice(0, 1).toUpperCase() || "A"}</div>
              <div className="remote-device-copy">
                <div className="remote-device-name">{device.name}</div>
                <div className="remote-device-meta">最近在线 {formatLastSeen(device.lastSeenAt)}</div>
                <div className="remote-capabilities">
                  {device.capabilities.slice(0, 4).map((capability) => <span key={capability}>{capability}</span>)}
                </div>
              </div>
              <button type="button" className="remote-revoke-button" disabled={remoteBusy} onClick={() => void revokeDevice(device.id)}>撤销</button>
            </div>
          ))}
        </div>
      </Panel>

      {pairing && (
        <section className="remote-pairing-card">
          <div className="remote-pairing-copy">
            <div className="remote-panel-icon"><IconQr size={17} /></div>
            <div>
              <div className="remote-panel-title">添加移动设备</div>
              <div className="remote-panel-desc">使用 MyBuddy Remote 扫描二维码或复制一次性链接。密钥只能使用一次。</div>
              <div className="remote-pairing-timer">{Math.max(0, Math.ceil((pairing.expiresAt - pairingNow) / 1000))} 秒后过期</div>
            </div>
          </div>
          <div className="remote-pairing-body">
            {pairingQr && <img src={pairingQr} width={190} height={190} alt="MyBuddy Remote 配对二维码" />}
            <div className="remote-pairing-link">
              <input className="settings-input" readOnly value={pairing.pairingUrl} />
              <div className="remote-pairing-actions">
                <button type="button" className="btn primary" onClick={() => void navigator.clipboard.writeText(pairing.pairingUrl)}>复制配对链接</button>
                <button type="button" className="btn" onClick={closeRemotePairing}>关闭</button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
