import { useRef, useState } from 'react';
import { Eye, ExternalLink, Download } from 'lucide-react';
import './SavedFileActions.css';
import type { SavedArtifactRequest } from '@shared/saved-artifact';

/** One immutable identity for both exports; preview retains the caller's existing behavior. */
export default function SavedFileActions({ request, name, onPreview }: { request?: SavedArtifactRequest; name?: string; onPreview: () => void }): React.JSX.Element {
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const run = async (kind: 'openSystem' | 'saveAs') => {
    if (busy.current) return;
    busy.current = true; setPending(true); setNotice('');
    try {
      const api = window.api?.savedArtifact;
      if (!request || !api?.[kind]) throw new Error('保存版本接口不可用，请重启 MyBuddy 后重试');
      if (kind === 'openSystem') {
        await api.openSystem(request);
        setNotice('已请求系统应用打开保存版本副本；外部应用不受内置预览隔离，网页依赖可能不完整。');
      } else {
        const result = await api.saveAs(request);
        if (!result.canceled) setNotice('已保存副本' + (result.path ? '：' + result.path : '') + (/\.html?$/i.test(request.name) ? '。仅保存此 HTML 文件，依赖资源不会一并导出；完整效果请使用内置预览。' : ''));
      }
    } catch (error) { setNotice('操作失败：' + (error instanceof Error ? error.message : String(error))); }
    finally { busy.current = false; setPending(false); }
  };
  const label = name ?? request?.name ?? '文件';
  return <>
    <span className="saved-file-actions" role="group" aria-label={`${label} 文件操作`}>
      <button type="button" aria-label={`预览 ${label}`} title="预览" onClick={onPreview}><Eye size={16} aria-hidden="true" /></button>
      <button type="button" disabled={!request || pending} aria-label={`系统方式打开 ${label}`} title="系统方式打开：单文件副本不受内置预览隔离，HTML依赖不会一并导出" onClick={() => void run('openSystem')}><ExternalLink size={16} aria-hidden="true" /></button>
      <button type="button" disabled={!request || pending} aria-label={`另存为 ${label}`} title="另存为：选择位置保存单文件副本，HTML依赖不会一并导出" onClick={() => void run('saveAs')}><Download size={16} aria-hidden="true" /></button>
    </span>
    {notice && <small className="saved-file-notice" role="status">{notice}</small>}
  </>;
}
