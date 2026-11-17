/** Navigation is injected by the owning task; never fall back to an OS opener. */
export interface WebAccessBrowserOptions {
  openInApp?: (url: string) => Promise<void>;
}

export async function openCuratorInApp(url: string, options: WebAccessBrowserOptions): Promise<void> {
  if (!options.openInApp) {
    throw new Error("MyBuddy sidebar browser is unavailable; external browsers require the user's explicit open action.");
  }
  await options.openInApp(url);
}
