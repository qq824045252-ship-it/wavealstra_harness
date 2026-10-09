/** Minimal store surface for MultiModelConsultCard: only what the card reads/writes. */
const appended: string[] = [];

export const state = {
  activeTaskId: "task-consult" as string | null,
};

export const appendCalls = appended;

const api = {
  ...state,
  appendComposer: (text: string): void => { appended.push(text); },
};

export const useAppStore = Object.assign(
  (selector: (value: typeof api) => unknown) => selector(api),
  { getState: () => api },
);
