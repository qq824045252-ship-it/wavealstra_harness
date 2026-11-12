export * from "./arch-electron-stub";
// Synthetic test account only; never used by the application or a real profile.
export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (value: string) => Buffer.from(`synthetic:${value}`),
  decryptString: (value: Buffer) => value.toString().slice("synthetic:".length),
};
