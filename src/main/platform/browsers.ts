import { execFile } from "node:child_process";
import { currentPlatformId, type PlatformId } from "./index";

/**
 * 浏览器集成（Cookie 提取 / 打开浏览器）的平台边界。
 *
 * web-access 里的 Chrome/Chromium Cookie 解密与 `open`/`cmd start`/`xdg-open`
 * 分支全部收敛到这里；业务层不再 import `node:os` 的 `platform()`。
 */
export interface BrowserConfig {
	name: string;
	baseDir: string;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
}

/** macOS Chromium 系浏览器的 profile 根与 Keychain 服务名。 */
export const MACOS_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Helium", baseDir: "Library/Application Support/net.imput.helium", keychainService: "Helium Storage Key", keychainAccount: "Helium" },
	{ name: "Chrome", baseDir: "Library/Application Support/Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
	{ name: "Arc", baseDir: "Library/Application Support/Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" },
];

/** Linux Chromium 系浏览器（密码走 secret-tool）。 */
export const LINUX_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
	{ name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
];

/** 该平台可用于 Cookie 提取的浏览器配置；Windows 暂不支持（空数组）。 */
export function browserCookieConfigs(platform: PlatformId = currentPlatformId): BrowserConfig[] {
	if (platform === "macos") return MACOS_BROWSER_CONFIGS;
	if (platform === "linux") return LINUX_BROWSER_CONFIGS;
	return [];
}

export function supportsBrowserCookieExtraction(platform: PlatformId = currentPlatformId): boolean {
	return browserCookieConfigs(platform).length > 0;
}

/** Chromium v20+ 密码 KDF 迭代次数：macOS 1003，其它平台 1。 */
export function browserCookieKeyIterations(platform: PlatformId = currentPlatformId): number {
	return platform === "macos" ? 1003 : 1;
}

/** 打开 URL 的 argv（平台差异集中在这里，供 web-access 的 pi.exec 使用）。 */
export function browserOpenCommand(
	platform: PlatformId = currentPlatformId,
	url: string,
): { command: string; args: string[] } {
	if (platform === "macos") return { command: "open", args: [url] };
	if (platform === "windows") return { command: "cmd", args: ["/c", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

export interface PasswordLookupResult {
	ok: boolean;
	stdout: string;
}

/** 密码查询执行器（测试可注入，避免真的拉起 security/secret-tool）。 */
export type PasswordLookup = (command: string, args: string[]) => Promise<PasswordLookupResult>;

function execPasswordLookup(command: string, args: string[]): Promise<PasswordLookupResult> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 5000 }, (error, stdout) => {
			if (error) { resolve({ ok: false, stdout: "" }); return; }
			resolve({ ok: true, stdout });
		});
	});
}

const browserPasswordCache = new Map<string, Promise<string | null>>();

/**
 * 读取浏览器 Cookie 加密密码（逻辑自 web-access/chrome-cookies.ts 逐字搬迁）：
 * - macOS：`security find-generic-password -w -a <account> -s <service>`
 * - Linux：`secret-tool lookup application <app>`（失败回落 Chromium 的 "peanuts"）
 * - Windows：null（不支持）
 * 成功的密码按 `<platform>:<browser>` 缓存；不可缓存的结果（如 secret-tool 回落）不缓存。
 */
export function readBrowserCookiePassword(
	config: BrowserConfig,
	platform: PlatformId = currentPlatformId,
	lookup: PasswordLookup = execPasswordLookup,
): Promise<string | null> {
	const cacheKey = `${platform}:${config.name}`;
	const cached = browserPasswordCache.get(cacheKey);
	if (cached) return cached;

	let passwordResult: Promise<{ password: string | null; cacheable: boolean }>;
	if (platform === "macos") {
		passwordResult = config.keychainAccount && config.keychainService
			? lookup("security", ["find-generic-password", "-w", "-a", config.keychainAccount, "-s", config.keychainService])
				.then(({ ok, stdout }) => {
					const password = ok ? (stdout.trim() || null) : null;
					return { password, cacheable: Boolean(password) };
				})
			: Promise.resolve({ password: null, cacheable: false });
	} else if (platform === "linux") {
		passwordResult = config.secretToolApp
			? lookup("secret-tool", ["lookup", "application", config.secretToolApp]).then(({ ok, stdout }) => {
				if (!ok) return { password: "peanuts", cacheable: false };
				const password = stdout.trim();
				return password
					? { password, cacheable: true }
					: { password: "peanuts", cacheable: false };
			})
			: Promise.resolve({ password: "peanuts", cacheable: true });
	} else {
		passwordResult = Promise.resolve({ password: null, cacheable: false });
	}

	const passwordPromise = passwordResult.then(({ password, cacheable }) => {
		if (!cacheable) browserPasswordCache.delete(cacheKey);
		return password;
	}, (error) => {
		browserPasswordCache.delete(cacheKey);
		throw error;
	});
	browserPasswordCache.set(cacheKey, passwordPromise);
	return passwordPromise;
}

/** 测试用：清空密码缓存。 */
export function resetBrowserCookiePasswordCache(): void {
	browserPasswordCache.clear();
}
