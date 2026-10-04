import { contextBridge, ipcRenderer } from "electron";

// No general app API or page access is exposed to this isolated comment window.
contextBridge.exposeInMainWorld("selectionPopover", {
  action: (action: "edit" | "cancel" | "add" | "comment", text?: string): void => {
    ipcRenderer.send("selection-popover:action", { action, text });
  },
});
