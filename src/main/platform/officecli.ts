import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import pin from "../../shared/officecli-builds.json";

/** Only the shipped binary enters PATH. Never resolve/download a global install. */
export function configureOfficeCli(options: {
  appRoot: string; resourcesPath: string; packaged: boolean;
  platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv;
}): string | undefined {
  const platform = options.platform ?? process.platform;
  const key = `${platform}-${options.arch ?? process.arch}` as keyof typeof pin.builds;
  const build = pin.builds[key];
  if (!build) return undefined;
  const binary = options.packaged
    ? join(options.resourcesPath, "officecli", build.binary)
    : join(options.appRoot, "vendor", "officecli", key, build.binary);
  if (!existsSync(binary)) throw new Error(`Bundled OfficeCLI missing: ${binary}`);
  const env = options.env ?? process.env;
  const pathKeys = Object.keys(env).filter(key => platform === "win32" ? key.toLowerCase() === "path" : key === "PATH");
  const oldPath = pathKeys.map(key => env[key]).filter(Boolean).join(platform === "win32" ? ";" : ":");
  for (const key of pathKeys) delete env[key];
  const sep = platform === "win32" ? ";" : ":";
  env.PATH = [dirname(binary), ...oldPath.split(sep).filter(part => part && part !== dirname(binary))].join(sep);
  env.MYBUDDY_OFFICECLI = binary;
  // Task commands are short lived; don't leave untracked OfficeCLI resident processes behind.
  env.OFFICECLI_NO_AUTO_RESIDENT = "1";
  // Self-updating can replace the single-file executable while another command
  // is loading assemblies. MyBuddy ships and updates the binary separately.
  env.OFFICECLI_SKIP_UPDATE = "1";
  return binary;
}
