import { contextBridge, ipcRenderer } from "electron";
import { FileDialogIpc, type FileDialogApi } from "../shared/file-dialog";

contextBridge.exposeInMainWorld("fileDialog", {
  start: () => ipcRenderer.invoke(FileDialogIpc.start),
  list: (directory) => ipcRenderer.invoke(FileDialogIpc.list, directory),
  submit: (selection) => ipcRenderer.invoke(FileDialogIpc.submit, selection),
  createFolder: (directory, name) => ipcRenderer.invoke(FileDialogIpc.createFolder, directory, name),
  cancel: () => ipcRenderer.send(FileDialogIpc.cancel),
} satisfies FileDialogApi);
