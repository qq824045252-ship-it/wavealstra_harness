import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import ChatReadingDialog from "./ChatReadingDialog";

export default function ChatUploadPreview(): React.JSX.Element | null {
  const preview = useAppStore(state => state.page === "chat" && state.chatUploadPreview?.taskId === state.activeTaskId
    ? state.chatUploadPreview : undefined);
  if (!preview) return null;
  return <UploadImage key={preview.path} {...preview} onClose={() => useAppStore.setState({ chatUploadPreview: undefined })} />;
}

function UploadImage({ path, name, onClose }: { path: string; name: string; onClose: () => void }): React.JSX.Element {
  const [src, setSrc] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    const api = window.api;
    if (!api?.readWorkspaceFile) {
      setError("文件读取接口不可用");
      return;
    }
    void api.readWorkspaceFile(path, "").then(file => {
      if (current) setSrc(file.content);
    }).catch(reason => {
      if (current) setError(String(reason));
    });
    return () => { current = false; };
  }, [path]);
  return <ChatReadingDialog title={name} onClose={onClose}>
    {error ? <p role="alert">无法显示图片：{error}</p>
      : src ? <img className="chat-gallery-image" src={src} alt={name} onError={() => setError("文件无法解码")} />
      : <p role="status">正在读取图片…</p>}
  </ChatReadingDialog>;
}
