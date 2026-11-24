export const FileDialogIpc = {
  start: "file-dialog:start",
  list: "file-dialog:list",
  submit: "file-dialog:submit",
  createFolder: "file-dialog:create-folder",
  cancel: "file-dialog:cancel",
} as const;

export interface FileDialogPlace {
  label: string;
  path: string;
}

export interface FileDialogEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  hidden: boolean;
}

export interface FileDialogDirectory {
  path: string;
  parent: string | null;
  entries: FileDialogEntry[];
}

export interface FileDialogState {
  title: string;
  confirmLabel: string;
  mode: "open-file" | "open-directory" | "save";
  multiple: boolean;
  showHidden: boolean;
  theme: "light" | "dark";
  initialName: string;
  filters: Array<{ name: string; extensions: string[] }>;
  places: FileDialogPlace[];
  directory: FileDialogDirectory;
}

export type FileDialogSelection =
  | { kind: "entries"; paths: string[] }
  | { kind: "save"; directory: string; name: string; filter: number; overwrite: boolean };

export type FileDialogSubmission = { state: "accepted" } | { state: "overwrite"; name: string };

export interface FileDialogApi {
  start(): Promise<FileDialogState>;
  list(directory: string): Promise<FileDialogDirectory>;
  submit(selection: FileDialogSelection): Promise<FileDialogSubmission>;
  createFolder(directory: string, name: string): Promise<FileDialogDirectory>;
  cancel(): void;
}
