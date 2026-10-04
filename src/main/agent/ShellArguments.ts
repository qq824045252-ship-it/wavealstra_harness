/** Convert Windows paths for Bash arguments without choosing or changing the shell. */
export function toBashPath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

/** POSIX-shell single-quote escaping for the optional execute_code tool. */
export function quoteBashArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** PowerShell single-quoted literal escaping. */
export function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
