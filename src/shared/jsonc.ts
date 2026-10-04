/** JSON comments and trailing commas, without touching quoted strings. */
export function parseJsonc(text: string): unknown {
  let clean = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (quoted) {
      clean += char;
      if (char === "\\") { clean += next ?? ""; i++; }
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; clean += char; }
    else if (char === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; clean += "\n"; }
    else if (char === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; clean += " "; }
    else clean += char;
  }
  let normalized = "";
  quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      normalized += char;
      if (char === "\\") { normalized += clean[++i] ?? ""; }
      else if (char === '"') quoted = false;
    } else {
      if (char === '"') quoted = true;
      if (char === "," && /^\s*[}\]]/.test(clean.slice(i + 1))) continue;
      normalized += char;
    }
  }
  return JSON.parse(normalized.replace(/^\uFEFF/, ""));
}
