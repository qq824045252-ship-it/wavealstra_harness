import { builtinBotAvatars } from "../src/shared/bot-avatar";
export const builtinAvatarImages = (globalThis as unknown as {avatarPreviewImages?:Record<string,{poster:string;animation?:string}>}).avatarPreviewImages ?? Object.fromEntries(builtinBotAvatars.map(entry => [entry.id,{
  poster:`/avatar-assets/${entry.poster.file}`, animation:entry.animation ? `/avatar-assets/${entry.animation.file}` : undefined,
}]));
