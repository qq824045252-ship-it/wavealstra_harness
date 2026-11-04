import { createAppStore } from "./createAppStore";

const app = createAppStore();
export const useAppStore = app.useAppStore;
export const appSelectors = app.appSelectors;
/** Only compatibility adapters use this; domain modules receive it by injection. */
export const appContext = app.context;
