import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { IconBot } from "./icons";
import { builtinAvatarImages } from "@/lib/botAvatarAssets";
import { loadAvatarImage, useBotAvatars, useBotAvatarStore } from "@/lib/botAvatarStore";
import "./BotAvatar.css";

const motionListeners = new Set<() => void>();
let motionQuery: MediaQueryList | undefined;
const notifyMotion = () => motionListeners.forEach(listener => listener());
function subscribeMotion(listener: () => void) {
  if (!motionListeners.size) {
    motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    motionQuery?.addEventListener("change",notifyMotion);
    document.addEventListener("visibilitychange",notifyMotion);
  }
  motionListeners.add(listener);
  return () => {
    motionListeners.delete(listener);
    if (!motionListeners.size) {motionQuery?.removeEventListener("change",notifyMotion);document.removeEventListener("visibilitychange",notifyMotion);motionQuery=undefined;}
  };
}
function motionAllowed() { return document.visibilityState === "visible" && !motionQuery?.matches; }

/** Lists, messages, previews, and collaboration records are static. Only the active personal header opts in. */
export function BotAvatar({ botId, name, assetId, play = false, className = "" }: {
  botId?: string; name: string; assetId?: string | null; play?: boolean; className?: string;
}) {
  const snapshot = useBotAvatars();
  const selected = assetId !== undefined ? assetId : botId ? snapshot?.selections[botId]?.assetId : null;
  const privateImage = useBotAvatarStore(state => selected ? state.images[selected] : undefined);
  const privateAnimation = useBotAvatarStore(state => selected ? state.images[`${selected}:animation`] : undefined);
  const hasPrivateAnimation = Boolean(snapshot?.uploads.find(asset=>asset.id===selected)?.animated);
  const image = selected ? builtinAvatarImages[selected] : undefined;
  const animationSource=image?.animation ?? privateAnimation;
  const poster = image?.poster ?? privateImage;
  const ref = useRef<HTMLSpanElement>(null);
  const [visible,setVisible] = useState(false);
  const [failed,setFailed] = useState<string[]>([]);
  const allowMotion = useSyncExternalStore(subscribeMotion,motionAllowed,() => false);
  useEffect(() => {setFailed([]);},[selected,poster]);
  useEffect(() => {if (selected?.startsWith("upload:") && privateImage === undefined) void loadAvatarImage(selected);},[selected,privateImage]);
  useEffect(() => {
    setVisible(false);
    if (!play || (!image?.animation && !hasPrivateAnimation) || !ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)),{threshold:0.1});
    observer.observe(ref.current);
    return () => observer.disconnect();
  },[play,image?.animation,hasPrivateAnimation]);
  useEffect(()=>{
    if(selected && hasPrivateAnimation && play && visible && allowMotion && snapshot?.motion && privateAnimation===undefined)void loadAvatarImage(selected,"animation");
  },[selected,hasPrivateAnimation,play,visible,allowMotion,snapshot?.motion,privateAnimation]);
  const animation = play && visible && allowMotion && snapshot?.motion && animationSource && !failed.includes(animationSource) ? animationSource : undefined;
  const source = animation ?? poster;
  return <span ref={ref} className={`bot-avatar bot-identity-avatar ${className}`} role="img" aria-label={`${name}的头像`} data-avatar-id={selected ?? "default"} data-animated={Boolean(animation)}>
    {source && !failed.includes(source) ? <img key={source} src={source} alt="" aria-hidden="true" loading={play ? "eager" : "lazy"} decoding="async" draggable={false}
      onError={() => setFailed(previous => [...previous,source])} /> : <IconBot size={18} />}
  </span>;
}
