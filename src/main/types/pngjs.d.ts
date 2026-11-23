declare module "pngjs" {
  export const PNG: {
    sync: {
      read(bytes: Buffer, options?: { checkCRC?: boolean }): { width: number; height: number; data: Buffer };
      write(image: { width: number; height: number; data: Buffer }): Buffer;
    };
  };
}
