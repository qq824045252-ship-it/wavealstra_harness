export const dotsGoogleAccounts = ["personal", "company"] as const;
export const dotsGoogleSources = ["gmail", "calendar"] as const;
export type DotsGoogleAccount = typeof dotsGoogleAccounts[number];
export type DotsGoogleSource = typeof dotsGoogleSources[number];

export interface DotsGoogleRule {
  accounts: DotsGoogleAccount[];
  mode: "interval" | "daily";
  intervalMinutes: number;
  dailyTime: string;
}

export type DotsGoogleRules = Record<DotsGoogleSource, DotsGoogleRule>;

export function normalizeDotsGoogleRules(input?: Partial<DotsGoogleRules>, fallback?: DotsGoogleRules): DotsGoogleRules {
  const rule = (source: DotsGoogleSource): DotsGoogleRule => {
    const next = input?.[source];
    const previous = fallback?.[source];
    const minutes = next?.intervalMinutes;
    return {
      accounts: Array.isArray(next?.accounts) ? dotsGoogleAccounts.filter(account => next.accounts.includes(account)) : previous?.accounts ?? [],
      mode: next?.mode === "interval" || next?.mode === "daily" ? next.mode : previous?.mode ?? "interval",
      intervalMinutes: typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
        ? minutes : previous?.intervalMinutes ?? (source === "gmail" ? 5 : 10),
      dailyTime: typeof next?.dailyTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next.dailyTime)
        ? next.dailyTime : previous?.dailyTime ?? "08:30",
    };
  };
  return { gmail: rule("gmail"), calendar: rule("calendar") };
}

export interface DotsGoogleAccess {
  ready: boolean;
  message?: string;
}

export interface DotsGoogleConnection {
  email: string;
  checkedAt: number;
  access: Record<DotsGoogleSource, DotsGoogleAccess>;
}

export interface DotsGoogleAccountStatus {
  connection?: DotsGoogleConnection;
  busy?: "login" | "check";
  message?: string;
}

export interface DotsGoogleSourceStatus {
  checkedAt?: number;
  nextAt?: number;
  message?: string;
}

export interface DotsGoogleStatus {
  accounts: Record<DotsGoogleAccount, DotsGoogleAccountStatus>;
  sources: Record<DotsGoogleSource, Partial<Record<DotsGoogleAccount, DotsGoogleSourceStatus>>>;
}

export interface DotsGoogleApi {
  status(): Promise<DotsGoogleStatus>;
  login(account: DotsGoogleAccount): Promise<DotsGoogleStatus>;
  check(account: DotsGoogleAccount): Promise<DotsGoogleStatus>;
  cancelLogin(account: DotsGoogleAccount): Promise<void>;
}

export const DotsGoogleIpc = {
  status: "dots-google:status",
  login: "dots-google:login",
  check: "dots-google:check",
  cancelLogin: "dots-google:cancel-login",
} as const;
