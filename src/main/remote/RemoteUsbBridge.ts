import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RemoteUsbDevice, RemoteUsbStatus } from "../../../shared/src/remote-contract";

const APP_COMPONENT = "com.mybuddy.remote/.MainActivity";
const ADB_TIMEOUT_MS = 8_000;

interface AdbResult { stdout: string; stderr: string }

function quoteAndroidShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseAdbDevices(output: string): RemoteUsbDevice[] {
  const devices: RemoteUsbDevice[] = [];
  for (const rawLine of output.replace(/\r/g, "").split("\n").slice(1)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("*")) continue;
    const parts = line.split(/\s+/);
    const serial = parts.shift();
    const state = parts.shift();
    if (!serial || !state) continue;
    const meta: Record<string, string> = {};
    for (const part of parts) {
      const colon = part.indexOf(":");
      if (colon > 0) meta[part.slice(0, colon)] = part.slice(colon + 1);
    }
    devices.push({
      serial,
      state,
      product: meta.product,
      model: meta.model?.replace(/_/g, " "),
      device: meta.device,
      transportId: meta.transport_id,
    });
  }
  return devices;
}

export class RemoteUsbBridge {
  private resolvedAdb: string | undefined;

  async status(): Promise<RemoteUsbStatus> {
    const adbPath = await this.findAdb();
    if (!adbPath) {
      return { adbAvailable: false, devices: [], error: "未找到 Android Debug Bridge (adb)" };
    }
    try {
      const result = await this.run(adbPath, ["devices", "-l"]);
      return { adbAvailable: true, adbPath, devices: parseAdbDevices(result.stdout) };
    } catch (error) {
      return { adbAvailable: true, adbPath, devices: [], error: this.message(error) };
    }
  }

  async prepare(serial: string, port: number, pairingUrl: string): Promise<RemoteUsbDevice> {
    const status = await this.status();
    if (!status.adbAvailable || !status.adbPath) throw new Error(status.error || "未找到 adb");
    const device = status.devices.find((item) => item.serial === serial);
    if (!device) throw new Error("USB 设备已断开，请重新插线后刷新");
    if (device.state === "unauthorized") throw new Error("手机尚未授权 USB 调试，请解锁手机并允许此电脑调试");
    if (device.state !== "device") throw new Error(`USB 设备状态不可用：${device.state}`);

    const target = `tcp:${port}`;
    await this.run(status.adbPath, ["-s", serial, "reverse", target, target]);

    const packageCheck = await this.run(status.adbPath, ["-s", serial, "shell", "pm", "path", "com.mybuddy.remote"]);
    if (!packageCheck.stdout.includes("package:")) {
      await this.run(status.adbPath, ["-s", serial, "reverse", "--remove", target]).catch(() => undefined);
      throw new Error("手机上未安装 MyBuddy Remote Android App");
    }

    try {
      await this.run(status.adbPath, [
        "-s", serial,
        "shell", "am", "start", "-W",
        "-a", "android.intent.action.VIEW",
        "-d", quoteAndroidShell(pairingUrl),
        "-n", APP_COMPONENT,
      ], 12_000);
    } catch (error) {
      throw new Error(`USB 转发已建立，但无法自动打开 Android App：${this.message(error)}`);
    }
    return device;
  }

  private async findAdb(): Promise<string | null> {
    if (this.resolvedAdb) return this.resolvedAdb;
    const executable = process.platform === "win32" ? "adb.exe" : "adb";
    const candidates = new Set<string>();
    if (process.env.MYBUDDY_ADB_PATH?.trim()) candidates.add(process.env.MYBUDDY_ADB_PATH.trim());
    for (const sdk of [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME]) {
      if (sdk?.trim()) candidates.add(join(sdk.trim(), "platform-tools", executable));
    }
    if (process.platform === "win32") {
      if (process.env.LOCALAPPDATA) candidates.add(join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", executable));
      if (process.env.USERPROFILE) candidates.add(join(process.env.USERPROFILE, "AppData", "Local", "Android", "Sdk", "platform-tools", executable));
    }
    for (const entry of (process.env.PATH || "").split(delimiter).filter(Boolean)) candidates.add(join(entry, executable));
    candidates.add(process.platform === "win32" ? "adb.exe" : "adb");

    for (const candidate of candidates) {
      if ((candidate.includes("/") || candidate.includes("\\")) && !existsSync(candidate)) continue;
      try {
        await this.run(candidate, ["version"]);
        this.resolvedAdb = candidate;
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  private run(executable: string, args: string[], timeoutMs = ADB_TIMEOUT_MS): Promise<AdbResult> {
    return new Promise((resolve, reject) => {
      execFile(executable, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const result = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
        if (!error) return resolve(result);
        const detail = result.stderr.trim() || result.stdout.trim() || error.message;
        reject(new Error(detail));
      });
    });
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
