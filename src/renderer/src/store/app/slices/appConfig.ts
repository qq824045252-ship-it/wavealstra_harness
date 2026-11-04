import { normalizeReasoningPreference } from "../../../../../shared/model-metadata";
import type { ModelPreferencesDto } from "../../../../../shared/model-metadata";
import type { ModelConfig, Soul } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { EMPTY_SOUL } from "../defaults";

export interface AppConfigState {
  conversationBranchEnabled: boolean;
  models: ModelConfig[];
  defaultModelId: string;
  modelPreferences: ModelPreferencesDto;
  soul: Soul;
}

export function createAppConfigState(): AppConfigState {
  return {
    conversationBranchEnabled: false,
    models: [],
    defaultModelId: "",
    modelPreferences: {},
    soul: EMPTY_SOUL,
  };
}

export function createAppConfigActions(
  storeContext: AppContext,
): Pick<AppActions, "setModelReasoningPreference" | "updateSoul"> {
  const { get, set } = storeContext;
  return {
    setModelReasoningPreference: (modelId, preference) => {
      const id = modelId.trim();
      if (!id) return;
      const model = get().models.find((candidate) => candidate.id === id);
      const normalized = normalizeReasoningPreference(
        preference,
        model?.metadata,
      );
      const previousPreferences = get().modelPreferences;
      const nextPreferences: ModelPreferencesDto = { ...previousPreferences };
      if (normalized) nextPreferences[id] = { reasoning: normalized };
      else delete nextPreferences[id];

      set({ modelPreferences: nextPreferences });
      void storeContext
        .getApi()
        ?.agent?.updateAppSettings?.({ modelPreferences: nextPreferences })
        .then((settings) => {
          if (get().modelPreferences === nextPreferences)
            set({ modelPreferences: settings.modelPreferences ?? {} });
        })
        .catch((error) => {
          if (get().modelPreferences === nextPreferences)
            set({ modelPreferences: previousPreferences });
          console.error("保存 Pi 思考偏好失败", error);
        });
    },

    updateSoul: (soul) => {
      set((s) => ({ soul: { ...s.soul, ...soul } }));
      const next = { ...get().soul, ...soul };
      void storeContext.getApi()?.db?.updateSoul(next);
    },
  };
}
