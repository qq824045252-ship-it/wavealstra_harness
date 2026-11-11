/** Real component; only application-store actions and the IPC boundary are fixture-owned. */
import { createRoot } from 'react-dom/client';
import WorkspaceFilesView from '../src/renderer/src/components/artifact/WorkspaceFilesView';
import { WORKSPACE_FILES_CHANGED_EVENT } from '../src/renderer/src/lib/workspaceFileDrag';
import '../src/renderer/src/styles/global.css';

const root = createRoot(document.getElementById('root')!);
let generation = 0;
const fixtureWindow = window as unknown as {
  workspaceSortFixture: { mount: () => void; refresh: () => void };
};
fixtureWindow.workspaceSortFixture = {
  mount: () => root.render(<WorkspaceFilesView key={++generation} />),
  refresh: () => window.dispatchEvent(new Event(WORKSPACE_FILES_CHANGED_EVENT)),
};
fixtureWindow.workspaceSortFixture.mount();
