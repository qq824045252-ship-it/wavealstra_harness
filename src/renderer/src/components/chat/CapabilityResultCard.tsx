import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CapabilityResult } from "@shared/capability-result";
import type { ArtifactDescriptor } from "@shared/artifact-types";
import type { ToolCall } from "@/types";
import { getSpeechStream, getSpeechStreamForTool, stopSpeechPlayback, subscribeSpeechStreams, type SpeechStreamEntry } from "@/lib/speechStreams";
import "./CapabilityResultCard.css";

const LABELS: Record<string, string> = { ocr_file: "文件文字识别", speech_to_text: "语音转文字", text_to_speech: "文字转语音" };
const STATUS = { running: "进行中", success: "已完成", error: "失败", denied: "已拒绝", pending_approval: "等待授权" };
export const isCapabilityTool = (tool: string): boolean => Object.prototype.hasOwnProperty.call(LABELS, tool);

export function speechTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function speechDownloadName(descriptor: ArtifactDescriptor, fallback: string): string {
  const extensions: Record<string, string> = { "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
    "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac" };
  const sourceName = descriptor.source.type === "workspace-file" ? descriptor.source.entryFile : "";
  const sourceExtension = sourceName.match(/\.(wav|mp3|ogg|m4a|aac|flac)$/i)?.[0]?.toLowerCase();
  const extension = extensions[descriptor.mimeType?.toLowerCase() ?? ""] || sourceExtension || ".wav";
  const name = (descriptor.title || fallback || "合成语音").split(/[/\\]/).pop()!.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  const stem = name.replace(/\.[^.]+$/, "").slice(0, 120) || "合成语音";
  return `${stem}${extension}`;
}

/** Only capability-owned audio controls participate in this playback group. */
function pauseSavedSpeech(except?: HTMLAudioElement): void {
  for (const audio of document.querySelectorAll<HTMLAudioElement>(".speech-saved-audio audio")) if (audio !== except) audio.pause();
}

function CopyText({ text }: { text: string }): React.JSX.Element {
  const [notice, setNotice] = useState("");
  return <span className="capability-copy"><button type="button" disabled={!text} onClick={() => {
    if (!navigator.clipboard?.writeText) { setNotice("当前无法复制，请选中文本后复制。"); return; }
    void navigator.clipboard.writeText(text).then(() => setNotice("已复制文本"), () => setNotice("复制失败，请选中文本后复制。"));
  }}>复制文本</button>{notice && <small role="status">{notice}</small>}</span>;
}

function OcrPage({ page, initiallyOpen }: { page: NonNullable<Extract<CapabilityResult, { kind: "ocr" }>["pages"]>[number]; initiallyOpen: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="capability-ocr-page" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>第 {page.index + 1} 页{page.finishReason === "length" && <span className="capability-warning"> · 内容未完整返回</span>}</summary>
    {open && <pre>{page.text || "此页未识别到文字。"}</pre>}
  </details>;
}

function RecognitionResult({ result }: { result: Extract<CapabilityResult, { kind: "ocr" }> }): React.JSX.Element {
  const incomplete = result.truncated || result.pages?.some(page => page.finishReason === "length");
  return <div className="capability-recognition">
    <div className="capability-result-meta">{result.provider && <span>{result.provider}</span>}
      {result.pageCount !== undefined && <span>{result.pageCount} 页</span>}
      {result.purpose && <span>{result.purpose === "rich_layout_recognition" ? "版面识别" : "文字识别"}</span>}
      {incomplete && <span className="capability-warning">部分页面未完整识别</span>}
    </div>
    {incomplete && <p className="capability-warning" role="status">以下页面包含被截断的内容，不能视为完整文档。</p>}
    {result.purpose === "rich_layout_recognition" && <p className="capability-result-note">保留服务返回的版面标记；其中的位置采用页面归一化坐标。</p>}
    <div className="capability-text-scroll">
      {result.pages?.length ? result.pages.map(page => <OcrPage key={page.index} page={page} initiallyOpen={result.pages!.length <= 3 || page.index === 0} />)
        : <pre>{result.text || "未识别到文字。"}</pre>}
    </div>
    <CopyText text={result.text} />
  </div>;
}

function TranscriptResult({ result }: { result: Extract<CapabilityResult, { kind: "transcript" }> }): React.JSX.Element {
  return <div className="capability-transcript">
    <div className="capability-result-meta">{result.provider && <span>{result.provider}</span>}
      {result.durationMs !== undefined && <span>音频时长 {speechTime(result.durationMs / 1000)}</span>}
      {result.language && <span>语言：{result.language}</span>}
      {result.channelSelection === "left" && <span>已转写左声道</span>}
    </div>
    <div className="capability-text-scroll" aria-label="转写文本"><pre>{result.text || "未识别到语音内容。"}</pre></div>
    {!!result.segments?.length && <details className="capability-transcript-segments"><summary>查看分段时间</summary><ol>
      {result.segments.map((segment, index) => <li key={index}><time>{speechTime(segment.start)}–{speechTime(segment.end)}</time><span>{segment.text}</span></li>)}
    </ol></details>}
    <CopyText text={result.text} />
  </div>;
}

const PLAYBACK_LABELS = { idle: "等待试听", buffering: "缓冲中", playing: "正在播放", paused: "已暂停", stopped: "已停止试听", ended: "试听结束", error: "实时试听不可用" };

function LiveSpeechPlayer({ entry, generating }: { entry: SpeechStreamEntry; generating: boolean }): React.JSX.Element {
  const state = useSyncExternalStore(entry.player.subscribe, entry.player.getSnapshot, entry.player.getSnapshot);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) entry.player.pause(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); entry.player.stop(); };
  }, [entry]);
  const playing = state.status === "playing" || state.status === "buffering";
  const failed = state.status === "error";
  const cancel = async () => {
    if (!window.api?.speech?.cancel) { setCancelError("当前无法取消语音生成，请停止此轮回复。"); return; }
    setCancelling(true); setCancelError("");
    try { const cancelled = await window.api.speech.cancel({ streamId: entry.streamId, taskId: entry.taskId, toolCallId: entry.toolCallId });
      if (!cancelled) setCancelError("此语音生成已结束或当前不可取消。"); }
    catch (error) { setCancelError(error instanceof Error ? error.message : "取消失败，请重试。"); }
    finally { setCancelling(false); }
  };
  return <div className="speech-live-player" data-stream-id={entry.streamId}>
    <div className="speech-live-status"><strong>实时试听</strong><span role="status">{PLAYBACK_LABELS[state.status]}</span>
      <span className="speech-live-duration">{speechTime(state.playedSeconds)} / {speechTime(state.receivedSeconds)} 已接收</span></div>
    <div className="speech-live-actions" role="group" aria-label="实时语音播放控制">
      <button type="button" disabled={failed || state.status === "ended"} onClick={() => {
        if (playing) entry.player.pause();
        else { pauseSavedSpeech(); stopSpeechPlayback(entry.streamId); void entry.player.play(); }
      }}>{playing ? "暂停试听" : state.status === "paused" ? "继续试听" : "播放实时语音"}</button>
      <button type="button" disabled={failed || state.status === "idle" || state.status === "stopped" || state.status === "ended"} onClick={() => entry.player.stop()}>停止试听</button>
      {generating && entry.transport === "streaming" && <button className="speech-cancel" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "正在取消…" : "取消语音生成"}</button>}
    </div>
    {state.error ? <p className="capability-warning" role="status">{state.error}</p>
      : <p className="capability-result-note">点击后开始试听；停止试听后，语音会继续生成。完整重播可使用下方保存的音频。</p>}
    {cancelError && <p className="capability-warning" role="alert">{cancelError}</p>}
  </div>;
}

function SavedSpeechAudio({ artifact, taskId, toolCallId }: { artifact: Extract<CapabilityResult, { kind: "speech" }>["artifacts"][number]; taskId?: string; toolCallId: string }): React.JSX.Element {
  const [descriptor, setDescriptor] = useState<ArtifactDescriptor | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    let current = true;
    setDescriptor(null); setError("");
    void (async () => {
      if (!window.api?.artifactDomain?.get) throw new Error("音频文件接口不可用，请重启应用。");
      if (!taskId) throw new Error("当前记录缺少音频所属会话，无法读取文件。");
      const response = await window.api.artifactDomain.get({ taskId, artifactId: artifact.id });
      const value = response.artifact;
      if (!value || value.kind !== "audio" || value.source.type !== "workspace-file"
        || (taskId && value.taskId !== taskId) || (value.createdByToolCallId && value.createdByToolCallId !== toolCallId)) throw new Error("此音频文件已不可用或不属于当前工具调用。");
      if (current) setDescriptor(value);
    })().catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { current = false; };
  }, [artifact.id, taskId, toolCallId, retry]);
  const source = descriptor ? `mybuddy-artifact://local/${encodeURIComponent(descriptor.id)}/?v=${descriptor.version}` : "";
  useEffect(() => {
    const element = audio.current;
    const hide = () => { if (document.hidden) element?.pause(); };
    document.addEventListener("visibilitychange", hide);
    return () => { document.removeEventListener("visibilitychange", hide); element?.pause(); };
  }, [source]);
  const download = async () => {
    if (!source || downloading) return;
    setDownloading(true); setError("");
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`读取音频失败（${response.status}）。`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("音频文件为空。");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = speechDownloadName(descriptor!, artifact.name); link.rel = "noopener";
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "下载失败，请重试。"); }
    finally { setDownloading(false); }
  };
  return <div className="speech-saved-audio" data-audio-artifact-id={artifact.id}>
    <div className="speech-saved-heading"><strong>{descriptor?.title || artifact.name}</strong><span>已保存音频{artifact.durationSeconds !== undefined ? ` · ${speechTime(artifact.durationSeconds)}` : ""}</span></div>
    {source ? <audio key={`${artifact.id}:${retry}`} ref={audio} src={source} controls preload="none" aria-label={`播放 ${descriptor?.title || artifact.name}`}
      onPlay={event => { stopSpeechPlayback(); pauseSavedSpeech(event.currentTarget); }} onError={() => setError("无法播放此音频。文件可能已移动、删除或损坏。请重新读取或下载检查。")} /> : !error && <p role="status">正在读取音频文件…</p>}
    <div className="speech-live-actions"><button type="button" disabled={!source || downloading} onClick={() => void download()}>{downloading ? "正在下载…" : "下载音频"}</button>
      {error && <button type="button" onClick={() => setRetry(value => value + 1)}>重新读取音频</button>}</div>
    {error && <p className="capability-warning" role="alert">{error}</p>}
  </div>;
}

export default function CapabilityResultCard({ toolCall, taskId }: { toolCall: ToolCall; taskId?: string }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const result = toolCall.capabilityResult;
  const stream = result?.kind === "speech" ? result.stream : undefined;
  const entry = useSyncExternalStore(subscribeSpeechStreams,
    () => stream ? getSpeechStream(stream) : taskId && toolCall.tool === "text_to_speech" ? getSpeechStreamForTool(taskId, toolCall.id) : undefined,
    () => undefined);
  const generating = toolCall.status === "running";
  const speech = result?.kind === "speech" ? result : undefined;
  const hasAudio = Boolean(speech?.artifacts.length);
  const title = LABELS[toolCall.tool] || toolCall.summary;
  return <section className={`capability-result-card capability-result-card--${toolCall.status}`} data-tool-call-id={toolCall.id} aria-label={title}>
    <button className="capability-result-heading" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <strong>{title}</strong><span>{STATUS[toolCall.status]} · {open ? "收起" : "展开"}</span>
    </button>
    {open && <div className="capability-result-body">
      {result?.kind === "ocr" && <RecognitionResult result={result} />}
      {result?.kind === "transcript" && <TranscriptResult result={result} />}
      {toolCall.tool === "text_to_speech" && <>
        {speech && <div className="capability-result-meta">{speech.provider && <span>{speech.provider}</span>}{speech.voice && <span>音色：{speech.voice}</span>}
          {speech.transport && <span>{speech.transport === "websocket" ? "实时合成" : "文件合成"}</span>}</div>}
        {entry ? <LiveSpeechPlayer key={entry.streamId} entry={entry} generating={generating} />
          : !hasAudio && <p role={generating ? "status" : undefined}>{generating
            ? speech?.transport === "http" || (speech && !stream) ? "正在合成语音，完成后可播放保存的音频。"
              : stream ? "当前没有可用的实时试听缓冲，完成后可播放保存的音频。" : "正在准备语音…"
            : toolCall.status === "success" ? "未保留实时试听，请查看本次调用返回的音频文件。" : "语音生成未完成。"}</p>}
        {speech?.artifacts.map(artifact => <SavedSpeechAudio key={artifact.id} artifact={artifact} taskId={stream?.taskId ?? taskId} toolCallId={toolCall.id} />)}
      </>}
      {!result && !entry && toolCall.tool !== "text_to_speech" && toolCall.status !== "error" && <p role={generating ? "status" : undefined}>{generating ? toolCall.tool === "ocr_file" ? "正在识别文件文字…" : "正在转写音频…" : toolCall.output || toolCall.summary}</p>}
      {toolCall.status === "error" && toolCall.output && <pre className="capability-warning">{toolCall.output}</pre>}
      {toolCall.detail && <details className="capability-request-detail"><summary>查看请求信息</summary><pre>{toolCall.detail}</pre></details>}
    </div>}
  </section>;
}
