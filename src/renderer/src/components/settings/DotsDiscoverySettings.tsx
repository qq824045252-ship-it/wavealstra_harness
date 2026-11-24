import { useEffect, useState } from "react";
import { discoverySchedule, discoveryUrl, type DiscoverySchedule, type DiscoveryStatus, type DotsDiscoveryStatus,
  type DreamSettings, type DreamTag, type RssSubscription } from "@shared/dots-discovery";
import { SettingsInput, SettingsSection, SettingsSelect } from "./SettingsPrimitives";

function Schedule({ kind, value, update }: {
  kind: "rss" | "dream"; value: DiscoverySchedule; update(schedule: DiscoverySchedule): void;
}) {
  return <div className="dots-google-times">
    <SettingsSelect label={kind === "rss" ? "推送方式" : "探索方式"} value={value.mode}
      onChange={event => update({ ...value, mode: event.target.value as DiscoverySchedule["mode"] })}>
      <option value="interval">{kind === "rss" ? "按间隔汇总" : "按间隔探索"}</option>
      <option value="daily">每天固定时间</option>
      {kind === "rss" ? <option value="new">发现新内容时推送</option> : <option value="random">时间段内随机一次</option>}
    </SettingsSelect>
    {(value.mode === "interval" || value.mode === "new") &&
      <SettingsInput label={value.mode === "new" ? "检查间隔（分钟）" : "间隔（分钟）"} type="number"
        min={kind === "rss" ? 1 : 30} max={1440} required value={value.minutes || ""}
        onChange={event => update({ ...value, minutes: Number(event.target.value) })} />}
    {value.mode === "daily" && <SettingsInput label="每日时间" type="time" required value={value.time}
      onChange={event => update({ ...value, time: event.target.value })} />}
    {value.mode === "random" && <>
      <SettingsInput label="随机窗口开始" type="time" required value={value.windowStart}
        onChange={event => update({ ...value, windowStart: event.target.value })} />
      <SettingsInput label="随机窗口结束" type="time" required value={value.windowEnd}
        onChange={event => update({ ...value, windowEnd: event.target.value })} />
    </>}
  </div>;
}

function scheduleText(rule: DiscoverySchedule) {
  if (rule.mode === "daily") return `每天 ${rule.time} 汇总`;
  return rule.mode === "new" ? `每 ${rule.minutes} 分钟检查，有新内容就推送` : `每 ${rule.minutes} 分钟汇总`;
}

function Details({ state }: { state?: DiscoveryStatus }) {
  if (!state) return null;
  return <>
    {state.running && <p role="status">正在检查…</p>}
    {state.message && <p className="settings-field-hint" role="status">{state.message}</p>}
    {(state.checkedAt || state.nextAt || Boolean(state.pending)) && <p className="settings-field-hint">
      {state.checkedAt && `上次检查 ${new Date(state.checkedAt).toLocaleString()} `}
      {state.nextAt && `· 下次 ${new Date(state.nextAt).toLocaleString()} `}
      {state.pending ? `· ${state.pending} 条待汇总` : ""}
    </p>}
    {!!state.recent?.length && <details className="dots-discovery-results">
      <summary>最近内容</summary>
      <ul>{state.recent.map(item => <li key={item.url}>
        <button className="btn" type="button" onClick={() => window.api?.browser?.openExternal(item.url)}>{item.title}</button>
        {item.summary && <p>{item.summary}</p>}
      </li>)}</ul>
    </details>}
  </>;
}

function RssEditor({ item, rows, onSave, cancel }: {
  item?: RssSubscription; rows: RssSubscription[]; onSave(value: RssSubscription): void; cancel(): void;
}) {
  const [draft, setDraft] = useState(item ?? { id: crypto.randomUUID(), name: "", url: "", enabled: true, schedule: discoverySchedule(undefined, "rss") });
  const [error, setError] = useState("");
  return <form className="dots-discovery-editor" onSubmit={event => {
    event.preventDefault();
    const url = discoveryUrl(draft.url.trim());
    if (!url) { setError("请输入有效的 HTTP 或 HTTPS 订阅地址。"); return; }
    if (rows.some(feed => feed.id !== draft.id && feed.url === url)) { setError("这个订阅地址已经添加。"); return; }
    onSave({ ...draft, url });
  }}>
    <SettingsInput label="订阅地址" type="url" required maxLength={2048} value={draft.url}
      onChange={event => setDraft({ ...draft, url: event.target.value })} />
    <SettingsInput label="订阅名称（可选）" maxLength={80} value={draft.name}
      onChange={event => setDraft({ ...draft, name: event.target.value })} />
    <Schedule kind="rss" value={draft.schedule} update={schedule => setDraft({ ...draft, schedule })} />
    {error && <p role="alert">{error}</p>}
    <div className="dots-google-account-actions">
      <button type="submit" className="btn primary">保存订阅</button>
      <button type="button" className="btn" onClick={cancel}>取消</button>
    </div>
  </form>;
}

function DreamTagEditor({ value, suggestion, tags, save, cancel }: {
  value?: DreamTag; suggestion?: string; tags: DreamTag[]; save(tag: DreamTag): void; cancel(): void;
}) {
  const [draft, setDraft] = useState(value ?? { id: crypto.randomUUID(), name: suggestion ?? "", query: "", enabled: true });
  const [error, setError] = useState("");
  return <form className="dots-discovery-editor" onSubmit={event => {
    event.preventDefault();
    const name = draft.name.trim();
    const query = draft.query.trim() || name;
    if (!name || tags.some(tag => tag.id !== draft.id && tag.query.toLowerCase() === query.toLowerCase())) {
      setError("请输入标签名称，并使用尚未添加的搜索词。"); return;
    }
    save({ ...draft, name, query });
  }}>
    <SettingsInput label="兴趣标签" required maxLength={40} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
    <SettingsInput label="公开搜索关键词" maxLength={160} value={draft.query} placeholder="留空则搜索标签名称"
      onChange={event => setDraft({ ...draft, query: event.target.value })} />
    {error && <p role="alert">{error}</p>}
    <div className="dots-google-account-actions">
      <button type="submit" className="btn primary">保存标签</button>
      <button type="button" className="btn" onClick={cancel}>取消</button>
    </div>
  </form>;
}

function DreamSchedule({ value, save }: { value: DreamSettings; save(value: DreamSettings): void }) {
  const [schedule, setSchedule] = useState(value.schedule);
  const [enabled, setEnabled] = useState(value.enabled);
  const [useMemory, setUseMemory] = useState(value.useMemory);
  const [error, setError] = useState("");
  return <form className="dots-discovery-editor" onSubmit={event => {
    event.preventDefault();
    if (schedule.mode === "random" && schedule.windowStart === schedule.windowEnd) {
      setError("随机窗口的开始和结束时间需要不同。"); return;
    }
    save({ ...value, schedule, enabled, useMemory });
  }}>
    <label className="dots-config-check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />定期主动探索</label>
    <label className="dots-config-check"><input type="checkbox" checked={useMemory} onChange={event => setUseMemory(event.target.checked)} />用 Dots 的偏好记忆辅助选题</label>
    <Schedule kind="dream" value={schedule} update={setSchedule} />
    {error && <p role="alert">{error}</p>}
    <button type="submit" className="btn">保存 Dream 设置</button>
  </form>;
}

export default function DotsDiscoverySettings({ kind, rss, dream, saveRss, saveDream }: {
  kind: "rss" | "dream"; rss: RssSubscription[]; dream: DreamSettings;
  saveRss(value: RssSubscription[]): Promise<boolean>; saveDream(value: DreamSettings): Promise<boolean>;
}) {
  const api = window.api?.dotsDiscovery;
  const [status, setStatus] = useState<DotsDiscoveryStatus>();
  const [editing, setEditing] = useState<string>();
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>();
  const [suggestion, setSuggestion] = useState<string>();
  useEffect(() => {
    if (!api) return;
    let attached = true;
    const read = () => void api.status().then(value => { if (attached) setStatus(value); }).catch(() => {
      if (attached) setError("无法读取运行状态，请重启 MyBuddy 后重试。");
    });
    read();
    const timer = setInterval(read, 3_000);
    return () => { attached = false; clearInterval(timer); };
  }, [api]);
  const run = async (id?: string) => {
    if (!api || running) return;
    setRunning(id ?? "dream");
    setError("");
    try { setStatus(await api.run(kind, id)); }
    catch (error) { setError(String(error).replace(/^.*Error: /, "")); }
    finally { setRunning(undefined); }
  };
  if (!api) return <p role="alert">当前 MyBuddy 主进程尚未加载此能力，请重新启动。</p>;
  const rssEdit = rss.find(feed => feed.id === editing);
  const tagEdit = dream.tags.find(tag => tag.id === editing);

  return kind === "rss" ? <SettingsSection title="RSS 订阅" description="首次检查建立基线。后续发现的新内容按每条订阅的规则推送。所有时间使用此电脑的本地时区。">
    {rss.map(item => <div className="dots-discovery-row" key={item.id}>
      <div className="dots-google-account">
        <div><strong>{item.name}</strong><div className="settings-field-hint">{item.enabled ? scheduleText(item.schedule) : "已暂停"}</div></div>
        <div className="dots-google-account-actions">
          <button type="button" className="btn" disabled={!!running || status?.rss[item.id]?.running} onClick={() => void run(item.id)}>立即检查</button>
          <button type="button" className="btn" onClick={() => setEditing(item.id)}>编辑</button>
          <button type="button" className="btn" onClick={() => void saveRss(rss.map(feed => feed.id === item.id ? { ...feed, enabled: !item.enabled } : feed))}>{item.enabled ? "暂停" : "启用"}</button>
          <button type="button" className="btn" onClick={() => { if (editing === item.id) setEditing(undefined); void saveRss(rss.filter(feed => feed.id !== item.id)); }}>移除</button>
        </div>
      </div>
      <Details state={status?.rss[item.id]} />
    </div>)}
    {editing ? <RssEditor key={editing} item={rssEdit} rows={rss} cancel={() => setEditing(undefined)}
      onSave={item => { const next = rssEdit ? rss.map(feed => feed.id === item.id ? item : feed) : [...rss, item];
        void saveRss(next).then(saved => { if (saved) setEditing(undefined); }); }} />
      : <button type="button" className="btn primary" disabled={rss.length >= 64} onClick={() => setEditing("new")}>添加订阅</button>}
    {error && <p role="alert">{error}</p>}
  </SettingsSection> : <>
    <SettingsSection title="Dream" description="按兴趣标签寻找近期公开内容。记忆只在本机辅助挑选标签，联网时发送下面设置的公开搜索词。">
      <DreamSchedule key={JSON.stringify([dream.enabled, dream.useMemory, dream.schedule])} value={dream} save={value => void saveDream(value)} />
      <div className="dots-discovery-run">
        <button type="button" className="btn" disabled={!!running || status?.dream.running || !dream.tags.some(tag => tag.enabled)}
          onClick={() => void run()}>现在探索</button>
        <Details state={status?.dream} />
        {error && <p role="alert">{error}</p>}
      </div>
    </SettingsSection>
    <SettingsSection title="兴趣标签">
      {dream.tags.map(tag => <div className="dots-google-account" key={tag.id}>
        <label className="dots-config-check">
          <input type="checkbox" checked={tag.enabled} onChange={event => void saveDream({ ...dream,
            tags: dream.tags.map(item => item.id === tag.id ? { ...item, enabled: event.target.checked } : item) })} />
          <span>{tag.name}<small>{tag.query}</small></span>
        </label>
        <div className="dots-google-account-actions">
          <button type="button" className="btn" onClick={() => setEditing(tag.id)}>编辑</button>
          <button type="button" className="btn" onClick={() => { if (editing === tag.id) setEditing(undefined); void saveDream({ ...dream, tags: dream.tags.filter(item => item.id !== tag.id) }); }}>移除</button>
        </div>
      </div>)}
      {editing ? <DreamTagEditor key={editing + (suggestion ?? "")} value={tagEdit} suggestion={suggestion} tags={dream.tags} cancel={() => setEditing(undefined)}
        save={tag => { const tags = tagEdit ? dream.tags.map(item => item.id === tag.id ? tag : item) : [...dream.tags, tag];
          void saveDream({ ...dream, tags }).then(saved => { if (saved) setEditing(undefined); }); }} />
        : <div className="dots-google-account-actions">
          <button type="button" className="btn primary" disabled={dream.tags.length >= 40}
            onClick={() => { setSuggestion(undefined); setEditing("new"); }}>添加标签</button>
          <button type="button" className="btn" disabled={dream.tags.length >= 40} onClick={() => void api.suggestTags().then(setSuggestions)
            .catch(() => setError("无法读取偏好记忆。"))}>从记忆找标签</button>
        </div>}
      {!editing && suggestions && (suggestions.length ? <div className="dots-discovery-run dots-google-account-actions">
        {suggestions.filter(name => !dream.tags.some(tag => tag.name === name)).map(name => <button className="btn" type="button" key={name}
          onClick={() => { setSuggestion(name); setEditing("new"); }}>{name}</button>)}
      </div> : <p className="settings-field-hint" role="status">没有可用的偏好标签建议。</p>)}
    </SettingsSection>
  </>;
}
