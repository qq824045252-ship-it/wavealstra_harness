interface Props {
  kind: "video" | "audio";
  content: string;
  name: string;
}

export default function MediaArtifactView({ kind, content, name }: Props): React.JSX.Element {
  return (
    <div className={`media-artifact-view media-artifact-${kind}`}>
      {kind === "video" ? (
        <video src={content} controls preload="metadata" aria-label={name} />
      ) : (
        <audio src={content} controls preload="metadata" aria-label={name} />
      )}
    </div>
  );
}
