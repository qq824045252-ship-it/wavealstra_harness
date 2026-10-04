/**
 * bash 删除命令解析：从命令字符串中提取「删除目标路径」候选。
 *
 * pi 内置工具没有 delete —— 删除文件/目录通过 bash（rm / rmdir / del /
 * Remove-Item 等）完成。备份扩展据此在删除真正执行前把目标内容复制为
 * kind=deleted 的备份，之后可从「设置 → 安全中心」还原（重新创建）。
 */

const DELETE_COMMANDS = new Set(["rm", "rmdir", "del", "unlink", "remove", "remove-item", "rd"]);
// PowerShell Remove-Item 的路径参数：-Path <p> / -LiteralPath <p>（-Recurse/-Force 为开关，不消费值）
const DELETE_FLAG_WITH_VALUE = new Set(["-path", "-literalpath"]);

/**
 * 引号/转义感知的 shell 单词切分（覆盖单引号、双引号、反斜杠转义）。
 * 用于从 bash 命令中提取删除目标路径，避免把 "path with space" 拆坏。
 */
export function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        words.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (escaped) cur += "\\";
  if (cur) words.push(cur);
  return words;
}

/**
 * 从一条 bash 命令中提取「删除目标路径」候选。
 * 策略：按 ; && || 换行 切分子命令，仅当子命令以删除命令（可带 sudo）开头时，
 * 收集其非 flag 参数作为路径；带通配符/变量引用的路径跳过（展开不确定，保守不备份）。
 */
export function parseDeletePaths(command: string): string[] {
  const out: string[] = [];
  for (const seg of command.split(/(?:&&|\|\||;|\n)/)) {
    const words = splitShellWords(seg);
    if (words.length < 2) continue;

    let bin: string;
    let args: string[];
    if (words[0].toLowerCase() === "sudo") {
      if (words.length < 3) continue;
      bin = words[1].toLowerCase();
      args = words.slice(2);
    } else {
      bin = words[0].toLowerCase();
      args = words.slice(1);
    }
    if (!DELETE_COMMANDS.has(bin)) continue;

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "~") continue;
      // 通配符/变量展开不确定，不盲备份
      if (/[*?\[\]{}]|\$|%[^%]*%/.test(arg)) continue;
      if (arg.startsWith("-")) {
        // Remove-Item -Path x：flag 后的值仍然有效
        if (DELETE_FLAG_WITH_VALUE.has(arg.toLowerCase()) && i + 1 < args.length) {
          out.push(args[i + 1]);
          i += 1;
        }
        continue;
      }
      out.push(arg);
    }
  }
  return out;
}
