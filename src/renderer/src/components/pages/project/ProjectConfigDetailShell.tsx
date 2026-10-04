/**
 * Project Config Detail 统一壳（实施规划 §5）。
 * Header（返回/收起）在 Rail 层（project-config-rail-head）；
 * 本组件负责：说明 / Body / 错误 / Footer（取消·保存）/ sticky footer。
 * 五个 Detail 共用同一套保存流程，禁止各自实现一套（§6/§19）。
 */
interface Props {
  title: string;
  description: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** 额外禁用保存的原因（如正在加载 Registry） */
  saveDisabledReason?: string | null;
  onSave: () => void;
  onCancel: () => void;
  /** Footer 左侧附加操作（如「管理所有连接器」链接） */
  footerExtra?: React.ReactNode;
  children: React.ReactNode;
}

export default function ProjectConfigDetailShell({
  title,
  description,
  dirty,
  saving,
  error,
  saveDisabledReason,
  onSave,
  onCancel,
  footerExtra,
  children,
}: Props): React.JSX.Element {
  const saveDisabled = saving || !dirty || Boolean(saveDisabledReason);
  return (
    <div className="project-config-detail">
      <div className="project-config-detail-head">
        <h4>{title}</h4>
        <p className="project-config-detail-desc">{description}</p>
      </div>
      <div className="project-config-detail-body">{children}</div>
      <div className="project-config-detail-footer">
        {error && <div className="project-config-detail-error" role="alert">{error}</div>}
        <div className="project-config-detail-footer-row">
          <div className="project-config-detail-footer-extra">{footerExtra}</div>
          <div className="project-config-detail-footer-actions">
            <button type="button" className="btn" onClick={onCancel} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={onSave}
              disabled={saveDisabled}
              title={saveDisabledReason ?? undefined}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
