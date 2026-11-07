import { useCallback, useEffect, useState } from "react";
import type { BotExpertVersionDto } from "@shared/bot-work";

/**
 * R09: review the complete pending expert configuration before adopting it.
 *
 * The adopt request carries the exact `pendingVersion` + `snapshotId` that was rendered.
 * If staging moves to another version while this panel is open, the host refuses the old
 * confirmation instead of binding the reviewed prompt to a newer version's content.
 */
export function BotExpertReview(props: { botId: string }): React.JSX.Element {
  const [versions, setVersions] = useState<BotExpertVersionDto[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = window.api;
      if (!api) return;
      setVersions(await api.botWork.listBotExpertVersions(props.botId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "专家配置读取失败");
    }
  }, [props.botId]);

  useEffect(() => { void load(); }, [load]);

  const pending = versions.find(version => version.state === "pending");
  const active = versions.find(version => version.state === "active");

  const adopt = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const api = window.api;
      if (!api) throw new Error("桌面接口不可用");
      const result = await api.botWork.adoptBotExpertVersion(props.botId, {
        pendingVersion: pending.version, snapshotId: pending.snapshotId,
      });
      setNotice(result.ok ? `已采用 v${result.adoptedVersion}` : result.message ?? "采用未完成");
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "采用未完成");
    } finally { setBusy(false); }
  };

  if (versions.length === 0) return <p>尚未记录专家配置版本。</p>;

  return <div className="bot-expert-review">
    <p>当前生效 {active ? `v${active.version} · ${active.configuration?.name ?? active.expertId}` : "未采用任何专家配置"}</p>
    {pending ? <section aria-label="待审阅专家配置">
      <h4>待审阅 v{pending.version}（{pending.configuration?.name ?? pending.expertId}）</h4>
      <p>提示词哈希 {pending.systemPromptHash.slice(0, 12)} · 来源 {pending.sourceRevision}</p>
      <details>
        <summary>查看完整配置</summary>
        <p>技能 {pending.allowedSkillIds.length ? pending.allowedSkillIds.join("、") : "无"}</p>
        <p>MCP {pending.allowedMcpIds.length ? pending.allowedMcpIds.join("、") : "无"}</p>
        <p>连接器 {pending.allowedConnectorIds.length ? pending.allowedConnectorIds.join("、") : "无"}</p>
        <pre className="bot-expert-prompt">{pending.configuration?.instructions ?? "（无完整提示词快照）"}</pre>
      </details>
      <button type="button" disabled={busy || !pending.configuration} onClick={() => { void adopt(); }}>
        采用 v{pending.version}
      </button>
      {!pending.configuration && <p>这一版本缺少完整快照，不能采用。</p>}
    </section> : <p>没有待审阅的新配置。</p>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
