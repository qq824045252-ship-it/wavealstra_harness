import { statSync } from "node:fs";
import { dirname, isAbsolute, win32 } from "node:path";

/** An explicit executable path can be exposed to task shells. Otherwise use the inherited PATH. */
export function configureOfficeCli(options: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
} = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const binary = env.MYBUDDY_OFFICECLI?.trim();
  if (!binary) return undefined;
  if (!(platform === "win32" ? win32.isAbsolute(binary) : isAbsolute(binary)) || !statSync(binary).isFile()) {
    throw new Error("MYBUDDY_OFFICECLI 必须指向本地可执行文件");
  }
  const directory = (platform === "win32" ? win32.dirname : dirname)(binary);
  const pathKeys = Object.keys(env).filter(key => platform === "win32" ? key.toLowerCase() === "path" : key === "PATH");
  const oldPath = pathKeys.map(key => env[key]).filter(Boolean).join(platform === "win32" ? ";" : ":");
  for (const key of pathKeys) delete env[key];
  const sep = platform === "win32" ? ";" : ":";
  env.PATH = [directory, ...oldPath.split(sep).filter(part => part && part !== directory)].join(sep);
  env.MYBUDDY_OFFICECLI = binary;
  // Task commands are short lived; don't leave untracked OfficeCLI resident processes behind.
  env.OFFICECLI_NO_AUTO_RESIDENT ??= "1";
  // Self-updating can replace the single-file executable while another command
  // is loading assemblies.
  env.OFFICECLI_SKIP_UPDATE ??= "1";
  return binary;
}
