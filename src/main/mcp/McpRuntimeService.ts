import { isPiCodeModeEnabled, piCodeModeState, type PiCodeModeState } from '../../shared/pi-code-mode';
/** Native Pi MCP for both task sessions and the desktop manager. No legacy protocol runtime. */
import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import {
  createAgentSession, createCodemodeExtension, createEventBus, createMcpExtension, createToolSearchExtension,
  DefaultResourceLoader, SessionManager, SettingsManager, McpOAuthCredentialStore,
  type AgentSession, type EventBusController, type Extension, type ExtensionUIContext,
  type InlineExtension, type LoadExtensionsResult, type ModelRuntime, type McpHostController, type McpHostSnapshot,
} from '@earendil-works/pi-coding-agent';
import { getMyBuddyDir } from '../paths';
import { getPluginDirectory, getPluginStorage } from '../plugins/PluginStorage';
import { McpIpc, type McpStatusSnapshotDto, type McpProxyResultDto, type McpServerToolsDto } from '../../shared/agent-ipc';
import type { ModeMcpPolicy, WelcomeMode } from '../../shared/mode-profile';
import type { SourcedMcpPolicy } from '../../shared/runtime-policy';
import { filterMcpConfigForMode, emptyMcpFilterResult, type McpFilterResult } from './McpModeFilter';
import { McpConfigService } from './McpConfigService';
import { toNativeMcpConfig } from './NativeMcpConfig';
import { McpCredentialBackend } from './McpCredentialBackend';
import { createPolicyAwareNativeMcpExtension } from './native-mcp-extension';
export { toNativeMcpConfig } from './NativeMcpConfig';
export type { McpProxyResultDto } from '../../shared/agent-ipc';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
interface UiWaiter { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }
interface NativeSession {
  extensions: Extension[]; bus: EventBusController; controller?: McpHostController;
  snapshot?: McpStatusSnapshotDto; token?: symbol;
  codeMode?: PiCodeModeState; readCodeModeActive?: () => boolean;
}
interface AuthFlow { cancelled?: boolean; redirect?: (value: string | undefined) => void; completion: Promise<McpProxyResultDto>; }
const UI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const MCP_HEADLESS_SESSION_ID = 'mcp-headless';
export interface McpRuntimeOptions { configService?: McpConfigService; agentDir?: string; credentials?: McpOAuthCredentialStore; }

export class McpRuntimeService {
  private readonly sessions = new Map<string, NativeSession>();
  private readonly uiWaiters = new Map<string, UiWaiter>();
  private readonly authFlows = new Map<string, AuthFlow>();
  private readonly authStarting = new Set<string>();
  private authEpoch = 0;
  private readonly configService: McpConfigService;
  private readonly agentDir: string;
  private credentials: McpOAuthCredentialStore | undefined;
  private headlessSession: AgentSession | null = null;
  private headlessOpening: Promise<boolean> | undefined;
  private headlessFingerprint = '';
  private modelRuntime: ModelRuntime | null = null;
  private uiBridge: ExtensionUIContext | null = null;
  private uiSeq = 0;
  private epoch = 0;
  constructor(options: McpRuntimeOptions = {}) {
    this.agentDir = options.agentDir ?? getMyBuddyDir();
    this.configService = options.configService ?? (options.agentDir
      ? new McpConfigService({ appGlobalPath: getPluginStorage(this.agentDir).mcpConfig })
      : new McpConfigService());
    this.credentials = options.credentials;
  }
  init(): void { /* Paths are explicit; never mutate a global Pi environment variable. */ }
  private credentialStore(): McpOAuthCredentialStore {
    return this.credentials ??= new McpOAuthCredentialStore(
      new McpCredentialBackend(join(getPluginDirectory('mcp', this.agentDir), 'mcp-native-auth.encrypted.json')),
      join(getPluginDirectory('mcp', this.agentDir), 'mcp-native-refresh-locks'),
    );
  }
  getInlineExtensions(opts?: {
    welcomeMode?: WelcomeMode; mcpPolicy?: ModeMcpPolicy | null; mcpFilter?: McpFilterResult; sessionLabel?: string;
  }): InlineExtension[] {
    const label = !opts?.sessionLabel || opts.sessionLabel === 'headless' ? MCP_HEADLESS_SESSION_ID : opts.sessionLabel;
    const full = this.configService.loadRuntimeConfig();
    const filtered = opts?.mcpFilter ?? (opts?.welcomeMode
      ? filterMcpConfigForMode(full, opts.welcomeMode, opts.mcpPolicy) : emptyMcpFilterResult(full));
    const codeModeEnabled = isPiCodeModeEnabled(opts?.welcomeMode);
    const config = toNativeMcpConfig(filtered, this.configService.getAppGlobalConfigPath(), codeModeEnabled);
    const token = Symbol(label);
    const factoryEpoch = this.epoch;
    return [
      // Pi's models facade exposes catalog lookup, explicit classification and image generation.
      // It uses this session's native ModelRegistry/auth; no chat stream or automatic router is added.
      ...(codeModeEnabled ? [createCodemodeExtension({ mode: 'on', models: true })] : []),
      // Discovery remains native and usable in office/design scenes without Code Mode.
      createToolSearchExtension(),
      createPolicyAwareNativeMcpExtension({
        loadConfig: () => structuredClone(config),
        credentials: this.credentialStore(),
        logPath: join(getPluginDirectory('mcp', this.agentDir), 'mcp-native.log'),
        openUrl: url => { void shell.openExternal(url); },
        updateConfig: () => { throw new Error('MCP 配置由能力管理页统一维护，请在管理页修改。'); },
        onController: controller => {
          if (factoryEpoch !== this.epoch) {
            void controller.close().catch(error => console.warn('[McpRuntime] stale controller close failed:', message(error)));
            return;
          }
          const entry = this.sessions.get(label) ?? { extensions: [], bus: createEventBus() };
          entry.controller = controller; entry.token = token; this.sessions.set(label, entry);
        },
        onStateChange: state => {
          const entry = this.sessions.get(label);
          if (!entry || entry.token !== token) return;
          entry.snapshot = this.snapshot(label, state);
          broadcast(McpIpc.statusEvent, entry.snapshot);
        },
      }, config.servers.map(server => server.name)),
    ];
  }
  private snapshot(sessionId: string, state: McpHostSnapshot): McpStatusSnapshotDto {
    const servers = state.servers.map(server => ({
      name: server.name,
      status: !server.enabled ? 'disabled' as const
        : server.state === 'connected' ? 'connected' as const
        : server.state === 'needs-auth' ? 'needs-auth' as const
        : server.state === 'failed' ? 'failed' as const
        : server.state === 'connecting' ? 'connecting' as const : 'not-connected' as const,
      disabled: !server.enabled, toolCount: server.toolCount, resourceCount: server.resourceCount,
      error: server.error, exposure: server.exposure, hasCredentials: server.hasCredentials, oauth: server.oauth,
    }));
    return { version: 1, sessionId, runtime: 'pi-native', codeMode: this.codeModeState(sessionId), errors: state.errors, servers,
      totalTools: servers.reduce((n,s) => n+s.toolCount,0), totalResources: servers.reduce((n,s) => n+(s.resourceCount??0),0),
      connectedCount: servers.filter(s => s.status === 'connected').length,
      disabledCount: servers.filter(s => s.disabled).length };
  }
  previewMcpFilter(welcomeMode: WelcomeMode, mcpPolicy?: ModeMcpPolicy | null, policySources?: SourcedMcpPolicy[]): McpFilterResult {
    return filterMcpConfigForMode(this.configService.loadRuntimeConfig(), welcomeMode, mcpPolicy, policySources);
  }
  createEventBus(taskId: string): EventBusController {
    this.detachSession(taskId);
    const bus = createEventBus(); this.sessions.set(taskId,{extensions:[],bus}); return bus;
  }
  attachSession(taskId: string, result: LoadExtensionsResult, _enabledServers: string[] = [], codeMode?: { session: Pick<AgentSession, "getActiveToolNames">; welcomeMode: WelcomeMode }): void {
    const entry = this.sessions.get(taskId);
    if (entry) entry.extensions = result.extensions;
    else this.sessions.set(taskId,{extensions:result.extensions,bus:createEventBus()});
    if (codeMode) {
      const current = this.sessions.get(taskId)!;
      current.codeMode = piCodeModeState(codeMode.welcomeMode, null);
      current.readCodeModeActive = () => codeMode.session.getActiveToolNames().includes("codemode");
      const snapshot = this.getStatus(taskId);
      if (snapshot) broadcast(McpIpc.statusEvent, snapshot);
    }
  }
  detachSession(taskId: string): void {
    const entry = this.sessions.get(taskId); if (!entry) return;
    this.sessions.delete(taskId); entry.bus.clear();
    if (entry.snapshot && entry.codeMode) broadcast(McpIpc.statusEvent, { ...entry.snapshot, codeMode: { ...entry.codeMode, active: null } });
    void entry.controller?.close().catch(error => console.warn('[McpRuntime] close failed:',message(error)));
  }
  async ensureHeadlessSession(): Promise<boolean> {
    if (this.headlessOpening) {
      if (!await this.headlessOpening) return false;
      if (JSON.stringify(this.configService.loadRuntimeConfig()) === this.headlessFingerprint) return true;
      return this.ensureHeadlessSession();
    }
    const fingerprint = JSON.stringify(this.configService.loadRuntimeConfig());
    if (this.headlessSession && fingerprint === this.headlessFingerprint) return true;
    this.detachSession(MCP_HEADLESS_SESSION_ID); this.headlessSession?.dispose(); this.headlessSession = null;
    const epoch = this.epoch;
    this.headlessOpening = (async () => {
      let session: AgentSession | undefined;
      try {
        const settingsManager = SettingsManager.inMemory({ defaultTools: ['+tool_search'] });
        const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: this.agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          eventBus: this.createEventBus(MCP_HEADLESS_SESSION_ID),
          extensionFactories: this.getInlineExtensions({ sessionLabel: MCP_HEADLESS_SESSION_ID }) });
        await loader.reload();
        const result = await createAgentSession({ cwd: process.cwd(), agentDir: this.agentDir, settingsManager,
          sessionManager: SessionManager.inMemory(), modelRuntime: this.modelRuntime ?? undefined, resourceLoader: loader });
        session = result.session;
        if (epoch !== this.epoch) { session.dispose(); return false; }
        await session.bindExtensions({ uiContext: this.getUiBridge(), mode: 'rpc' });
        if (epoch !== this.epoch) { await session.extensionRunner?.emit({type:'session_shutdown',reason:'quit'}); session.dispose(); return false; }
        this.attachSession(MCP_HEADLESS_SESSION_ID,result.extensionsResult);
        this.headlessSession=session; this.headlessFingerprint=fingerprint;
        return true;
      } catch(error) {
        this.detachSession(MCP_HEADLESS_SESSION_ID); session?.dispose();
        console.warn('[McpRuntime] native manager failed:',message(error)); return false;
      }
    })().finally(() => { this.headlessOpening=undefined; });
    return this.headlessOpening;
  }
  attachModelRuntime(runtime: ModelRuntime): void { this.modelRuntime=runtime; }
  getUiBridge(): ExtensionUIContext { return this.uiBridge ??= this.createUiBridge(); }
  private codeModeState(taskId: string): PiCodeModeState | undefined {
    const entry = this.sessions.get(taskId);
    if (!entry?.codeMode) return undefined;
    let active: boolean | null = null;
    try { active = entry.readCodeModeActive?.() ?? null; } catch { /* disposed session */ }
    return { ...entry.codeMode, active };
  }
  getStatus(taskId?: string): McpStatusSnapshotDto | null {
    const id = taskId ?? MCP_HEADLESS_SESSION_ID, entry = this.sessions.get(id);
    if (!entry) return null;
    const codeMode = this.codeModeState(id);
    if (entry.snapshot) return { ...entry.snapshot, codeMode };
    return codeMode ? { version: 1, sessionId: id, runtime: "pi-native", codeMode, servers: [], totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0 } : null;
  }
  getServerStatus(name: string, taskId?: string) { return this.getStatus(taskId)?.servers.find(server => server.name===name); }
  async getServerTools(name: string): Promise<McpServerToolsDto> {
    if (!await this.ensureHeadlessSession()) throw new Error('原生 MCP 管理会话未就绪');
    if (!this.getServerStatus(name)) throw new Error('未找到 MCP 服务器: ' + name);
    const prefix = 'mcp__' + name.replace(/-/g, '_') + '__';
    return { name, tools: (this.headlessSession?.getAllTools() ?? []).filter(tool => tool.name.startsWith(prefix))
      .map(tool => ({ name: tool.name, description: tool.description, exposure: tool.exposure, parameters: tool.parameters })) };
  }
  dispose(): void {
    this.epoch++;
    for (const flow of this.authFlows.values()) { flow.cancelled=true; flow.redirect?.(undefined); }
    for (const id of [...this.sessions.keys()]) this.detachSession(id);
    this.headlessSession?.dispose(); this.headlessSession=null; this.headlessFingerprint='';
    this.rejectAllUiWaiters('MCP 运行时已关闭');
  }
  private async controller(taskId?: string): Promise<McpHostController> {
    if (!taskId && !await this.ensureHeadlessSession()) throw new Error('原生 MCP 管理会话未就绪');
    const controller=this.sessions.get(taskId ?? MCP_HEADLESS_SESSION_ID)?.controller;
    if (!controller) throw new Error(taskId ? '当前任务没有 MCP 运行时' : '原生 MCP 管理会话未就绪');
    return controller;
  }
  async connect(name: string, taskId?: string): Promise<McpProxyResultDto> {
    try { const controller=await this.controller(taskId); await controller.reconnect(name);
      return {ok:true,text:'已连接 '+name,details:{server:name,runtime:'pi-native',sessionId:taskId??MCP_HEADLESS_SESSION_ID}};
    } catch(error) { return {ok:false,error:message(error)}; }
  }
  private authConfigurationError(name: string): string | null {
    const entry = this.configService.loadRuntimeConfig().mcpServers[name];
    if (!entry || typeof entry.url !== 'string') return null;
    let host = '';
    try { host = new URL(entry.url).hostname.toLowerCase(); } catch { return null; }
    if (host !== 'mcp.slack.com') return null;
    const oauth = entry.oauth && typeof entry.oauth === 'object' && !Array.isArray(entry.oauth)
      ? entry.oauth as Record<string, unknown> : {};
    const clientId = typeof oauth.clientId === 'string' ? oauth.clientId.trim() : '';
    const unresolved = !clientId
      || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(clientId)
      || clientId === 'REPLACE_WITH_SLACK_APP_CLIENT_ID';
    return unresolved
      ? 'Slack MCP 需要真实 Slack App Client ID；当前仍未配置。请先填写 Slack Internal App 的 Client ID，再开始 OAuth 授权。'
      : null;
  }
  async authStart(name: string, taskId?: string): Promise<McpProxyResultDto> {
    const configurationError=this.authConfigurationError(name);
    if(configurationError)return {ok:false,error:configurationError};
    const key=(taskId??MCP_HEADLESS_SESSION_ID)+'/'+name;
    if(this.authFlows.has(key) || this.authStarting.has(key)) return {ok:false,error:'该服务器的授权流程正在进行'};
    // Reserve before awaiting manager startup so double clicks cannot start two PKCE flows.
    this.authStarting.add(key);
    const epoch = this.epoch, authEpoch = this.authEpoch;
    try {
      const controller=await this.controller(taskId);
      if (epoch !== this.epoch || authEpoch !== this.authEpoch) throw new Error('MCP 授权已取消或运行时已关闭');
      let report!: (result:McpProxyResultDto)=>void;
      const ready=new Promise<McpProxyResultDto>(resolve=>{report=resolve;});
      const flow:AuthFlow={completion:Promise.resolve({ok:false})};
      this.authFlows.set(key,flow);
      flow.completion=controller.signIn(name,{
        showAuthorizationUrl: url => {
          if (flow.cancelled) throw new Error("授权已取消");
          report({ok:true,details:{server:name,authorizationUrl:url.href,runtime:'pi-native'}});
          void shell.openExternal(url.href).catch(error=>broadcast(McpIpc.notify,{message:message(error),type:'error',at:Date.now()}));
        },
        promptForRedirectUrl: signal => new Promise(resolve=>{
          let done=false;
          const finish=(value:string|undefined)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);resolve(value);};
          const aborted=()=>finish(undefined);
          const timer=setTimeout(aborted,UI_REQUEST_TIMEOUT_MS);
          flow.redirect=finish;
          if(signal.aborted || flow.cancelled) aborted(); else signal.addEventListener('abort',aborted,{once:true});
        }),
      }).then(()=>({ok:true,details:{server:name,authenticated:true,runtime:'pi-native'}} as McpProxyResultDto))
        .catch(error=>({ok:false,error:message(error)} as McpProxyResultDto))
        .then(result=>{report(result);broadcast(McpIpc.notify,{message:result.ok?'MCP 授权成功：'+name:result.error,type:result.ok?'info':'error',at:Date.now()});return result;})
        .finally(()=>{this.authFlows.delete(key);});
      return ready;
    } catch(error){this.authFlows.delete(key);return {ok:false,error:message(error)};}
    finally { this.authStarting.delete(key); }
  }
  async authComplete(name:string,input:string,taskId?:string):Promise<McpProxyResultDto>{
    const flow=this.authFlows.get((taskId??MCP_HEADLESS_SESSION_ID)+'/'+name);
    if(!flow?.redirect)return {ok:false,error:'没有等待回调的原生授权流程，请重新开始授权'};
    flow.redirect(input);return flow.completion;
  }
  async logout(name:string):Promise<{ok:boolean;error?:string}>{
    try {
      // A pending sign-in must finish/cancel before removal, otherwise a late token exchange
      // could resurrect credentials after the user has explicitly signed out.
      const pending=[...this.authFlows.entries()].filter(([key])=>key.endsWith('/'+name)).map(([,flow])=>flow);
      for(const flow of pending){flow.cancelled=true;flow.redirect?.(undefined);}
      await Promise.allSettled(pending.map(flow=>flow.completion));
      const config=this.configService.loadRuntimeConfig().mcpServers[name];
      if(typeof config?.url==='string')this.credentialStore().remove(name, config.url);
      const results=await Promise.allSettled([...this.sessions.values()].filter(s=>s.snapshot?.servers.some(server=>server.name===name&&!server.disabled)).map(s=>s.controller?.signOut(name)));
      const failure=results.find(result=>result.status==='rejected');
      if(failure?.status==='rejected')throw failure.reason;
      return {ok:true};
    }catch(error){return {ok:false,error:message(error)};}
  }
  hasCredentials(name:string):boolean{
    const entry=this.configService.loadRuntimeConfig().mcpServers[name];
    return typeof entry?.url==='string' && !!this.credentialStore().tokens(name, entry.url);
  }
  /** renderer 对 mcp:uiPrompt 的应答 */
  respondUi(requestId: string, value: string | boolean | undefined): boolean {
    const waiter = this.uiWaiters.get(requestId);
    if (!waiter) return false;
    this.uiWaiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
    return true;
  }

  cancelUi(requestId?: string): void {
    if (requestId) {
      const waiter = this.uiWaiters.get(requestId);
      if (waiter) {
        this.uiWaiters.delete(requestId);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("用户取消"));
      }
      return;
    }
    this.authEpoch++;
    for (const flow of this.authFlows.values()) { flow.cancelled=true; flow.redirect?.(undefined); }
    this.rejectAllUiWaiters("用户取消");
  }

  private createUiBridge(): ExtensionUIContext {
    const notify = (message: string, type?: "info" | "warning" | "error"): void => {
      broadcast(McpIpc.notify, { message, type: type ?? "info", at: Date.now() });
    };
    return {
      notify,
      confirm: (title, message) => this.requestUi<boolean>("confirm", { title, message }),
      select: (title, options) => this.requestUi<string>("select", { title, options }),
      input: (title, placeholder) => this.requestUi<string>("input", { title, placeholder }),
      editor: (title, prefill) => this.requestUi<string>("editor", { title, prefill }),
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: (() => undefined) as ExtensionUIContext["setFooter"],
      setHeader: (() => undefined) as ExtensionUIContext["setHeader"],
      setTitle: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      pasteToEditor: () => {},
      addAutocompleteProvider: () => {},
      setEditorComponent: (() => undefined) as ExtensionUIContext["setEditorComponent"],
      getEditorComponent: () => undefined,
      theme: {
        fg: (() => "") as ExtensionUIContext["theme"]["fg"],
        bg: (() => "") as ExtensionUIContext["theme"]["bg"],
      } as ExtensionUIContext["theme"],
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "UI not available" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      onTerminalInput: () => () => {},
      custom: (() => Promise.resolve(undefined)) as ExtensionUIContext["custom"],
    };
  }

  private requestUi<T extends string | boolean | undefined>(
    kind: "confirm" | "select" | "input" | "editor",
    payload: Record<string, unknown>,
  ): Promise<T> {
    const requestId = `mcp-ui-${++this.uiSeq}-${Date.now()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.uiWaiters.delete(requestId);
        reject(new Error("MCP 交互超时"));
      }, UI_REQUEST_TIMEOUT_MS);
      this.uiWaiters.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      broadcast(McpIpc.uiPrompt, { requestId, kind, ...payload });
    });
  }

  private rejectAllUiWaiters(message: string): void {
    for (const [id, waiter] of this.uiWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      this.uiWaiters.delete(id);
    }
  }


}
export const mcpRuntimeService=new McpRuntimeService();
