import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { applyTheme, getInitialTheme, syncNativeTheme } from "@/lib/theme";
import { useAppStore } from "@/store/appStore";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ScopedLibraryWorkbench, type ScopedLibraryManagerProps } from "@/components/pages/library/ScopedLibraryManager";
import App from "./App";
import "./styles/global.css";
import "./styles/systemTypography.css";
import "./styles/desktop-modules-design.css";
import "./styles/artifact-design.css";
import "./styles/chat-design.css";

const LibraryWorkbench = lazy(() => import("@/components/pages/library/LibraryWorkbench"));

function EmbeddedWorkbench(props: ScopedLibraryManagerProps): React.JSX.Element {
  return <Suspense fallback={<div role="status">正在加载笔记…</div>}><LibraryWorkbench {...props} /></Suspense>;
}
const initialTheme = getInitialTheme();
applyTheme(initialTheme);
useAppStore.setState({ theme: initialTheme });

if (window.api?.onThemeRequest) {
  window.api.onThemeRequest(() => syncNativeTheme());
}

window.addEventListener("error", (event) => {
  console.error("[renderer] window error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[renderer] unhandledrejection", event.reason);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ScopedLibraryWorkbench.Provider value={EmbeddedWorkbench}><App /></ScopedLibraryWorkbench.Provider>
    </ErrorBoundary>
  </React.StrictMode>,
);
