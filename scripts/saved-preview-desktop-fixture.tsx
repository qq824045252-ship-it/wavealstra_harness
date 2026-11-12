import { createRoot } from 'react-dom/client';
import { WorkFiles, type WorkFile } from '../src/renderer/src/components/pages/BotWorkResult';
import '../src/renderer/src/styles/global.css';
import '../src/renderer/src/styles/markdown.css';
import '../src/renderer/src/components/pages/BotWorkspacePage.css';
const root = createRoot(document.getElementById('root')!);
Object.assign(window, { savedPreviewFixture: { render(files: WorkFile[]) {
 root.render(<div style={{padding:24,maxWidth:1000,margin:'auto'}}><h1>保存版本成果</h1><WorkFiles files={files}/><textarea aria-label="草稿" defaultValue="保留这段草稿"/></div>);
} } });
