// Match the pinned Pi file tools so host policy sees the paths they may open.
export function durableToolPath(path: string): string {
  return path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
}

export function durableReadPathVariants(path: string): readonly string[] {
  const nfd = path.normalize("NFD");
  return [path, path.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd,
    path.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")];
}
