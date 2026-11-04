import type { LocalConnectorDto } from "../../../../../shared/agent-ipc";
import type { Expert, MarketExpert, Skill } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export interface CapabilitiesState {
  skills: Skill[];
  marketSkills: Skill[];
  experts: Expert[];
  marketExperts: MarketExpert[];
  connectors: LocalConnectorDto[];
}

export function createCapabilitiesState(): CapabilitiesState {
  return {
    skills: [],
    marketSkills: [],
    experts: [],
    marketExperts: [],
    connectors: [],
  };
}

export function createCapabilitiesActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "refreshSkills"
  | "setSkillEnabled"
  | "installSkill"
  | "installSkillByPath"
  | "uninstallSkill"
  | "deleteMarketSkill"
  | "refreshExperts"
  | "installExpert"
  | "installExpertByPath"
  | "importExpertZip"
  | "uninstallExpert"
  | "deleteMarketExpert"
  | "setExpertEnabled"
  | "refreshConnectors"
  | "installConnector"
  | "importConnectorByPath"
  | "importConnectorZip"
  | "uninstallConnector"
  | "deleteMarketConnector"
  | "setConnectorEnabled"
> {
  const { get, set } = storeContext;
  return {
    refreshSkills: async () => {
      const api = storeContext.getApi()?.agent;
      if (!api) return;
      const space = get().spaces.find((s) => s.id === get().homeSpaceId);
      const cwd = space?.path;
      const [skillRows, marketRows] = await Promise.all([
        api.listSkills(cwd),
        api.listMarketSkills?.(cwd) ?? Promise.resolve([]),
      ]);
      set({
        skills: skillRows.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          author: s.author,
          icon: s.icon,
          installed: s.installed,
          enabled: s.enabled,
          builtin: s.builtin,
          command: s.command,
          filePath: s.filePath,
          source: s.source,
        })),
        marketSkills: marketRows.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          author: s.author,
          icon: s.icon,
          installed: false,
          enabled: false,
          command: s.name,
          version: s.version,
          source: s.source,
        })),
      });
    },

    setSkillEnabled: (id, enabled) => {
      set((s) => ({
        skills: s.skills.map((x) => (x.id === id ? { ...x, enabled } : x)),
      }));
      void storeContext
        .getApi()
        ?.agent?.setSkillEnabled?.(id, enabled)
        .then(() => {
          void get().refreshSkills();
        })
        .catch((err) => console.warn("[setSkillEnabled]", err));
    },

    installSkill: async (id) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.installSkill;
      if (!fn || !agentApi)
        throw new Error("安装技能 API 不可用，请完全退出并重启应用");
      const clean = id.trim();
      if (!clean) throw new Error("技能 id 为空");
      await fn.call(agentApi, clean);
      await get().refreshSkills();
    },

    installSkillByPath: async (path) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.installSkillByPath;
      if (!fn || !agentApi)
        throw new Error("从文件夹导入技能 API 不可用，请完全退出并重启应用");
      const clean = path.trim();
      if (!clean) throw new Error("请选择有效的本地技能目录（需含 SKILL.md）");
      const dto = await fn.call(agentApi, clean);
      await get().refreshSkills();
      if (!dto) return null;
      const fromList = get().skills.find(
        (s) => s.id === dto.id || s.name === dto.name,
      );
      return (
        fromList ?? {
          id: dto.id,
          name: dto.name,
          description: dto.description,
          author: dto.author,
          icon: dto.icon,
          installed: dto.installed,
          enabled: dto.enabled,
          builtin: dto.builtin,
          command: dto.command,
          filePath: dto.filePath,
        }
      );
    },

    uninstallSkill: async (id) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.uninstallSkill;
      if (!fn || !agentApi)
        throw new Error("卸载技能 API 不可用，请完全退出并重启应用");
      const clean = id.trim();
      if (!clean) throw new Error("技能 id 为空");
      await fn.call(agentApi, clean);
      await get().refreshSkills();
    },

    deleteMarketSkill: async (id) => {
      const fn = storeContext.getApi()?.agent?.deleteMarketSkill;
      if (!fn) {
        throw new Error("删除市场技能 API 不可用，请完全退出并重启应用");
      }
      await fn.call(storeContext.getApi()?.agent, id);
      await get().refreshSkills();
    },

    refreshExperts: async () => {
      const api = storeContext.getApi()?.agent;
      if (!api) return;
      const [expertRows, marketRows] = await Promise.all([
        api.listExperts?.() ?? Promise.resolve([]),
        api.listMarketExperts?.() ?? Promise.resolve([]),
      ]);
      set({
        experts: expertRows.map((e) => ({ ...e, installed: true })),
        marketExperts: marketRows.map((e) => ({
          ...e,
          installed: false,
          enabled: false,
        })),
      });
    },

    installExpert: async (id) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.installExpert;
      if (!fn || !agentApi)
        throw new Error("安装专家 API 不可用，请完全退出并重启应用");
      await fn.call(agentApi, id);
      await get().refreshExperts();
    },

    installExpertByPath: async (path) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.installExpertByPath;
      if (!fn || !agentApi)
        throw new Error("从文件夹导入 API 不可用，请完全退出并重启应用");
      const clean = path.trim();
      if (!clean) throw new Error("请选择有效的本地文件夹路径");
      const dto = await fn.call(agentApi, clean);
      await get().refreshExperts();
      if (!dto) return null;
      const fromList = get().experts.find(
        (e) => e.id === dto.id || e.name === dto.name,
      );
      return fromList ?? { ...dto, installed: true };
    },

    importExpertZip: async (zipPath) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.importExpertZip;
      if (!fn || !agentApi)
        throw new Error("导入 ZIP API 不可用，请完全退出并重启应用");
      const clean = zipPath.trim();
      if (!clean) throw new Error("请选择有效的 ZIP 文件");
      if (!clean.toLowerCase().endsWith(".zip"))
        throw new Error("仅支持 .zip 专家包，请选择 ZIP 文件");
      const dto = await fn.call(agentApi, clean);
      await get().refreshExperts();
      if (!dto) return null;
      const fromList = get().experts.find(
        (e) => e.id === dto.id || e.name === dto.name,
      );
      return fromList ?? { ...dto, installed: true };
    },

    uninstallExpert: async (id) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.uninstallExpert;
      if (!fn || !agentApi)
        throw new Error("卸载专家 API 不可用，请完全退出并重启应用");
      const clean = id.trim();
      if (!clean) throw new Error("专家 id 为空，无法卸载");
      await fn.call(agentApi, clean);
      await get().refreshExperts();
    },

    deleteMarketExpert: async (id) => {
      const fn = storeContext.getApi()?.agent?.deleteMarketExpert;
      if (!fn) {
        throw new Error("删除市场专家 API 不可用，请完全退出并重启应用");
      }
      await fn.call(storeContext.getApi()?.agent, id);
      await get().refreshExperts();
    },

    setExpertEnabled: (id, enabled) => {
      void storeContext
        .getApi()
        ?.agent?.setExpertEnabled?.(id, enabled)
        .then(() => get().refreshExperts())
        .catch((err) => console.warn("[setExpertEnabled]", err));
    },

    refreshConnectors: async () => {
      const rows =
        (await storeContext.getApi()?.agent?.listConnectors?.()) ?? [];
      set({ connectors: rows });
    },

    installConnector: async (id) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.installConnector;
      if (!fn || !agentApi)
        throw new Error("安装连接器 API 不可用，请完全退出并重启应用");
      const clean = id.trim();
      if (!clean) throw new Error("连接器 id 为空");
      const names = (await fn.call(agentApi, clean)) ?? [];
      await get().refreshConnectors();
      await get().refreshSkills();
      return names;
    },

    importConnectorByPath: async (path) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.importConnectorByPath;
      if (!fn || !agentApi)
        throw new Error("连接器目录导入 API 不可用，请完全退出并重启应用");
      const dto = await fn.call(agentApi, path);
      await get().refreshConnectors();
      await get().refreshSkills();
      return dto;
    },

    importConnectorZip: async (zipPath) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.importConnectorZip;
      if (!fn || !agentApi)
        throw new Error("连接器 ZIP 导入 API 不可用，请完全退出并重启应用");
      const dto = await fn.call(agentApi, zipPath);
      await get().refreshConnectors();
      await get().refreshSkills();
      return dto;
    },

    uninstallConnector: async (id) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.uninstallConnector;
      if (!fn || !agentApi)
        throw new Error("卸载连接器 API 不可用，请完全退出并重启应用");
      const clean = id.trim();
      if (!clean) throw new Error("连接器 id 为空");
      await fn.call(agentApi, clean);
      await get().refreshConnectors();
      await get().refreshSkills();
    },

    deleteMarketConnector: async (id) => {
      const fn = storeContext.getApi()?.agent?.deleteMarketConnector;
      if (!fn) {
        throw new Error("删除市场连接器 API 不可用，请完全退出并重启应用");
      }
      await fn.call(storeContext.getApi()?.agent, id);
      await get().refreshConnectors();
      await get().refreshSkills();
    },

    setConnectorEnabled: async (id, enabled) => {
      const agentApi = storeContext.getApi()?.agent;
      const fn = agentApi?.setConnectorEnabled;
      if (!fn || !agentApi)
        throw new Error("启停连接器 API 不可用，请完全退出并重启应用");
      const clean = id.trim();
      if (!clean) throw new Error("连接器 id 为空");
      await fn.call(agentApi, clean, enabled);
      await get().refreshConnectors();
    },
  };
}
