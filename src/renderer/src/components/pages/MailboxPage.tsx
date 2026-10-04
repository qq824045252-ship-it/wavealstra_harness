import { IconBell } from "@/components/common/icons";

export default function MailboxPage(): React.JSX.Element {
  return (
    <div className="page-scroll">
      <div className="page-container narrow">
        <div className="page-title">智能体邮箱</div>
        <div className="page-sub">安全高效地使用 MyBuddy 收发邮件 · 由 Agent Mail 提供服务</div>

        <div className="mailbox-card">
          <span className="mailbox-icon">
            <IconBell size={20} />
          </span>
          <div className="mailbox-info">
            <div className="mailbox-title">开通 MyBuddy 智能体邮箱</div>
            <div className="mailbox-desc">
              智能体邮箱是为你的 MyBuddy 创建的邮箱。你可以在 MyBuddy 对话中接收或发送邮件。
            </div>
            <div className="mailbox-agreement">
              开通即代表同意 <button className="link-btn">《Agent Mail 服务协议》</button> 和{" "}
              <button className="link-btn">《隐私保护指引》</button>
            </div>
          </div>
          <button className="btn primary">确认开通</button>
        </div>
      </div>
    </div>
  );
}
