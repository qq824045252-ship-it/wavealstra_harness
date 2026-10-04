import { Component, type ErrorInfo, type ReactNode } from "react";
import { IconAlert, IconRefresh } from "@/components/common/icons";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 渲染树兜底：未捕获的 render 错误会把整棵 React 卸掉，只剩 --bg 底色（白屏）。
 * 这里拦住错误并给出刷新，避免用户只能杀进程。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] ErrorBoundary", error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="fatal-recover" role="alert">
        <div className="placeholder-icon">
          <IconAlert size={28} />
        </div>
        <div className="page-title">界面出错了</div>
        <p className="page-sub">
          {this.state.error.message || "渲染过程中发生未捕获错误。刷新后可恢复，未保存的输入可能丢失。"}
        </p>
        <button type="button" className="btn primary" onClick={this.reload}>
          <IconRefresh size={14} />
          刷新
        </button>
      </div>
    );
  }
}
