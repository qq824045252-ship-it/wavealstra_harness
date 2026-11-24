import { access } from "node:fs/promises";
import type { FileDialogPlace } from "../../shared/file-dialog";
import { currentPlatformId } from "./index";

export async function fileDialogDrivePlaces(): Promise<FileDialogPlace[]> {
  if (currentPlatformId !== "windows") return [];
  const disks = await Promise.all(Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").map(async (letter) => {
    const path = letter + ":\\";
    try {
      await access(path);
      return { label: letter + ":", path };
    } catch {
      return null;
    }
  }));
  return disks.filter((disk) => disk !== null);
}

export function isFileDialogPath(path: string): boolean {
  return currentPlatformId !== "windows" || !/^\\\\[.?]\\/.test(path);
}

export function isFileDialogName(name: string): boolean {
  if (/[\u0000-\u001f]/.test(name)) return false;
  if (currentPlatformId !== "windows") return true;
  return !/[<>:"|?*]/.test(name) && !/[. ]$/.test(name)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name);
}
