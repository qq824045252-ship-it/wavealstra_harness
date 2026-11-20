export function isOfficeUseFile(filename: string): boolean {
  return /\.(docx|xlsx|pptx)$/i.test(filename);
}

export function isOfficeUseKind(kind: string): boolean {
  return kind === "docx" || kind === "xlsx" || kind === "pptx";
}
