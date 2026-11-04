export function defaultFlyoutViewForArtifact(
  artifact: { kind: string } | undefined,
): "overview" | "workspace" | "changes" {
  return "overview";
}
