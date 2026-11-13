import { useRef, useState } from 'react';
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
  return <>
    <button type="button" aria-label={`预览 ${name ?? request?.name ?? '文件'}`} onClick={onPreview}>预览</button>
    <button type="button" disabled={!request || pending} title="使用系统默认应用打开单文件副本；不受内置预览隔离，HTML依赖不会一并导出" onClick={() => void run('openSystem')}>系统方式打开</button>
    <button type="button" disabled={!request || pending} title="选择位置另存为单文件副本；HTML依赖不会一并导出" onClick={() => void run('saveAs')}>保存</button>
    {notice && <small role="status">{notice}</small>}
  </>;
}
