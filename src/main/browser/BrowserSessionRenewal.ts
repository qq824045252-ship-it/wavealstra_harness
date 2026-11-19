import type { Cookie, Session } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../library/library-file-io";
import { refreshSiteHome } from "./BrowserSiteRefresh";

export type BrowserRenewalStatus = {
  state: "scheduled" | "cookie_extended" | "checked" | "retry" | "sign_in_required" | "unsupported";
  nextAttemptAt?: number;
  lastExtendedAt?: number;
};

interface Site {
  url: string;
  status: BrowserRenewalStatus;
  cookies: Map<string, number>;
  timer?: NodeJS.Timeout;
  flight?: AbortController;
  failures: number;
  hadCookies: boolean;
}

const idleInterval = 5 * 60_000;
const states = new Set<BrowserRenewalStatus["state"]>(["scheduled", "cookie_extended", "checked", "retry", "sign_in_required", "unsupported"]);

// Revisit only a read-only resource. Query strings, fragments and URL credentials
// never enter the profile registry. A HEAD request cannot replay a login form.
function resource(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = ""; url.hash = "";
    return url;
  } catch { return undefined; }
}

function identity(cookie: Cookie): string {
  return JSON.stringify([cookie.domain, cookie.path, cookie.name]);
}

function candidate(cookie: Cookie): boolean {
  return cookie.httpOnly === true || /auth|session|token|(?:^|_)sid(?:$|_)/i.test(cookie.name);
}

function appliesTo(cookie: Cookie, raw: string): boolean {
  const url = new URL(raw);
  const domain = cookie.domain?.replace(/^\./, "");
  const path = cookie.path ?? "/";
  return Boolean(domain && (url.hostname === domain || !cookie.hostOnly && url.hostname.endsWith("." + domain))
    && (!cookie.secure || url.protocol === "https:")
    && (url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : path + "/")));
}

function nextDelay(cookies: Map<string, number>): number {
  let delay = idleInterval;
  const now = Date.now();
  for (const expires of cookies.values()) {
    if (expires > now) delay = Math.min(delay, (expires - now) * 0.65);
  }
  return Math.max(1000, Math.ceil(delay));
}

/** One scheduler per persistent sidebar session. Chromium owns all credentials. */
export class BrowserSessionRenewal {
  private readonly sites = new Map<string, Site>();
  private readonly file: string | undefined;
  private closed = false;

  constructor(private readonly session: Session) {
    const dir = session.getStoragePath();
    this.file = dir ? join(dir, "mybuddy-site-renewal.json") : undefined;
    if (this.file && existsSync(this.file)) {
      try {
        const saved: unknown = JSON.parse(readFileSync(this.file, "utf8"));
        if (Array.isArray(saved)) for (const row of saved) {
          const url = typeof row?.url === "string" && resource(row.url);
          if (!url || !states.has(row.state) || this.sites.has(url.origin)) continue;
          const status: BrowserRenewalStatus = { state: row.state };
          if (Number.isFinite(row.lastExtendedAt)) status.lastExtendedAt = row.lastExtendedAt;
          const site: Site = { url: url.href, status, cookies: new Map(), failures: 0, hadCookies: row.hadCookies === true };
          this.sites.set(url.origin, site);
          if (Number.isFinite(row.nextAttemptAt)) this.arm(site, Math.max(0, Math.min(idleInterval, row.nextAttemptAt - Date.now())));
        }
      } catch (error) { console.warn("[browser] 无法恢复网站续期计划", error instanceof Error ? error.name : "read error"); }
    }
    session.cookies.on("changed", this.cookieChanged);
  }

  status(url: string): BrowserRenewalStatus | undefined {
    const target = resource(url);
    const site = target && this.sites.get(target.origin);
    return site && { ...site.status };
  }

  async track(verifiedUrl: string): Promise<BrowserRenewalStatus | undefined> {
    const url = resource(verifiedUrl);
    if (this.closed || !url) return;
    let site = this.sites.get(url.origin);
    if (site && site.status.state !== "sign_in_required" && site.status.state !== "unsupported") return { ...site.status };
    site = { url: url.href, status: { state: "scheduled" }, cookies: new Map(), failures: 0, hadCookies: false };
    this.sites.set(url.origin, site);
    try {
      const cookies = await this.expiries(site.url);
      if (this.closed || this.sites.get(url.origin) !== site) return;
      if (site.status.state === "sign_in_required") return { ...site.status };
      site.cookies = cookies;
      site.hadCookies = cookies.size > 0;
      this.arm(site, nextDelay(cookies));
    } catch {
      if (this.closed || this.sites.get(url.origin) !== site) return;
      site.status.state = "retry";
      this.arm(site, 30_000);
    }
    this.save();
    return { ...site.status };
  }

  private async expiries(url: string): Promise<Map<string, number>> {
    const cookies = await this.session.cookies.get({ url });
    // These are scheduling hints. A changed analytics cookie would not prove
    // that the account is signed in. The foreground checks the business page.
    return new Map(cookies.filter(candidate)
      .map(c => [identity(c), (c.expirationDate ?? 0) * 1000]));
  }

  private arm(site: Site, delay: number): void {
    clearTimeout(site.timer);
    site.status.nextAttemptAt = Date.now() + delay;
    site.timer = setTimeout(() => { site.timer = undefined; void this.renew(site); }, delay);
    site.timer.unref();
  }

  private async renew(site: Site): Promise<void> {
    if (this.closed || site.flight) return;
    const flight = new AbortController();
    site.flight = flight;
    const timeout = setTimeout(() => flight.abort(), 15_000);
    try {
      const before = await this.expiries(site.url);
      if (flight.signal.aborted) throw new Error("cancelled");
      site.cookies = before;
      const lostCookies = site.hadCookies && !before.size;
      const check = () => this.session.fetch(site.url, {
        method: "HEAD", credentials: "include", redirect: "manual", cache: "no-store", signal: flight.signal,
      });
      let response = await check();
      let after = await this.expiries(site.url);
      const extended = () => [...after].some(([key, expiry]) => before.has(key) && expiry > before.get(key)!);
      const refresh = () => refreshSiteHome(this.session, new URL(site.url).origin, flight.signal, async () => {
        after = await this.expiries(site.url);
        return extended() || lostCookies && after.size > 0;
      });
      const expired = response.status === 401;
      if (expired || lostCookies && response.status !== 403) {
        // An expired access session can still have a valid website-owned
        // refresh session. Give the first-party client one attempt.
        if (await refresh() === "sign_in_required") { site.status.state = "sign_in_required"; return; }
        if (lostCookies && !after.size) { site.status.state = "sign_in_required"; return; }
        response = await check();
      }
      if (flight.signal.aborted) throw new Error("cancelled");
      if (response.status === 401 || response.status === 403 || response.status >= 300 && response.status < 400) {
        site.status.state = "sign_in_required";
      } else if (response.status === 404) {
        site.status.state = "unsupported";
      } else {
        const headUnsupported = response.status === 405 || response.status === 501;
        if (!response.ok && !headUnsupported) throw new Error("renewal unavailable");
        if (!expired && !lostCookies && !extended() && (headUnsupported || ![...before.values()].some(expiry => expiry > 0) || nextDelay(before) < idleInterval)) {
          const outcome = await refresh();
          if (flight.signal.aborted) throw new Error("cancelled");
          if (outcome === "sign_in_required") { site.status.state = outcome; return; }
        }
        after = await this.expiries(site.url);
        if (flight.signal.aborted) throw new Error("cancelled");
        site.cookies = after;
        site.hadCookies ||= after.size > 0;
        site.status.state = extended() ? "cookie_extended" : "checked";
        if (site.status.state === "cookie_extended") site.status.lastExtendedAt = Date.now();
        site.failures = 0;
        this.arm(site, nextDelay(after));
      }
    } catch {
      if (this.closed || site.flight !== flight) return;
      site.status.state = "retry";
      this.arm(site, Math.min(nextDelay(site.cookies), 15_000 * 2 ** Math.min(site.failures++, 5)));
    } finally {
      clearTimeout(timeout);
      if (site.flight === flight) {
        site.flight = undefined;
        if (!site.timer) delete site.status.nextAttemptAt;
        this.save();
      }
    }
  }

  private readonly cookieChanged = (_event: unknown, cookie: Cookie, cause: string, removed: boolean) => {
    if (!candidate(cookie) || removed && cause !== "explicit" && cause !== "expired-overwrite") return;
    let changed = false;
    for (const site of this.sites.values()) {
      if (site.status.state === "sign_in_required" || site.status.state === "unsupported" || !appliesTo(cookie, site.url)) continue;
      if (!removed) {
        // The flight owns a pre-request snapshot and reads the final jar itself.
        if (site.flight) continue;
        site.cookies.set(identity(cookie), (cookie.expirationDate ?? 0) * 1000);
        const delay = nextDelay(site.cookies);
        if (site.timer && Date.now() + delay < site.status.nextAttemptAt!) {
          this.arm(site, delay);
          changed = true;
        }
        continue;
      }
      if (!site.cookies.has(identity(cookie)) && !(site.hadCookies && !site.cookies.size)) continue;
      clearTimeout(site.timer); site.timer = undefined;
      site.flight?.abort(); site.flight = undefined;
      site.status.state = "sign_in_required";
      delete site.status.nextAttemptAt;
      changed = true;
    }
    if (changed) this.save();
  };

  private save(): void {
    if (!this.file || this.closed) return;
    try { atomicWriteFileSync(this.file, JSON.stringify([...this.sites.values()].map(site => ({ url: site.url, hadCookies: site.hadCookies, ...site.status })))); }
    catch (error) { console.warn("[browser] 无法保存网站续期计划", error instanceof Error ? error.name : "write error"); }
  }

  dispose(): void {
    this.closed = true;
    this.session.cookies.off("changed", this.cookieChanged);
    for (const site of this.sites.values()) { clearTimeout(site.timer); site.flight?.abort(); }
    this.sites.clear();
  }
}
