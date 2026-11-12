import type { BotOrganizationSummaryDto } from "@shared/bot-organization";
import { IconBot, IconChevronRight } from "@/components/common/icons";
import "./BotOrganizationActivity.css";

const stepLabels = { discovery: "查找", creation: "创建", configuration: "配置", contact: "联系" };
const receiptLabels = { started: "已开始", succeeded: "已完成", failed: "失败", unknown: "待核对" };

function activityLabel(item: BotOrganizationSummaryDto): string {
  if (item.kind === "discovery") {
    switch (item.status) {
      case "running": return "正在查找 Bot";
      case "succeeded": return item.matchedBotCount === null ? "已查找 Bot" : `查到 ${item.matchedBotCount} 位其他 Bot`;
      case "failed": return "Bot 查找失败";
      case "unknown": return "查找状态待核对";
    }
  }
  switch (item.phase) {
    case "creating": return "正在创建 Bot";
    case "creation_failed": return "Bot 创建失败";
    case "configuring": return "正在配置 Bot";
    case "configuration_failed": return "Bot 配置失败";
    case "ready": return "Bot 已就绪，尚未接单";
    case "contacting": return "正在联系 Bot";
    case "contact_unknown": return "联系结果待核对";
    case "contact_failed": return "联系失败，可继续";
    case "linked": return "已接入协作";
  }
}

function RecordedTime({ value }: { value: number | null }): React.JSX.Element {
  return value === null ? <span>未记录</span> : <time dateTime={new Date(value).toISOString()}>
    {new Date(value).toLocaleString("zh-CN", { hour12: false })}
  </time>;
}

function ManagementReceipts({ item }: { item: BotOrganizationSummaryDto }): React.JSX.Element {
  const times = item.kind === "discovery" ? [{ label: "查找时间", value: item.searchedAt }] : [
    { label: "查找时间", value: item.times.searchedAt },
    { label: "创建时间", value: item.times.botCreatedAt },
    { label: "配置时间", value: item.times.configuredAt },
    { label: "开始联系", value: item.times.contactStartedAt },
    { label: "关联协作", value: item.times.linkedAt },
  ];
  return <div className="bot-organization-detail">
    {item.summary && <p className="bot-organization-description">{item.summary}</p>}
    <dl className="bot-organization-times">{times.map(({ label, value }) => <div key={label}>
      <dt>{label}</dt><dd><RecordedTime value={value} /></dd>
    </div>)}</dl>
    <p className="bot-organization-receipt-count">{item.totalReceipts > item.receipts.length
      ? `显示最近 ${item.receipts.length} 条，共 ${item.totalReceipts} 条管理回执`
      : `${item.totalReceipts} 条管理回执`}</p>
    {item.receipts.length ? <ol className="bot-organization-receipts">{item.receipts.map(receipt => <li
      key={receipt.receiptId} data-organization-receipt={receipt.receiptId} data-receipt-status={receipt.status}>
      <div className="bot-organization-receipt-heading"><span>{stepLabels[receipt.step]} · {receiptLabels[receipt.status]}</span>
        <RecordedTime value={receipt.createdAt} /></div>
      <p>{receipt.summary}</p>
    </li>)}</ol> : <p className="bot-organization-no-receipts">尚无已记录的管理回执</p>}
  </div>;
}

export function BotOrganizationActivity({ organizations, onOpenCollaboration }: {
  organizations?: BotOrganizationSummaryDto[];
  onOpenCollaboration?: (collaborationId: string) => void;
}): React.JSX.Element | null {
  if (!organizations?.length) return null;
  const latest = new Map<string, BotOrganizationSummaryDto>();
  for (const item of organizations) {
    const previous = latest.get(item.organizationId);
    if (!previous || item.updatedAt >= previous.updatedAt) latest.set(item.organizationId, item);
  }
  return <section className="bot-organization-activity" aria-label="Bot 组织记录">
    {[...latest.values()].map(item => {
      const label = activityLabel(item);
      const targetName = item.kind === "intent" ? item.target?.displayName : undefined;
      return <div key={item.organizationId} className="bot-organization-item" data-organization-id={item.organizationId}
        data-organization-phase={item.kind === "discovery" ? item.status : item.phase}>
        {item.kind === "intent" && item.phase === "linked" && onOpenCollaboration ? <>
          <button type="button" className="bot-organization-linked" onClick={() => onOpenCollaboration(item.collaborationId)}>
            <IconBot size={14} /><span>{label} · {targetName}</span><IconChevronRight size={14} />
          </button>
          <details className="bot-organization-record"><summary>查看查找与配置回执</summary><ManagementReceipts item={item} /></details>
        </> : <details className="bot-organization-record"><summary>
          <IconBot size={14} /><span>{label}{targetName ? ` · ${targetName}` : ""}</span>
        </summary><ManagementReceipts item={item} /></details>}
      </div>;
    })}
  </section>;
}
