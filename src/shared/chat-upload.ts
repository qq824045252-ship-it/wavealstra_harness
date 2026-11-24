/** Recover the display name of a file placed in MyBuddy's chat upload directory. */
export function chatUploadName(path: string): string | undefined {
  return /(?:^|[\\/])\.mybuddy[\\/]uploads[\\/]\d{13}-[a-f0-9]{8}-([^\\/]+)$/i.exec(path)?.[1];
}
