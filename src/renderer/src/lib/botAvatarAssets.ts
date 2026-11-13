import { builtinBotAvatars } from "@shared/bot-avatar";
// Vite resolves this closed local glob. Node-only component harnesses have no asset pipeline.
const files: Record<string,string> = (() => {
  try { return import.meta.glob<string>("../assets/bot-avatars/*.{png,gif,webp}", {eager:true, query:"?url", import:"default"}); }
  catch { return {}; }
})();
export const builtinAvatarImages = Object.fromEntries(builtinBotAvatars.map(entry => [entry.id, {
  poster: files[`../assets/bot-avatars/${entry.poster.file}`],
  animation: entry.animation ? files[`../assets/bot-avatars/${entry.animation.file}`] : undefined,
}]));
