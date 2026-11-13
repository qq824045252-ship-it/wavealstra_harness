import { create } from "zustand";
import { useEffect } from "react";
import type { BotAvatarCommand, BotAvatarSnapshot } from "@shared/bot-avatar";
interface State { snapshot: BotAvatarSnapshot | null; error: string; images: Record<string,string | null>; }
export const useBotAvatarStore = create<State>(() => ({snapshot:null,error:"",images:{}}));
let loading: Promise<void> | undefined;
const imageRequests = new Map<string,Promise<void>>();
export async function avatarCommand(request: BotAvatarCommand) {
  if (!window.api?.botWork?.avatars) throw new Error("头像接口尚未就绪，请重启应用");
  const result = await window.api.botWork.avatars(request);
  if (!result.ok) throw new Error(result.message);
  if (request.kind !== "read") useBotAvatarStore.setState({snapshot:result.snapshot,error:""});
  if (result.importedId) useBotAvatarStore.setState(state => {const images={...state.images};delete images[result.importedId!];delete images[`${result.importedId}:animation`];return {images};});
  if (request.kind === "remove") useBotAvatarStore.setState(state => ({images:{...state.images,[request.assetId]:null,[`${request.assetId}:animation`]:null}}));
  return result;
}
export function loadBotAvatars(force = false): Promise<void> {
  if (!force && useBotAvatarStore.getState().snapshot) return Promise.resolve();
  if (loading) return loading;
  if (force) useBotAvatarStore.setState({images:{}});
  loading = avatarCommand({kind:"list"}).then(() => {}).catch(error => {
    useBotAvatarStore.setState({error:error instanceof Error ? error.message : "头像读取失败"});
  }).finally(() => {loading=undefined;});
  return loading;
}
export function useBotAvatars() {
  const snapshot = useBotAvatarStore(state => state.snapshot);
  useEffect(() => { if (!useBotAvatarStore.getState().snapshot && !useBotAvatarStore.getState().error) void loadBotAvatars(); }, []);
  return snapshot;
}
export function loadAvatarImage(id: string,variant: "poster" | "animation" = "poster"): Promise<void> {
  const key=variant === "animation" ? `${id}:animation` : id;
  if (Object.hasOwn(useBotAvatarStore.getState().images,key)) return Promise.resolve();
  const current = imageRequests.get(key);
  if (current) return current;
  const request = avatarCommand({kind:"read",assetId:id,variant}).then(result => {
    // Only the requested private PNG poster or sanitized GIF data may enter an image source.
    const image = result.image?.match(variant === "animation" ? /^data:image\/gif;base64,[A-Za-z0-9+/=]+$/ : /^data:image\/png;base64,[A-Za-z0-9+/=]+$/) ? result.image : null;
    useBotAvatarStore.setState(state => {
      const images={...state.images,[key]:image};
      // At most four private GIFs remain cached; lists never request them.
      const animations=Object.keys(images).filter(key=>key.endsWith(":animation"));
      for(const old of animations.slice(0,-4))delete images[old];
      return {images};
    });
  }).catch(() => {useBotAvatarStore.setState(state => ({images:{...state.images,[key]:null}}));})
    .finally(() => {imageRequests.delete(key);});
  imageRequests.set(key,request);
  return request;
}
