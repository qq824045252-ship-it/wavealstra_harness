import React from "react";
import ReactDOM from "react-dom/client";
import { applyTheme, getInitialTheme, syncNativeTheme } from "@/lib/theme";
import { useAppStore } from "@/store/appStore";
import ErrorBoundary from "@/components/ErrorBoundary";
import App from "./App";
import "./styles/global.css";
import "./styles/systemTypography.css";

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
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
