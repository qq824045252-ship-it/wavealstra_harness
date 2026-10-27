import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";

/**
 * Glimpse 桌面窗口（macOS 上的 Search Curator 浮窗）。
 *
 * 这是 macOS 专属能力：`glimpseui` 是可选依赖，加载失败即回退到浏览器打开。
 * 非 macOS 平台 `getPlatformGlimpseOpen()` 返回 null，web-access 走 browserOpenCommand。
 */
export interface GlimpseWindow {
	on(event: "closed", handler: () => void): void;
	on(event: "message", handler: (data: unknown) => void): void;
	on(event: "ready", handler: (info: { screen?: { visibleHeight?: number } }) => void): void;
	close(): void;
	_write(obj: Record<string, unknown>): void;
}

export type GlimpseOpen = (html: string, opts: Record<string, unknown>) => GlimpseWindow;

let glimpseOpen: GlimpseOpen | null | undefined;

/** 解析可选的 glimpseui 入口：本地依赖优先，其次 npm 全局安装。 */
export function findGlimpseMjs(): string | null {
	try {
		const req = createRequire(import.meta.url);
		return req.resolve("glimpseui");
	} catch {
		// Optional dependency.
	}
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
		const entry = join(globalRoot, "glimpseui", "src", "glimpse.mjs");
		if (existsSync(entry)) return entry;
	} catch {
		// npm may be unavailable.
	}
	return null;
}

export async function getGlimpseOpen(): Promise<GlimpseOpen | null> {
	if (glimpseOpen !== undefined) return glimpseOpen;
	const resolved = findGlimpseMjs();
	if (resolved) {
		try {
			glimpseOpen = (await import(resolved)).open as GlimpseOpen;
			return glimpseOpen;
		} catch {}
	}
	glimpseOpen = null;
	return glimpseOpen;
}

/** 平台版入口：只有 macOS 才尝试加载 Glimpse；其它平台返回 null（调用方回退浏览器）。 */
export function getPlatformGlimpseOpen(platform: PlatformId = currentPlatformId): Promise<GlimpseOpen | null> {
	return platform === "macos" ? getGlimpseOpen() : Promise.resolve(null);
}

export function openInGlimpse(open: GlimpseOpen, url: string, title: string): GlimpseWindow {
	const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
	const win = open(shellHTML, {
		width: 800,
		height: 900,
		title,
	});

	let maxHeight = 1200;
	win.on("ready", (info) => {
		const visibleHeight = info?.screen?.visibleHeight;
		if (typeof visibleHeight === "number" && visibleHeight > 0) {
			maxHeight = Math.floor(visibleHeight * 0.85);
		}
	});
	win.on("message", (data) => {
		if (!data || typeof data !== "object") return;
		const msg = data as Record<string, unknown>;
		if (msg.type !== "resize" || typeof msg.height !== "number") return;
		const clamped = Math.max(400, Math.min(Math.round(msg.height), maxHeight));
		win._write({ type: "resize", width: 800, height: clamped });
	});

	return win;
}
