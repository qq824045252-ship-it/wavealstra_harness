import { useId, useMemo, useRef, useState } from 'react';
import type { BotMessageDto } from '@shared/bot-conversation';
import type { SavedArtifactRequest } from '@shared/saved-artifact';
import { extractMessageHtml } from '@shared/bot-message-html';
import SavedFileActions from './SavedFileActions';
import WorkFilePreview from './WorkFilePreview';

const MAX_HTML_BYTES = 8 * 1024 * 1024;

function HtmlSourceFile({ message, index, chars, bytes }: { message: BotMessageDto; index: number; chars: number; bytes: number }): React.JSX.Element {
  const previewId = useId();
  const [saved, setSaved] = useState<SavedArtifactRequest>();
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const save = async () => {
    if (busy.current || bytes > MAX_HTML_BYTES) return;
    busy.current = true; setPending(true); setError('');
    try {
      const api = window.api?.savedArtifact;
      if (!api?.saveMessageHtml) throw new Error('消息源码保存接口不可用，请重启 MyBuddy 后重试');
      const result = await api.saveMessageHtml({ botId: message.botId, conversationId: message.conversationId,
        messageId: message.messageId, index, expectedRevision: message.messageRevision });
      setSaved(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busy.current = false; setPending(false); }
  };
  return <section className="bot-result-attachments" aria-label={`消息中的 HTML ${index + 1}`}>
    <strong>{saved?.name ?? `HTML 源码 ${index + 1}`}</strong>
    <p>{saved ? '已将这条消息的完整源码保存为文件；不是后台任务重新生成的成果。' : `消息包含完整 HTML（${chars.toLocaleString()} 字符），尚未保存为文件。`}</p>
    {!saved ? <button type="button" disabled={pending || bytes > MAX_HTML_BYTES} onClick={() => void save()}>{pending ? '正在保存…' : '将消息源码保存为 HTML 文件'}</button>
      : <SavedFileActions request={saved} previewId={previewId} previewExpanded={preview} onPreview={() => setPreview(value => !value)} />}
    {bytes > MAX_HTML_BYTES && <p role="alert">HTML 超过 8 MiB 保存与预览大小限制，原消息源码仍保留，未生成文件。</p>}
    {error && <p role="alert">保存失败：{error}</p>}
    {saved && preview && <WorkFilePreview cardControlled id={previewId} file={{ref:saved.snapshotPath,name:saved.name,openPath:saved.snapshotPath,previewManifestPath:saved.manifestPath ?? null}} target={saved.snapshotPath} onClose={() => setPreview(false)} />}
  </section>;
}

/** Do not mount source text in the DOM or parse/highlight it as Markdown. The host
 * re-reads the persisted message; this view only identifies an explicit export. */
export default function BotMessageHtmlFiles({ message }: { message: BotMessageDto }): React.JSX.Element | null {
  const documents = useMemo(() => message.role === 'assistant' && message.status === 'completed'
    ? extractMessageHtml(message.text).map(document => ({ ...document, bytes: new TextEncoder().encode(document.source).byteLength })) : [], [message.role, message.status, message.text]);
  if (!documents.length) return null;
  return <>{documents.map(document => <HtmlSourceFile key={`${message.messageId}:${message.messageRevision ?? 0}:${document.index}`} message={message} index={document.index} chars={document.source.length} bytes={document.bytes} />)}</>;
}
