import { useEffect, useState } from "react";
import { dotsGoogleAccounts, dotsGoogleSources, type DotsGoogleAccount, type DotsGoogleRule, type DotsGoogleRules,
  type DotsGoogleSource, type DotsGoogleStatus } from "@shared/dots-google";
import { SettingsInput, SettingsSection, SettingsSelect } from "./SettingsPrimitives";

const labels = { personal: "个人账号", company: "公司账号" } as const;
const sources = { gmail: "Gmail 邮箱", calendar: "Google 日历" } as const;

function RuleForm({ source, value, status, onSave }: {
  source: DotsGoogleSource;
  value: DotsGoogleRule;
  status?: DotsGoogleStatus;
  onSave(rule: DotsGoogleRule): void;
}) {
  const [rule, setRule] = useState(value);
  return <SettingsSection title={sources[source]} description={source === "calendar"
    ? "按设置的时间同步主日历。会议开始前约 30 分钟提醒，全天事项在当天上午提醒。"
    : "首次检查记录当前位置，之后有新邮件时在 MyBuddy 通知。"}>
    <form className="dots-google-rule" onSubmit={event => { event.preventDefault(); onSave(rule); }}>
      <fieldset>
        <legend>使用账号</legend>
        {dotsGoogleAccounts.map(account => {
          const selected = rule.accounts.includes(account);
          const access = status?.accounts[account].connection?.access[source];
          const check = status?.sources[source][account];
          return <label key={account} className="dots-config-check">
            <input type="checkbox" checked={selected} disabled={!selected && !access?.ready}
              onChange={event => setRule(previous => ({ ...previous, accounts: event.target.checked
                ? [...previous.accounts, account] : previous.accounts.filter(item => item !== account) }))} />
            <span>{labels[account]}{!access?.ready && <small>{access?.message ?? "先连接 Google 账号"}</small>}
              {check?.message ? <small role="status">{check.message}</small> : check?.nextAt &&
                <small>下次检查 {new Date(check.nextAt).toLocaleString()}</small>}</span>
          </label>;
        })}
      </fieldset>
      <div className="dots-google-times">
        <SettingsSelect label={sources[source] + "检查方式"} value={rule.mode}
          onChange={event => setRule({ ...rule, mode: event.target.value === "daily" ? "daily" : "interval" })}>
          <option value="interval">按间隔轮询</option>
          <option value="daily">每天固定时间</option>
        </SettingsSelect>
        {rule.mode === "interval"
          ? <SettingsInput label={sources[source] + "轮询间隔（分钟）"} type="number" min={1} max={1440} required
            value={rule.intervalMinutes || ""} onChange={event => setRule({ ...rule, intervalMinutes: Number(event.target.value) })} />
          : <SettingsInput label={sources[source] + "每日检查时间"} type="time" required value={rule.dailyTime}
            hint="使用这台电脑的本地时间" onChange={event => setRule({ ...rule, dailyTime: event.target.value })} />}
      </div>
      <button type="submit" className="btn">保存{source === "gmail" ? "邮箱" : "日历"}设置</button>
    </form>
  </SettingsSection>;
}

export default function DotsGoogleSettings({ rules, onSave }: {
  rules: DotsGoogleRules;
  onSave(source: DotsGoogleSource, rule: DotsGoogleRule): void;
}) {
  const api = window.api?.dotsGoogle;
  const [status, setStatus] = useState<DotsGoogleStatus>();
  const [pending, setPending] = useState<{ account: DotsGoogleAccount; type: "login" | "check" }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api) return;
    let active = true;
    const update = async () => {
      try {
        const next = await api.status();
        if (active) setStatus(next);
      } catch { if (active) setError("无法读取 Google 连接状态，请重启 MyBuddy 后重试。"); }
    };
    void update();
    const timer = setInterval(() => void update(), 3_000);
    return () => { active = false; clearInterval(timer); };
  }, [api]);

  const connect = async (account: DotsGoogleAccount, type: "login" | "check") => {
    if (!api || pending) return;
    setError("");
    setPending({ account, type });
    try { setStatus(await api[type](account)); }
    catch { setError("Google 连接请求失败，请重试。"); }
    finally { setPending(undefined); }
  };

  if (!api) return <p role="alert">当前 MyBuddy 主进程尚未加载 Google 连接功能，请重新启动。</p>;

  return <>
    <SettingsSection title="Google" description="分别登录个人账号和公司账号。邮箱与日历按各自的规则检查。">
      {dotsGoogleAccounts.map(account => {
        const state = status?.accounts[account];
        const busy = state?.busy ?? (pending?.account === account ? pending.type : undefined);
        const connection = state?.connection;
        const disabled = Boolean(pending || status?.accounts.personal.busy || status?.accounts.company.busy);
        return <div key={account} className="dots-google-account">
          <div>
            <strong>{labels[account]}</strong>
            <div className="settings-field-hint" role="status">{busy === "login" ? "请在浏览器里完成 Google 授权"
              : busy === "check" ? "正在检查连接…" : connection ? `已登录 · ${connection.email}` : status ? "尚未连接" : "正在读取连接状态…"}</div>
            {connection && <div className="settings-field-hint">
              Gmail {connection.access.gmail.ready ? "已验证" : "待验证"} · 日历 {connection.access.calendar.ready ? "已验证" : "待验证"}
            </div>}
            {state?.message && <div role="alert">{state.message}</div>}
          </div>
          <div className="dots-google-account-actions">
            <button className="btn" type="button" disabled={!status || disabled}
              aria-label={labels[account] + (connection ? "重新登录 Google" : "登录 Google")} onClick={() => void connect(account, "login")}>
              {connection ? "重新登录" : "登录 Google"}
            </button>
            {busy === "login"
              ? <button className="btn" type="button" onClick={() => void api.cancelLogin(account).catch(() => setError("取消失败，请重试。"))}>取消登录</button>
              : connection && <button className="btn" type="button" disabled={disabled} onClick={() => void connect(account, "check")}>检查连接</button>}
          </div>
        </div>;
      })}
      {error && <p role="alert">{error}</p>}
    </SettingsSection>
    {dotsGoogleSources.map(source => <RuleForm key={source + JSON.stringify(rules[source])} source={source}
      value={rules[source]} status={status} onSave={rule => onSave(source, rule)} />)}
  </>;
}
