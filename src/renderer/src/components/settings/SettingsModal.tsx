import { APP_VERSION } from "@shared/app-version";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { useAppStore, type SettingsTab } from "@/store/appStore";
import type {
  FileBackupInfoDto,
  ModelInfoDto,
} from "@shared/agent-ipc";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import {
  IconArchive,
  IconBell,
  IconBlocks,
  IconBook,
  IconClock,
  IconCode,
  IconFile,
  IconFolder,
  IconGrid,
  IconLink,
  IconMore,
  IconPencil,
  IconPlus,
  IconPuzzle,
  IconRefresh,
  IconSettings,
  IconShare,
  IconShield,
  IconSparkles,
  IconX,
} from "@/components/common/icons";
import "./RecordManagement.css";
import ModelsTab from "./ModelsTab";
import ModesTab from "./ModesTab";
import MemoryTab from "./MemoryTab";
import CapabilitiesTab from "./CapabilitiesTab";
import RemoteAccessTab from "./RemoteAccessTab";
import ArchivesTab from "./ArchivesTab";
import PythonRuntimeTab from "./PythonRuntimeTab";
import AcpTab from "./AcpTab";
import type { UserFontDto } from "@shared/agent-ipc";
import CompactionSettingsControl from "./CompactionSettingsControl";
import { CODE_THEME_OPTIONS, DEFAULT_CODE_THEME, normalizeCodeTheme, type CodeThemeId } from "@shared/code-theme";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  normalizeNotificationPreferences,
  type NotificationPreferencesDto,
} from "@shared/notification";
import {
  applyFontSettings,
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  ensureAllUserFontsLoaded,
  ensureUserFontLoaded,
  legacyFontScaleToUiFontSize,
  normalizeCodeFontSize,
  normalizeUiFontSize,
  userFontCssFamily,
} from "@/lib/fontSettings";

const TABS: Array<{ id: SettingsTab; icon: React.ComponentType<{ size?: number }>; label: string }> = [
  { id: "system", icon: IconSettings, label: "系统设置" },
  { id: "extensions", icon: IconBlocks, label: "工具能力" },
  { id: "modes", icon: IconPencil, label: "模式与提示词" },
  { id: "personalize", icon: IconSparkles, label: "个性化" },
  { id: "memory", icon: IconClock, label: "记忆" },
  { id: "archive", icon: IconArchive, label: "归档管理" },
  { id: "models", icon: IconGrid, label: "模型" },
  { id: "assistant", icon: IconLink, label: "助理设置" },
  { id: "acp", icon: IconPuzzle, label: "ACP 管理" },
  { id: "data", icon: IconFile, label: "数据管理" },
  { id: "python", icon: IconCode, label: "Python 运行时" },
  { id: "shortcuts", icon: IconMore, label: "快捷键" },
  { id: "notifications", icon: IconBell, label: "通知" },
  { id: "remote", icon: IconShare, label: "远程连接" },
  { id: "security", icon: IconShield, label: "安全中心" },
  { id: "help", icon: IconBook, label: "帮助与反馈" },
];

/** 内容区分区卡片：标题 + 描述 + 行条目容器（透明底 + 细边框，清新风格） */
function SettingsSection({
  title,
  desc,
  children,
}: {
  title?: string;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="settings-section">
      {(title || desc) && (
        <div className="settings-section-head">
          {title && <div className="settings-section-title">{title}</div>}
          {desc && <div className="settings-section-desc">{desc}</div>}
        </div>
      )}
      <div className="settings-section-card">{children}</div>
    </section>
  );
}


function Toggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!on);
      }}
    />
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-row-label">{label}</div>
        {desc && <div className="settings-row-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

type FontTarget = "ui" | "code";

type FontPickerOption = {
  id: string;
  label: string;
  family: string;
  source: "default" | "system" | "imported";
  importedFont?: UserFontDto;
};

function FontPicker({
  value,
  options,
  placeholder,
  onSelect,
  disabled,
}: {
  value: string;
  options: FontPickerOption[];
  placeholder: string;
  onSelect: (option: FontPickerOption) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const selected = options.find((option) => option.family === value) ?? options[0];
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return options;
    return options.filter((option) => option.label.toLocaleLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className={`typography-font-picker${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="typography-font-picker-trigger"
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        aria-expanded={open}
      >
        <span className="typography-font-picker-value" style={{ fontFamily: selected?.family || undefined }}>
          {selected?.label || placeholder}
        </span>
        <span className="typography-font-picker-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="typography-font-picker-popover">
          <div className="typography-font-picker-search-wrap">
            <input
              autoFocus
              className="typography-font-picker-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索字体"
            />
          </div>
          <div className="typography-font-picker-list thin-scrollbar">
            {filtered.length === 0 ? (
              <div className="typography-font-picker-empty">没有匹配的字体</div>
            ) : (
              filtered.map((option, index) => {
                const previous = filtered[index - 1];
                const showGroup = index === 0 || previous?.source !== option.source;
                const groupLabel = option.source === "default"
                  ? "默认"
                  : option.source === "imported"
                    ? "已导入"
                    : "系统字体";
                return (
                  <div key={option.id}>
                    {showGroup && <div className="typography-font-picker-group">{groupLabel}</div>}
                    <button
                      type="button"
                      className={`typography-font-picker-option${option.family === value ? " selected" : ""}`}
                      onClick={() => {
                        onSelect(option);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span className="typography-font-picker-option-name" style={{ fontFamily: option.family || undefined }}>
                        {option.label}
                      </span>
                      {option.family === value && <span className="typography-font-picker-check">✓</span>}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function SystemTab(): React.JSX.Element {
  const [uiFontSize, setUiFontSize] = useState(DEFAULT_UI_FONT_SIZE);
  const [codeFontSize, setCodeFontSize] = useState(DEFAULT_CODE_FONT_SIZE);
  const [uiFontFamily, setUiFontFamily] = useState("");
  const [codeFontFamily, setCodeFontFamily] = useState("");
  const [codeTheme, setCodeTheme] = useState<CodeThemeId>(DEFAULT_CODE_THEME);
  const [userFonts, setUserFonts] = useState<UserFontDto[]>([]);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [systemFontsLoading, setSystemFontsLoading] = useState(true);
  const [systemFontsError, setSystemFontsError] = useState("");
  const [language, setLanguage] = useState("zh-CN");
  const [proxyUrl, setProxyUrl] = useState("");
  const [closeToTray, setCloseToTray] = useState(true);
  const [hint, setHint] = useState("");
  const [fontHint, setFontHint] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [fontBusy, setFontBusy] = useState(false);
  const [confirmRemoveFont, setConfirmRemoveFont] = useState<UserFontDto | null>(null);
  const [diskSpace, setDiskSpace] = useState<import("@shared/agent-ipc").DiskSpaceDto | null>(null);
  const fontFileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshUserFonts = useCallback(async (): Promise<UserFontDto[]> => {
    const list = (await window.api?.agent?.listUserFonts?.()) ?? [];
    setUserFonts(list);
    await ensureAllUserFontsLoaded(list);
    return list;
  }, []);

  const refreshSystemFonts = useCallback(async (): Promise<void> => {
    setSystemFontsLoading(true);
    setSystemFontsError("");
    try {
      const fn = window.api?.agent?.listSystemFonts;
      if (!fn) {
        setSystemFonts([]);
        setSystemFontsError("主进程字体接口未加载，请完整重启应用");
        return;
      }
      const installed = await fn();
      setSystemFonts(installed ?? []);
      if (!installed?.length) setSystemFontsError("未读取到系统字体");
    } catch (err) {
      setSystemFonts([]);
      setSystemFontsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSystemFontsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSystemFonts();
    void (async () => {
      try {
        const [settings, fonts, disk] = await Promise.all([
          window.api?.agent?.getAppSettings?.(),
          window.api?.agent?.listUserFonts?.() ?? Promise.resolve([]),
          window.api?.agent?.getDiskSpace?.(),
        ]);
        setUserFonts(fonts ?? []);
        await ensureAllUserFontsLoaded(fonts ?? []);
        if (disk) setDiskSpace(disk);
        if (!settings) return;

        const nextUiFontSize = normalizeUiFontSize(
          settings.uiFontSize ?? legacyFontScaleToUiFontSize(settings.fontSize),
        );
        const nextCodeFontSize = normalizeCodeFontSize(settings.codeFontSize ?? DEFAULT_CODE_FONT_SIZE);
        const nextUiFontFamily = settings.uiFontFamily ?? settings.fontFamily ?? "";
        const nextCodeFontFamily = settings.codeFontFamily ?? "";
        const nextCodeTheme = normalizeCodeTheme(settings.codeTheme);

        setLanguage(settings.language || "zh-CN");
        setProxyUrl(settings.proxyUrl || "");
        setCloseToTray(settings.closeToTray !== false);
        setUiFontSize(nextUiFontSize);
        setCodeFontSize(nextCodeFontSize);
        setUiFontFamily(nextUiFontFamily);
        setCodeFontFamily(nextCodeFontFamily);
        setCodeTheme(nextCodeTheme);
        document.documentElement.dataset.codeTheme = nextCodeTheme;
        applyFontSettings({
          uiFontSize: nextUiFontSize,
          codeFontSize: nextCodeFontSize,
          uiFontFamily: nextUiFontFamily,
          codeFontFamily: nextCodeFontFamily,
        });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [refreshSystemFonts]);

  const fontOptions = useMemo((): FontPickerOption[] => {
    const imported = userFonts.map((font) => ({
      id: `imported:${font.id}`,
      label: font.family,
      family: userFontCssFamily(font.family),
      source: "imported" as const,
      importedFont: font,
    }));
    const importedFamilies = new Set(imported.map((option) => option.family.toLocaleLowerCase()));
    const installed = systemFonts
      .map((name) => ({
        id: `system:${name}`,
        label: name,
        family: userFontCssFamily(name),
        source: "system" as const,
      }))
      .filter((option) => !importedFamilies.has(option.family.toLocaleLowerCase()));
    return [
      { id: "default", label: "系统默认", family: "", source: "default" as const },
      ...imported,
      ...installed,
    ];
  }, [systemFonts, userFonts]);

  const codeFontOptions = useMemo((): FontPickerOption[] => {
    const [defaultOption, ...rest] = fontOptions;
    return [
      { ...(defaultOption ?? { id: "default", label: "系统默认", family: "", source: "default" as const }), label: "系统等宽" },
      ...rest,
    ];
  }, [fontOptions]);

  const codeThemePreviewVariants = useMemo<Array<"light" | "dark">>(() => {
    const option = CODE_THEME_OPTIONS.find((item) => item.id === codeTheme);
    return option?.mode === "dark" ? ["dark"] : ["light", "dark"];
  }, [codeTheme]);

  const persistTypography = async (partial: {
    uiFontSize?: number;
    codeFontSize?: number;
    uiFontFamily?: string;
    codeFontFamily?: string;
  }): Promise<void> => {
    setFontBusy(true);
    setFontHint("保存中…");
    setErrorMsg("");
    try {
      await window.api?.agent?.updateAppSettings?.(partial);
      setFontHint("已自动保存");
    } catch (err) {
      setFontHint("");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFontBusy(false);
    }
  };

  const selectFontOption = async (target: FontTarget, option: FontPickerOption): Promise<void> => {
    if (option.importedFont) {
      try {
        await ensureUserFontLoaded(option.importedFont);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (target === "ui") {
      setUiFontFamily(option.family);
      applyFontSettings({ uiFontFamily: option.family });
      await persistTypography({ uiFontFamily: option.family });
    } else {
      setCodeFontFamily(option.family);
      applyFontSettings({ codeFontFamily: option.family });
      await persistTypography({ codeFontFamily: option.family });
    }
  };

  const handleUiFontSizeChange = async (value: number): Promise<void> => {
    const size = normalizeUiFontSize(value);
    setUiFontSize(size);
    applyFontSettings({ uiFontSize: size });
    await persistTypography({ uiFontSize: size });
  };

  const handleCodeFontSizeChange = async (value: number): Promise<void> => {
    const size = normalizeCodeFontSize(value);
    setCodeFontSize(size);
    applyFontSettings({ codeFontSize: size });
    await persistTypography({ codeFontSize: size });
  };

  const onFontFileChosen = async (fileList: FileList | null): Promise<void> => {
    const file = fileList?.[0];
    if (!file) return;
    setFontBusy(true);
    setErrorMsg("");
    setFontHint("正在导入…");
    try {
      const importFn = window.api?.agent?.importUserFont;
      if (!importFn) throw new Error("导入接口未就绪，请完全退出并重新启动应用后再试");
      const path = (window.api?.getPathForFile?.(file) || "").trim();
      const imported = path ? await importFn(path) : await importFn();
      if (!imported) {
        setFontHint("");
        return;
      }
      await refreshUserFonts();
      await ensureUserFontLoaded(imported);
      setFontHint(`「${imported.family}」已永久保存到字体库`);
    } catch (err) {
      setFontHint("");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFontBusy(false);
      if (fontFileInputRef.current) fontFileInputRef.current.value = "";
    }
  };

  const removeFont = async (font: UserFontDto): Promise<void> => {
    setFontBusy(true);
    setErrorMsg("");
    try {
      const family = userFontCssFamily(font.family);
      const resetUi = uiFontFamily === family;
      const resetCode = codeFontFamily === family;
      const list = (await window.api?.agent?.removeUserFont?.(font.id)) ?? [];
      setUserFonts(list);
      if (resetUi) {
        setUiFontFamily("");
        applyFontSettings({ uiFontFamily: "" });
      }
      if (resetCode) {
        setCodeFontFamily("");
        applyFontSettings({ codeFontFamily: "" });
      }
      if (resetUi || resetCode) {
        await window.api?.agent?.updateAppSettings?.({
          ...(resetUi ? { uiFontFamily: "" } : {}),
          ...(resetCode ? { codeFontFamily: "" } : {}),
        });
      }
      setFontHint(`已删除「${font.family}」`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setFontBusy(false);
    }
  };

  const changeLanguage = async (next: string): Promise<void> => {
    const previous = language;
    setLanguage(next);
    setErrorMsg("");
    try {
      await window.api?.agent?.updateAppSettings?.({ language: next });
      setHint("显示语言已保存");
    } catch (err) {
      setLanguage(previous);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const changeCodeTheme = async (next: CodeThemeId): Promise<void> => {
    const previous = codeTheme;
    setCodeTheme(next);
    document.documentElement.dataset.codeTheme = next;
    setErrorMsg("");
    try {
      await window.api?.agent?.updateAppSettings?.({ codeTheme: next });
    } catch (err) {
      setCodeTheme(previous);
      document.documentElement.dataset.codeTheme = previous;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const saveProxy = async (): Promise<void> => {
    setErrorMsg("");
    try {
      await window.api?.agent?.updateAppSettings?.({ proxyUrl });
      setHint("代理设置已保存");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const usagePercent =
    diskSpace && diskSpace.totalBytes > 0
      ? ((diskSpace.usedBytes / diskSpace.totalBytes) * 100).toFixed(1)
      : "--";

  const toggleCloseToTray = async (v: boolean): Promise<void> => {
    setCloseToTray(v);
    try {
      await window.api?.agent?.updateAppSettings?.({ closeToTray: v });
      setHint(v ? "已开启：点击关闭按钮将最小化到系统托盘" : "已关闭：点击关闭按钮将直接退出应用");
    } catch (err) {
      setCloseToTray(!v);
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };


  return (
    <div className="system-settings-v4">
      <SettingsSection title="常规">
        <Row label="显示语言" desc="应用程序界面语言">
          <select className="pill-select" value={language} onChange={(event) => void changeLanguage(event.target.value)}>
            <option value="zh-CN">中文(简体)</option>
            <option value="en">English</option>
          </select>
        </Row>
        <Row label="关闭时最小化到托盘" desc="关闭窗口后后台继续运行；托盘图标可恢复，菜单可退出。">
          <Toggle on={closeToTray} onChange={(v) => void toggleCloseToTray(v)} />
        </Row>
      </SettingsSection>

      <SettingsSection
        title="字体"
      >
        <div className="typography-flat-layout">
          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">UI 字体</div>
              <div className="settings-row-desc">用于应用界面和 Markdown 正文</div>
            </div>
            <FontPicker value={uiFontFamily} options={fontOptions} placeholder="系统默认" onSelect={(option) => void selectFontOption("ui", option)} disabled={fontBusy} />
          </div>

          <div className="typography-flat-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">代码字体</div>
              <div className="settings-row-desc">用于终端、代码块和差异内容</div>
            </div>
            <FontPicker value={codeFontFamily} options={codeFontOptions} placeholder="系统等宽" onSelect={(option) => void selectFontOption("code", option)} disabled={fontBusy} />
          </div>

          <div className="typography-flat-row typography-size-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">UI 字号</div>
              <div className="settings-row-desc">调整界面与正文文字大小</div>
            </div>
            <div className="typography-ui-size-options" role="group" aria-label="UI 字号">
              {[[12, "特小"], [13, "较小"], [14, "小"], [15, "默认"], [16, "大"], [18, "较大"], [20, "特大"]].map(([size, label]) => (
                <button key={size} type="button" className={`typography-ui-size-option${uiFontSize === size ? " active" : ""}`} onClick={() => void handleUiFontSizeChange(Number(size))} disabled={fontBusy} title={`${size}px`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="typography-flat-row typography-size-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">代码字号</div>
              <div className="settings-row-desc">调整代码块、编辑器和终端文字大小</div>
            </div>
            <div className="typography-code-size-control">
              <span className="typography-code-size-value">{codeFontSize}px</span>
              <input type="range" min={12} max={20} step={1} value={codeFontSize} onChange={(e) => void handleCodeFontSizeChange(Number(e.target.value))} aria-label="代码字号" disabled={fontBusy} />
              <div className="typography-code-size-marks"><span>12px</span><span>16px</span><span>20px</span></div>
            </div>
          </div>

          <div className="typography-code-theme">
            <div className="typography-code-theme-head">
              <div>
                <div className="settings-row-label">代码主题</div>
                <div className="settings-row-desc">选择代码块的语法高亮配色</div>
              </div>
            </div>
            <select className="code-theme-select" value={codeTheme} onChange={(event) => void changeCodeTheme(event.target.value as CodeThemeId)}>
              <optgroup label="浅色 + 深色">
                {CODE_THEME_OPTIONS.filter((option) => option.mode === "dual").map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </optgroup>
              <optgroup label="深色">
                {CODE_THEME_OPTIONS.filter((option) => option.mode === "dark").map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </optgroup>
            </select>
            <div className="code-theme-preview" data-preview-code-theme={codeTheme} aria-label="代码主题预览">
              {codeThemePreviewVariants.map((variant) => (
                <div key={variant} className="code-theme-preview-pane" data-variant={variant}>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">1</span><code><span className="tok-keyword">function</span> <span className="tok-function">greet</span>() {"{"}</code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">2</span><code>  <span className="tok-keyword">const</span> name = <span className="tok-string">&quot;world&quot;</span></code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">3</span><code>  console.<span className="tok-function">log</span>(name)</code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">4</span><code>  <span className="tok-keyword">return</span> <span className="tok-number">true</span></code></div>
                  <div className="code-theme-preview-line"><span className="code-theme-preview-ln">5</span><code>{"}"}</code></div>
                </div>
              ))}
            </div>
          </div>

          <div className="typography-custom-font-row">
            <div className="typography-flat-copy">
              <div className="settings-row-label">字体库</div>
              <div className="settings-row-desc">
                {systemFontsLoading ? "正在读取系统字体…" : systemFontsError ? systemFontsError : `系统字体 ${systemFonts.length} 个 · 已导入 ${userFonts.length} 个`}
                {fontHint ? <span className="typography-save-state"> · {fontHint}</span> : null}
              </div>
            </div>
            <div className="typography-custom-font-actions">
              <button type="button" className="btn" onClick={() => void refreshSystemFonts()} disabled={systemFontsLoading}><IconRefresh size={14} />刷新</button>
              <button type="button" className="btn" onClick={() => void window.api?.agent?.openFontsDir?.()}><IconFolder size={14} />目录</button>
              <input ref={fontFileInputRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" className="font-file-input-hidden" tabIndex={-1} onChange={(e) => void onFontFileChosen(e.target.files)} />
              <button type="button" className="btn" disabled={fontBusy} onClick={() => fontFileInputRef.current?.click()}><IconPlus size={14} />导入字体</button>
            </div>
          </div>

          {userFonts.length > 0 && (
            <div className="typography-imported-font-list">
              {userFonts.map((font) => (
                <div key={font.id} className="typography-imported-font-item">
                  <span style={{ fontFamily: userFontCssFamily(font.family) }}>{font.family}</span>
                  <button type="button" title={`删除 ${font.family}`} onClick={() => setConfirmRemoveFont(font)} disabled={fontBusy}><IconX size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="上下文自动压缩">
        <CompactionSettingsControl />
      </SettingsSection>

      <SettingsSection title="网络">
        <Row label="代理" desc="可选，写入 settings.json">
          <input
            className="settings-input"
            value={proxyUrl}
            onChange={(event) => setProxyUrl(event.target.value)}
            onBlur={() => void saveProxy()}
            onKeyDown={(event) => { if (event.key === "Enter") void saveProxy(); }}
            placeholder="http://127.0.0.1:7890"
          />
        </Row>
      </SettingsSection>

      <SettingsSection title="存储" desc="数据目录 ~/.mybuddy（任务记录、缓存等）">
        <div className="storage-inline">
          <div className="storage-bar">
            <div
              className="storage-bar-used"
              style={{ width: usagePercent === "--" ? "0%" : `${Math.min(100, Math.max(0, Number(usagePercent)))}%` }}
            />
          </div>
          <div className="settings-row-desc">
            已用 {formatBytes(diskSpace?.usedBytes ?? 0)} · 可用 {formatBytes(diskSpace?.freeBytes ?? 0)} · 共 {formatBytes(diskSpace?.totalBytes ?? 0)}
            {usagePercent !== "--" ? `（磁盘 ${usagePercent}%）` : null}
          </div>
        </div>
      </SettingsSection>

      {(hint || errorMsg) && (
        <div className="system-settings-inline-status">
          {hint ? <span className="settings-hint ok">{hint}</span> : null}
          {errorMsg ? <span className="settings-hint err">{errorMsg}</span> : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemoveFont !== null}
        title={`删除已导入字体「${confirmRemoveFont?.family ?? ""}」？`}
        body="字体文件将从字体库移除；若界面或代码字体正在使用它，将恢复为系统默认。"
        confirmLabel="删除"
        danger
        onCancel={() => !fontBusy && setConfirmRemoveFont(null)}
        onConfirm={() => {
          const target = confirmRemoveFont;
          setConfirmRemoveFont(null);
          if (target) void removeFont(target);
        }}
      />
    </div>
  );
}

/** WebAccess（pi-web-access）搜索配置卡片：API key + 路由，写入 ~/.mybuddy/web-search.json */
function PersonalizeTab(): React.JSX.Element {
  const soul = useAppStore((s) => s.soul);
  const updateSoul = useAppStore((s) => s.updateSoul);
  const [welcome, setWelcome] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const memoryFiles = [
    { key: "alias", title: "MyBuddy 对你的称呼", value: soul.alias },
    { key: "name", title: "MyBuddy 的名字", value: soul.name },
    { key: "persona", title: "MyBuddy 的人设 / 人格描述", value: soul.persona, long: true },
  ] as const;

  return (
    <>
      <Row label="基本风格和语调" desc="设置 MyBuddy 回复你的风格和语调。这不会影响 MyBuddy 的功能。">
        <select className="pill-select">
          <option>默认</option>
          <option>简洁</option>
          <option>正式</option>
          <option>活泼</option>
        </select>
      </Row>
      <Row label="加载过程欢迎语" desc="在 MyBuddy 生成等待过程中展示辅助提示。关闭后可在这里重新打开。">
        <Toggle on={welcome} onChange={setWelcome} />
      </Row>

      <div className="settings-row column">
        <div className="settings-row-label">自定义指令</div>
        <div className="settings-row-desc">
          告诉 MyBuddy 你希望它始终遵循的规则和偏好，这会直接影响所有对话。
        </div>
        <textarea
          className="soul-textarea"
          rows={5}
          placeholder='例如："每次回答我之前都说 ok, 再接后续内容"'
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <div className="instructions-footer">
          <span className="settings-row-desc">这些指令会应用于你的所有对话</span>
          <span className="settings-row-desc">{instructions.length} / 1500</span>
        </div>
        <div className="instructions-actions">
          <button className="btn primary" disabled={!instructions.trim()}>
            确认
          </button>
        </div>
      </div>

      <div className="settings-row column">
        <div className="settings-row-label">本地个性化资料</div>
        <div className="settings-row-desc">
          以下资料存储在本地数据库。长期记忆请在独立的“记忆”页面中管理。
        </div>
        {memoryFiles.map((f) => (
          <div key={f.key} className="memory-file-card">
            <div className="memory-file-title">{f.title}</div>
            {editing === f.key ? (
              <textarea
                className="soul-textarea"
                rows={"long" in f && f.long ? 6 : 2}
                value={f.value}
                onChange={(e) => updateSoul({ [f.key]: e.target.value })}
              />
            ) : (
              <div className={`memory-file-value ${"long" in f && f.long ? "clamp" : ""}`}>
                {f.value || "（未设置）"}
              </div>
            )}
            <div className="memory-file-actions">
              <button
                className="btn"
                onClick={() => setEditing(editing === f.key ? null : f.key)}
              >
                {editing === f.key ? "完成" : "编辑"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

interface GatewayField {
  key: string;
  label: string;
  type?: "text" | "password";
  placeholder?: string;
}

const CHANNEL_COLORS: Record<string, string> = {
  "telegram-default": "#2AABEE",
  "feishu-default": "#3370FF",
  "wecom-default": "#0082EF",
  "wechat-default": "#07C160",
  "slack-default": "#4A154B",
};

/** 通用通道配置块：彩色标识 + 状态圆点 + 表单 + 连接/断开 */
function GatewayBlock({
  channelId,
  title,
  desc,
  fields,
}: {
  channelId: string;
  title: string;
  desc: string;
  fields: GatewayField[];
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [allowUsers, setAllowUsers] = useState("");
  const [status, setStatus] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSlack = channelId === "slack-default";

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const s = await window.api?.gateway?.status();
      const ch = s?.channels.find((c) => c.id === channelId);
      setStatus(ch?.statusText ?? (ch?.connected ? "已连接" : "未连接"));
      setConnected(Boolean(ch?.connected));
    } catch {
      setStatus("状态未知");
      setConnected(false);
    }
  }, [channelId]);

  useEffect(() => {
    void window.api?.gateway?.getChannelConfig(channelId).then((c) => {
      if (!c?.hasConfig) {
        if (isSlack) {
          setValues({ appId: "A0C6PPDAB1S", teamId: "T0C5V7WTE8P" });
          setAllowUsers("U0C750DCY4Q");
        }
        return;
      }
      const v: Record<string, string> = {};
      for (const f of fields) {
        const raw = c.config[f.key];
        if (typeof raw === "string" && raw) v[f.key] = raw;
      }
      setValues(v);
      const users = c.config.allowUsers;
      if (Array.isArray(users)) setAllowUsers(users.join(", "));
    });
    void refreshStatus();
    if (!isSlack) return;
    const unsubscribe = window.api?.gateway?.onEvent(event => {
      if (event.channelId === channelId && event.direction === "system") void refreshStatus();
    });
    return () => unsubscribe?.();
  }, [channelId, fields, isSlack, refreshStatus]);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setStatus("连接中…");
    try {
      const config: Record<string, unknown> = { ...values };
      config.allowUsers = allowUsers
        .split(/[,，;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      await window.api?.gateway?.connect(channelId, config);
      if (isSlack) setValues(v => ({ ...v, botToken: "••••••", appToken: "••••••" }));
      await refreshStatus();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.api?.gateway?.disconnect(channelId);
      await refreshStatus();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection>
      <div className="settings-card-head">
        <span className="channel-dot" style={{ background: CHANNEL_COLORS[channelId] }} />
        <span className="settings-card-title">{title}</span>
        <span className={`channel-status${connected ? " on" : ""}`}>{isSlack ? status || "未连接" : connected ? status : "未连接"}</span>
      </div>
      <div className="settings-card-desc">{desc}</div>
      {fields.map((f) => (
        <Row key={f.key} label={f.label}>
          <input
            className="settings-input"
            type={f.type === "password" ? "password" : "text"}
            aria-label={isSlack ? f.label : undefined}
            autoComplete={isSlack ? f.type === "password" ? "new-password" : "off" : undefined}
            value={values[f.key] ?? ""}
            placeholder={f.placeholder ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </Row>
      ))}
      <Row label="允许的用户" desc={isSlack ? "必填：只接受这些 Slack Member ID 的私聊，逗号分隔。" : "只允许这些用户使用，逗号分隔；留空则谁都能用。"}>
        <input
          className="settings-input"
          aria-label={isSlack ? "允许的 Slack 用户" : undefined}
          value={allowUsers}
          placeholder={isSlack ? "U0123456789" : "user1, user2"}
          onChange={(e) => setAllowUsers(e.target.value)}
        />
      </Row>
      <div className="settings-card-footer">
        <button className="btn primary" disabled={busy || (isSlack && (!allowUsers.trim() || !values.appId?.trim() || !values.teamId?.trim() || !values.botToken?.trim() || !values.appToken?.trim()))} onClick={() => void connect()}>
          连接
        </button>
        <button className="btn" disabled={busy} onClick={() => void disconnect()}>
          断开
        </button>
      </div>
    </SettingsSection>
  );
}

function AssistantTab(): React.JSX.Element {
  return (
    <>
      <div className="settings-row-desc" style={{ marginBottom: 12 }}>
        连接后收到消息会自动开始任务，重启应用不会掉线。
      </div>

      <GatewayBlock
        channelId="slack-default"
        title="Slack 私聊"
        desc="接收指定工作区的私聊和频道 @ 提及，结果回复原讨论串。频道仅限 owner 触发；应用需已加入频道。令牌加密保存。"
        fields={[
          { key: "appId", label: "App ID", placeholder: "A0123456789" },
          { key: "teamId", label: "工作区 ID", placeholder: "T0123456789" },
          { key: "appToken", label: "App Token（connections:write）", type: "password", placeholder: "已有 xapp-… 令牌" },
          { key: "botToken", label: "Bot Token", type: "password", placeholder: "已安装 Bot 的 xoxb-… 令牌" },
        ]}
      />

      <GatewayBlock
        channelId="telegram-default"
        title="Telegram（推荐）"
        desc="在 @BotFather 建个 Bot，把 Token 填进来就能用，不需要公网。"
        fields={[
          { key: "botToken", label: "Bot Token", type: "password", placeholder: "123456:AA-xxx" },
        ]}
      />

      <GatewayBlock
        channelId="feishu-default"
        title="飞书"
        desc="在飞书开放平台配置事件回调：http://127.0.0.1:52140/feishu（需要公网）。"
        fields={[
          { key: "appId", label: "App ID", placeholder: "cli_xxx" },
          { key: "appSecret", label: "App Secret", type: "password", placeholder: "密钥" },
        ]}
      />

      <GatewayBlock
        channelId="wecom-default"
        title="企微"
        desc="在企微管理后台配置回调：http://127.0.0.1:52140/wecom（需要公网）。"
        fields={[
          { key: "corpId", label: "Corp ID", placeholder: "ww_xxx" },
          { key: "agentId", label: "Agent ID", placeholder: "1000002" },
          { key: "secret", label: "Secret", type: "password", placeholder: "密钥" },
          { key: "token", label: "Token", type: "password", placeholder: "回调 Token" },
          { key: "encodingAESKey", label: "EncodingAESKey", type: "password", placeholder: "43 位密钥" },
        ]}
      />

      <GatewayBlock
        channelId="wechat-default"
        title="微信公众号"
        desc="在公众号后台配置回调：http://127.0.0.1:52140/wechat（需要公网）。"
        fields={[
          { key: "appId", label: "App ID", placeholder: "wx_xxx" },
          { key: "appSecret", label: "App Secret", type: "password", placeholder: "密钥" },
          { key: "token", label: "Token", type: "password", placeholder: "回调 Token" },
          { key: "encodingAESKey", label: "EncodingAESKey", type: "password", placeholder: "43 位密钥" },
        ]}
      />
    </>
  );
}

const RECORD_PAGE_SIZE = 8;

function RecordPager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }): React.JSX.Element {
  const pages = Math.max(1, Math.ceil(total / RECORD_PAGE_SIZE));
  return (
    <nav className="record-pager" aria-label="记录分页">
      <span>{total ? `共 ${total} 条 · ${(page - 1) * RECORD_PAGE_SIZE + 1}–${Math.min(page * RECORD_PAGE_SIZE, total)} 条` : "共 0 条"}</span>
      <div>
        <button type="button" className="btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
        <span aria-live="polite">{page} / {pages}</span>
        <button type="button" className="btn" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button>
      </div>
    </nav>
  );
}

function DataTab(): React.JSX.Element {
  const rows: Array<{
    icon: React.ComponentType<{ size?: number }>;
    label: string;
    tab?: SettingsTab;
  }> = [
    { icon: IconFile, label: "我分享的文件" },
    { icon: IconShare, label: "我分享的任务" },
    { icon: IconGrid, label: "我发布的应用" },
    { icon: IconClock, label: "已归档任务", tab: "archive" },
  ];
  return (
    <>
      {rows.map((r) => (
        <div key={r.label} className="settings-row">
          <div className="settings-row-label with-icon">
            <r.icon size={15} /> {r.label}
          </div>
          <button
            className="btn"
            onClick={r.tab ? () => useAppStore.setState({ settingsTab: r.tab }) : undefined}
          >
            管理
          </button>
        </div>
      ))}
    </>
  );
}

function ShortcutsTab(): React.JSX.Element {
  const shortcuts = [
    { label: "新建任务", keys: "Ctrl + N" },
    { label: "全局搜索", keys: "Ctrl + K" },
    { label: "发送消息", keys: "Enter" },
    { label: "换行", keys: "Shift + Enter" },
    { label: "打开设置", keys: "Ctrl + ," },
  ];
  return (
    <>
      {shortcuts.map((s) => (
        <div key={s.label} className="settings-row">
          <div className="settings-row-label">{s.label}</div>
          <span className="kbd">{s.keys}</span>
        </div>
      ))}
    </>
  );
}

function NotificationsTab(): React.JSX.Element {
  const [preferences, setPreferences] = useState<NotificationPreferencesDto>({ ...DEFAULT_NOTIFICATION_PREFERENCES });
  const [status, setStatus] = useState("");

  useEffect(() => {
    void window.api?.agent?.getAppSettings?.().then((settings) => {
      setPreferences(normalizeNotificationPreferences(settings?.notificationPreferences));
    });
  }, []);

  const updatePreference = async (key: keyof NotificationPreferencesDto, value: boolean): Promise<void> => {
    const previous = preferences;
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    setStatus("");
    try {
      const saved = await window.api?.agent?.updateAppSettings?.({ notificationPreferences: next });
      setPreferences(normalizeNotificationPreferences(saved?.notificationPreferences ?? next));
    } catch (error) {
      setPreferences(previous);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const toggle = (key: keyof NotificationPreferencesDto) => (
    <Toggle on={preferences[key]} onChange={(value) => void updatePreference(key, value)} />
  );

  return (
    <>
      <SettingsSection title="通知方式" desc="通知中心是统一真源；桌面通知只是额外提醒，不影响通知历史。">
        <Row label="应用内通知" desc="保存到左下角铃铛通知中心，并保留未读状态。">
          {toggle("inAppEnabled")}
        </Row>
        <Row label="桌面通知" desc="通过 Windows / macOS 原生通知提醒重要事件。">
          {toggle("desktopEnabled")}
        </Row>
        <Row label="普通通知仅后台弹出" desc="MyBuddy 正在前台时，完成类通知只进入铃铛；错误和待处理仍可桌面提醒。">
          {toggle("desktopBackgroundOnly")}
        </Row>
      </SettingsSection>

      <SettingsSection title="任务">
        <Row label="任务完成" desc="长任务执行完成后提醒。">{toggle("taskCompleted")}</Row>
        <Row label="任务失败" desc="模型、工具或运行过程失败。">{toggle("taskFailed")}</Row>
        <Row label="需要我处理" desc="工具审批、越界写入等需要用户介入时优先提醒。">{toggle("actionRequired")}</Row>
      </SettingsSection>

      <SettingsSection title="自动化与项目">
        <Row label="自动化完成">{toggle("automationCompleted")}</Row>
        <Row label="自动化失败">{toggle("automationFailed")}</Row>
        <Row label="项目需要关注" desc="项目出现阻塞、风险或待确认事项时提醒。">{toggle("projectAttention")}</Row>
        <Row label="运行环境失败" desc="必需的 MCP / 专业工具运行环境启动失败。">{toggle("runtimeFailed")}</Row>
      </SettingsSection>
      {status && <div className="settings-hint error">{status}</div>}
    </>
  );
}

type ShellIsolationLevelUi = "cwd-only" | "guarded" | "os-sandbox";

function SecurityTab(): React.JSX.Element {
  const policy = useAppStore((s) => s.permissionMode);
  const setPolicy = useAppStore((s) => s.setPermissionMode);
  const tasks = useAppStore((s) => s.tasks);
  const spaces = useAppStore((s) => s.spaces);
  const [shellIsolation, setShellIsolation] = useState<ShellIsolationLevelUi>("guarded");
  const [backups, setBackups] = useState<FileBackupInfoDto[]>([]);
  const [view, setView] = useState<"all" | "spaces" | "tasks">("all");
  const [section, setSection] = useState<"settings" | "backups">("settings");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const loadBackups = useCallback((): void => {
    void window.api?.agent?.listBackups?.().then((rows) => setBackups(rows ?? []));
  }, []);

  useEffect(() => {
    void window.api?.agent?.getAppSettings?.().then((s) => {
      const level = s?.shellIsolationLevel;
      if (level === "cwd-only" || level === "guarded" || level === "os-sandbox") {
        setShellIsolation(level);
      }
    });
    loadBackups();
  }, [loadBackups]);

  const changeShellIsolation = async (level: ShellIsolationLevelUi): Promise<void> => {
    const prev = shellIsolation;
    setShellIsolation(level);
    try {
      await window.api?.agent?.updateAppSettings?.({ shellIsolationLevel: level });
      if (level === "os-sandbox") {
        setStatus(
          "本机代码执行已使用实验性环境加固；不影响 Pi 原生命令工具。",
        );
      } else if (level === "cwd-only") {
        setStatus("本机代码执行已切换为仅设置工作目录");
      } else {
        setStatus("本机代码执行已使用默认工作目录防护");
      }
    } catch (err) {
      setShellIsolation(prev);
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const restore = async (b: FileBackupInfoDto): Promise<void> => {
    setBusy(true);
    try {
      await window.api?.agent?.restoreBackup?.({ taskId: b.taskId, backupId: b.backupId });
      setStatus(`已还原：${b.relPath}`);
      loadBackups();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const taskTitleOf = (taskId: string): string =>
    tasks.find((t) => t.id === taskId)?.title ?? taskId;
  /** 任务所属空间名；无空间（普通任务）返回 null */
  const spaceOf = (taskId: string): string | null => {
    const spaceId = tasks.find((t) => t.id === taskId)?.spaceId;
    if (!spaceId) return null;
    return spaces.find((s) => s.id === spaceId)?.name ?? spaceId;
  };

  /** 按工作空间分组：备份 → 任务 → 空间；无空间归属的任务归「未分组任务」 */
  const groupBySpace = useMemo(() => {
    const map = new Map<string, { key: string; name: string; list: FileBackupInfoDto[] }>();
    for (const b of backups) {
      const spaceId = tasks.find((t) => t.id === b.taskId)?.spaceId ?? "__none__";
      const name =
        spaceId === "__none__"
          ? "未分组任务"
          : (spaces.find((s) => s.id === spaceId)?.name ?? spaceId);
      let g = map.get(spaceId);
      if (!g) {
        g = { key: spaceId, name, list: [] };
        map.set(spaceId, g);
      }
      g.list.push(b);
    }
    return [...map.values()]
      .map((g) => ({ ...g, list: [...g.list].sort((a, b) => b.createdAt - a.createdAt) }))
      .sort((a, b) => (b.list[0]?.createdAt ?? 0) - (a.list[0]?.createdAt ?? 0));
  }, [backups, tasks, spaces]);

  /** 按任务分组 */
  const groupByTask = useMemo(() => {
    const map = new Map<string, { key: string; name: string; list: FileBackupInfoDto[] }>();
    for (const b of backups) {
      let g = map.get(b.taskId);
      if (!g) {
        g = { key: b.taskId, name: taskTitleOf(b.taskId), list: [] };
        map.set(b.taskId, g);
      }
      g.list.push(b);
    }
    return [...map.values()]
      .map((g) => ({ ...g, list: [...g.list].sort((a, b) => b.createdAt - a.createdAt) }))
      .sort((a, b) => (b.list[0]?.createdAt ?? 0) - (a.list[0]?.createdAt ?? 0));
  }, [backups, tasks, spaces]);

  const groups = view === "spaces" ? groupBySpace : groupByTask;
  const selectedGroup = groups.find((item) => item.key === group);
  const needle = query.trim().toLocaleLowerCase();
  const filteredBackups = (view !== "all" && selectedGroup ? selectedGroup.list : backups)
    .filter((b) => `${b.relPath} ${taskTitleOf(b.taskId)} ${spaceOf(b.taskId) ?? ""}`.toLocaleLowerCase().includes(needle))
    .slice().sort((a, b) => b.createdAt - a.createdAt);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredBackups.length / RECORD_PAGE_SIZE)));
  useEffect(() => { setPage(currentPage); }, [currentPage]);
  useEffect(() => { listRef.current?.scrollTo(0, 0); }, [currentPage, section, query, view, group]);

  /** 单条备份卡片；showOwner 时额外显示所属空间/任务（全部视图用） */
  const renderBackup = (b: FileBackupInfoDto, showOwner = false): React.JSX.Element => {
    const deleted = b.kind === "deleted";
    const owner = showOwner
      ? (spaceOf(b.taskId) ? `${spaceOf(b.taskId)} · ` : "") + taskTitleOf(b.taskId)
      : "";
    return (
      <div key={`${b.taskId}-${b.backupId}`} className="memory-note-card backup-card">
        <div className="memory-note-content">
          {deleted && <span className="backup-badge deleted">已删除</span>}
          {!deleted && <span className="backup-badge modified">已修改</span>}
          {b.isDir && <span className="backup-badge dir">目录</span>}
          <span className="backup-path" title={b.relPath}>{b.relPath}</span>
        </div>
        <div className="memory-note-footer">
          <div className="memory-note-meta">
            {owner && <span className="memory-source manual">{owner}</span>}
            <span>{formatTime(b.createdAt)}</span>
            <span>{formatSize(b.size)}</span>
          </div>
          <div className="memory-note-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title={deleted ? "重新创建该文件/目录（内容为删除前的副本）" : "覆盖为备份时的内容"}
              onClick={() => void restore(b)}
            >
              还原
            </button>
          </div>
        </div>
      </div>
    );
  };

  const formatTime = (timestamp: number): string =>
    new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp);

  const formatSize = (size: number): string => {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div className="record-management security-management">
      <div className="record-tabs" role="group" aria-label="安全中心分类">
        <button type="button" aria-pressed={section === "settings"} onClick={() => setSection("settings")}>安全设置</button>
        <button type="button" aria-pressed={section === "backups"} onClick={() => setSection("backups")}>历史备份 <span>{backups.length}</span></button>
      </div>
      {section === "settings" && <div className="security-settings-scroll">
      <div className="radio-row security-setting-card">
        <div className="settings-row-label">系统操作策略</div>
        <label className="radio-option">
          <input type="radio" checked={policy === "default"} onChange={() => setPolicy("default")} />
          <span>
            <b>默认权限</b>（推荐）—— 产品工具的写入或危险操作需要审批；Pi 原生工具直接执行
          </span>
        </label>
        <label className="radio-option">
          <input
            type="radio"
            checked={policy === "readonly"}
            onChange={() => setPolicy("readonly")}
          />
          <span>
            <b>只读模式</b> —— 只允许读取和分析，不允许任何写入操作
          </span>
        </label>
        <label className="radio-option">
          <input type="radio" checked={policy === "auto"} onChange={() => setPolicy("auto")} />
          <span>
            <b>允许完全访问</b> —— 不推荐，仅在受信任的任务中使用
          </span>
        </label>
      </div>
      <div className="radio-row security-setting-card">
        <div className="settings-row-label">本机代码执行环境</div>
        <div className="settings-row-desc" style={{ marginBottom: 6 }}>
          此设置用于本机代码执行工具。Pi 原生命令工具使用 Pi 的 Shell 配置；用户终端使用自己的偏好。实验性环境加固不保证防止任意脚本越界。
        </div>
        <label className="radio-option">
          <input
            type="radio"
            checked={shellIsolation === "guarded"}
            onChange={() => void changeShellIsolation("guarded")}
          />
          <span>
            <b>guarded（推荐）</b> —— 使用任务工作目录防护
          </span>
        </label>
        <label className="radio-option">
          <input
            type="radio"
            checked={shellIsolation === "os-sandbox"}
            onChange={() => void changeShellIsolation("os-sandbox")}
          />
          <span>
            <b>os-sandbox（实验）</b> —— 加固代码执行环境；默认关闭
          </span>
        </label>
        <label className="radio-option">
          <input
            type="radio"
            checked={shellIsolation === "cwd-only"}
            onChange={() => void changeShellIsolation("cwd-only")}
          />
          <span>
            <b>cwd-only</b> —— 仅设置工作目录，用于兼容对比
          </span>
        </label>
      </div>

      </div>}
      {section === "backups" && <>
        <div className="record-intro">旧版本留下的历史文件副本，可查找并手动还原。当前版本不再自动创建备份。</div>
        <div className="record-toolbar">
          <input className="record-search" type="search" aria-label="搜索备份" placeholder="搜索文件路径、任务或空间" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />
          <button type="button" className="btn" onClick={loadBackups}><IconRefresh size={13} /> 刷新</button>
        </div>
        <div className="record-toolbar">
          <div className="record-tabs" role="group" aria-label="备份分类">
            {([['all', '全部'], ['spaces', '工作空间'], ['tasks', '任务']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => { setView(key); setGroup(""); setPage(1); }}>{label}</button>)}
          </div>
          {view !== "all" && <select className="record-select" aria-label={view === "spaces" ? "筛选空间" : "筛选任务"} value={selectedGroup ? group : ""} onChange={(e) => { setGroup(e.target.value); setPage(1); }}>
            <option value="">{view === "spaces" ? "所有空间" : "所有任务"}</option>
            {groups.map((g) => <option key={g.key} value={g.key}>{g.name}（{g.list.length}）</option>)}
          </select>}
        </div>
        <div className="record-list" ref={listRef}>
          {filteredBackups.length === 0 && <div className="record-empty"><IconShield size={28} /><b>{needle ? "没有匹配的备份" : "暂无历史备份"}</b><span>{needle ? "试试其他关键词，或清空搜索。" : "此处仅保留旧版本创建的文件副本。"}</span></div>}
          {filteredBackups.slice((currentPage - 1) * RECORD_PAGE_SIZE, currentPage * RECORD_PAGE_SIZE).map((b) => renderBackup(b, true))}
        </div>
        <RecordPager page={currentPage} total={filteredBackups.length} onChange={setPage} />
      </>}
      {status && <div className="record-status" role="status">{status}</div>}
    </div>
  );
}

function HelpTab(): React.JSX.Element {
  const versions = window.api?.versions;
  return (
    <div className="about-block">
      <div>
        <b>MyBuddy</b> v{APP_VERSION} — MyBuddy 形态的桌面 Agent
      </div>
      <div>Agent 底座：pi（@earendil-works，阶段 2 接入）</div>
      <div>
        Electron {versions?.electron ?? "-"} · Node {versions?.node ?? "-"}
      </div>
      <div>数据目录：~/.mybuddy</div>
      <div style={{ marginTop: 8 }}>
        <button className="btn">反馈问题</button> <button className="btn">检查更新</button>
      </div>
    </div>
  );
}

const TAB_TITLE: Record<SettingsTab, string> = {
  system: "设置",
  extensions: "工具能力",
  modes: "模式与提示词",
  personalize: "个性化",
  memory: "记忆",
  archive: "归档管理",
  models: "模型",
  assistant: "助理设置",
  acp: "ACP 管理",
  data: "数据管理",
  python: "Python 运行时",
  shortcuts: "快捷键",
  notifications: "通知",
  remote: "远程连接",
  security: "安全中心",
  help: "帮助与反馈",
};

export default function SettingsModal(): React.JSX.Element {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const tab = useAppStore((s) => s.settingsTab);
  useBlockNativeSurfaces(true);

  return (
    <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-nav-btn ${tab === t.id ? "active" : ""}`}
              onClick={() => useAppStore.setState({ settingsTab: t.id })}
            >
              <span className="nav-icon">
                <t.icon size={15} />
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="settings-content">
          <div className="settings-content-head">
            <span className="settings-content-title">{TAB_TITLE[tab]}</span>
            <button className="icon-btn" onClick={() => setSettingsOpen(false)}>
              <IconX size={16} />
            </button>
          </div>
          <div className="settings-content-body">
            {tab === "system" && <SystemTab />}
            {tab === "extensions" && <CapabilitiesTab />}
            {tab === "modes" && <ModesTab />}
            {tab === "personalize" && <PersonalizeTab />}
            {tab === "memory" && <MemoryTab />}
            {tab === "archive" && <ArchivesTab />}
            {tab === "models" && <ModelsTab />}
            {tab === "assistant" && <AssistantTab />}
            {tab === "acp" && <AcpTab />}
            {tab === "data" && <DataTab />}
            {tab === "python" && <PythonRuntimeTab />}
            {tab === "shortcuts" && <ShortcutsTab />}
            {tab === "notifications" && <NotificationsTab />}
            {tab === "remote" && <RemoteAccessTab />}
            {tab === "security" && <SecurityTab />}
            {tab === "help" && <HelpTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
