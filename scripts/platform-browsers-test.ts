import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	LINUX_BROWSER_CONFIGS,
	MACOS_BROWSER_CONFIGS,
	browserCookieConfigs,
	browserCookieKeyIterations,
	browserOpenCommand,
	readBrowserCookiePassword,
	resetBrowserCookiePasswordCache,
	supportsBrowserCookieExtraction,
	type BrowserConfig,
	type PasswordLookup,
} from "../src/main/platform/browsers";
import {
	getPlatformGlimpseOpen,
	openInGlimpse,
	type GlimpseWindow,
} from "../src/main/platform/glimpse";

/**
 * 浏览器 Cookie / Glimpse / 打开浏览器命令的平台边界测试。
 * 全部注入 platform 与 lookup，不依赖真实的 security/secret-tool/npm。
 */

const results: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	await fn();
	results.push(name);
	console.log(`PASS ${name}`);
}

async function main(): Promise<void> {
	/* ------------------------------------------------------------------ */
	/* 1. browserCookieConfigs 三平台矩阵                                   */
	/* ------------------------------------------------------------------ */

	await check("browser cookie configs: macOS = Helium/Chrome/Arc", () => {
		const configs = browserCookieConfigs("macos");
		assert.equal(configs, MACOS_BROWSER_CONFIGS);
		assert.deepEqual(configs.map((config) => config.name), ["Helium", "Chrome", "Arc"]);
		for (const config of configs) {
			assert.match(config.baseDir, /^Library\/Application Support\//);
			assert.ok(config.keychainService, `${config.name} needs keychainService`);
			assert.ok(config.keychainAccount, `${config.name} needs keychainAccount`);
			assert.equal(config.secretToolApp, undefined);
		}
		assert.equal(supportsBrowserCookieExtraction("macos"), true);
	});

	await check("browser cookie configs: Linux = Chromium/Chrome via secret-tool", () => {
		const configs = browserCookieConfigs("linux");
		assert.equal(configs, LINUX_BROWSER_CONFIGS);
		assert.deepEqual(configs.map((config) => config.name), ["Chromium", "Chrome"]);
		for (const config of configs) {
			assert.match(config.baseDir, /^\.config\//);
			assert.ok(config.secretToolApp, `${config.name} needs secretToolApp`);
			assert.equal(config.keychainService, undefined);
		}
		assert.equal(supportsBrowserCookieExtraction("linux"), true);
	});

	await check("browser cookie configs: Windows is unsupported (empty matrix)", () => {
		assert.deepEqual(browserCookieConfigs("windows"), []);
		assert.equal(supportsBrowserCookieExtraction("windows"), false);
	});

	/* ------------------------------------------------------------------ */
	/* 2. KDF 迭代次数                                                     */
	/* ------------------------------------------------------------------ */

	await check("cookie key iterations: macOS 1003, Linux/Windows 1", () => {
		assert.equal(browserCookieKeyIterations("macos"), 1003);
		assert.equal(browserCookieKeyIterations("linux"), 1);
		assert.equal(browserCookieKeyIterations("windows"), 1);
	});

	/* ------------------------------------------------------------------ */
	/* 3. 打开浏览器命令 argv                                              */
	/* ------------------------------------------------------------------ */

	await check("browserOpenCommand argv for three platforms", () => {
		const url = "https://gemini.google.com/app";
		assert.deepEqual(browserOpenCommand("macos", url), { command: "open", args: [url] });
		assert.deepEqual(browserOpenCommand("windows", url), { command: "cmd", args: ["/c", "start", "", url] });
		assert.deepEqual(browserOpenCommand("linux", url), { command: "xdg-open", args: [url] });
	});

	/* ------------------------------------------------------------------ */
	/* 4. 浏览器 Cookie 密码：平台分派 / 缓存 / 回落                        */
	/* ------------------------------------------------------------------ */

	await check("Windows password lookup is null without invoking the lookup", async () => {
		resetBrowserCookiePasswordCache();
		let calls = 0;
		const lookup: PasswordLookup = async () => { calls += 1; return { ok: true, stdout: "unexpected" }; };
		assert.equal(await readBrowserCookiePassword(MACOS_BROWSER_CONFIGS[1], "windows", lookup), null);
		assert.equal(calls, 0);
	});

	await check("macOS password uses security find-generic-password and caches success", async () => {
		resetBrowserCookiePasswordCache();
		const invocations: Array<[string, string[]]> = [];
		const lookup: PasswordLookup = async (command, args) => {
			invocations.push([command, args]);
			return { ok: true, stdout: "  s3cr3t\n" };
		};
		const chrome = MACOS_BROWSER_CONFIGS.find((config) => config.name === "Chrome")!;
		assert.equal(await readBrowserCookiePassword(chrome, "macos", lookup), "s3cr3t");
		assert.deepEqual(invocations[0], ["security", ["find-generic-password", "-w", "-a", "Chrome", "-s", "Chrome Safe Storage"]]);
		// 成功密码进缓存：第二次不再调用 lookup（用一个会抛错的 lookup 证明命中缓存）
		const exploding: PasswordLookup = async () => { throw new Error("must not be called"); };
		assert.equal(await readBrowserCookiePassword(chrome, "macos", exploding), "s3cr3t");
		assert.equal(invocations.length, 1);
	});

	await check("macOS password failure returns null and is not cached", async () => {
		resetBrowserCookiePasswordCache();
		const chrome = MACOS_BROWSER_CONFIGS.find((config) => config.name === "Chrome")!;
		let calls = 0;
		const failing: PasswordLookup = async () => { calls += 1; return { ok: false, stdout: "" }; };
		assert.equal(await readBrowserCookiePassword(chrome, "macos", failing), null);
		assert.equal(await readBrowserCookiePassword(chrome, "macos", failing), null);
		assert.equal(calls, 2, "failed password must not be cached");
	});

	await check("Linux password uses secret-tool; empty output falls back to peanuts", async () => {
		resetBrowserCookiePasswordCache();
		const chromium = LINUX_BROWSER_CONFIGS.find((config) => config.name === "Chromium")!;
		const invocations: Array<[string, string[]]> = [];
		const found: PasswordLookup = async (command, args) => {
			invocations.push([command, args]);
			return { ok: true, stdout: "linux-pw\n" };
		};
		assert.equal(await readBrowserCookiePassword(chromium, "linux", found), "linux-pw");
		assert.deepEqual(invocations[0], ["secret-tool", ["lookup", "application", "chromium"]]);

		resetBrowserCookiePasswordCache();
		let calls = 0;
		const empty: PasswordLookup = async () => { calls += 1; return { ok: true, stdout: "   " }; };
		assert.equal(await readBrowserCookiePassword(chromium, "linux", empty), "peanuts");
		assert.equal(await readBrowserCookiePassword(chromium, "linux", empty), "peanuts");
		assert.equal(calls, 2, "peanuts fallback must not be cached");

		resetBrowserCookiePasswordCache();
		const noSecretTool: BrowserConfig = { name: "Chromium", baseDir: ".config/chromium" };
		let never = 0;
		const forbidden: PasswordLookup = async () => { never += 1; return { ok: true, stdout: "x" }; };
		assert.equal(await readBrowserCookiePassword(noSecretTool, "linux", forbidden), "peanuts");
		assert.equal(never, 0);
	});

	/* ------------------------------------------------------------------ */
	/* 5. Glimpse：非 macOS 返回 null；openInGlimpse 行为不变              */
	/* ------------------------------------------------------------------ */

	await check("getPlatformGlimpseOpen is null on Linux/Windows", async () => {
		assert.equal(await getPlatformGlimpseOpen("linux"), null);
		assert.equal(await getPlatformGlimpseOpen("windows"), null);
	});

	await check("openInGlimpse keeps the shell HTML / resize clamping contract", () => {
		const writes: Array<Record<string, unknown>> = [];
		const handlers = new Map<string, (payload: unknown) => void>();
		const fakeWindow: GlimpseWindow = {
			on(event, handler) { handlers.set(event, handler as (payload: unknown) => void); },
			close() {},
			_write(obj) { writes.push(obj); },
		};
		let openedHtml = "";
		let openedOpts: Record<string, unknown> = {};
		const win = openInGlimpse((html, opts) => {
			openedHtml = html;
			openedOpts = opts;
			return fakeWindow;
		}, "https://example.com/curator", "Search Curator");
		assert.equal(win, fakeWindow);
		assert.match(openedHtml, /window\.location\.replace\("https:\/\/example\.com\/curator"\)/);
		assert.match(openedHtml, /<title>Search Curator<\/title>/);
		assert.deepEqual(openedOpts, { width: 800, height: 900, title: "Search Curator" });

		handlers.get("ready")?.({ screen: { visibleHeight: 1000 } });
		handlers.get("message")?.({ type: "resize", height: 5000 });
		assert.deepEqual(writes, [{ type: "resize", width: 800, height: 850 }], "resize must clamp to 85% of visible height");
		handlers.get("message")?.({ type: "resize", height: 120 });
		assert.deepEqual(writes[1], { type: "resize", width: 800, height: 400 }, "resize must clamp to the 400px floor");
		handlers.get("message")?.({ type: "other", height: 900 });
		handlers.get("message")?.({ type: "resize", height: "tall" });
		assert.equal(writes.length, 2, "invalid resize messages must be ignored");
	});

	await check("web-access sources no longer branch on platform()/darwin", () => {
		for (const file of ["src/main/capabilities/web-access/chrome-cookies.ts", "src/main/capabilities/web-access/index.ts"]) {
			const source = readFileSync(resolve(file), "utf8");
			assert.doesNotMatch(source, /platform\(\)/, `${file} must not call node:os platform()`);
			assert.doesNotMatch(source, /from "node:os"[^\n]*platform/, `${file} must not import platform from node:os`);
			assert.doesNotMatch(source, /===\s*"darwin"|!==\s*"darwin"/, `${file} must not branch on darwin`);
			assert.doesNotMatch(source, /"win32"\s*\?\s*await pi\.exec/, `${file} must not inline browser-open platform branches`);
		}
	});

	console.log(`platform-browsers: ${results.length} checks passed`);
}

void main();
