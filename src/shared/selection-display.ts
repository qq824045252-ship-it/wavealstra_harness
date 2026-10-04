/** Recover display-only element labels/comments from the stored Artifact Context. */
export function selectionLabelsFromPrompt(raw: string): string[] {
  const labels: string[] = [];
  for (const block of raw.split("\n[Artifact Context]").slice(1)) {
    const header = block.split("\ndocument excerpt:")[0];
    let current: { prefix: string; index: number } | undefined;
    for (const line of header.split("\n")) {
      const selection = /^(selection(?: \d+)?): (.+)$/.exec(line);
      if (selection) {
        current = undefined;
        if (selection[2] === "none" || selection[2].startsWith("unavailable (")) continue;
        labels.push(selection[2].replace(/ \[.*\]$/, ""));
        current = { prefix: selection[1], index: labels.length - 1 };
      } else if (current && line.startsWith(`${current.prefix} user comment (用户备注): `)) {
        try {
          const comment: unknown = JSON.parse(line.slice(`${current.prefix} user comment (用户备注): `.length));
          if (typeof comment === "string" && comment.trim()) labels[current.index] += `：${comment}`;
        } catch { /* Older/malformed context still shows its element label. */ }
      }
    }
  }
  return labels;
}
