#!/usr/bin/env node
/**
 * 打包后守卫：确认仓库根 package.json 没有被 electron-builder 就地裁剪。
 *
 * 事实（2026-10-30、electron-builder 26.15.3、`--win --dir`）：
 * 打包过程会把仓库根 package.json 替换成「打包用」裁剪版——只剩
 * name/version/description/main/private/packageManager/engines/dependencies/
 * optionalDependencies，`scripts`（350 个）、`devDependencies`、`build` 全部消失。
 * asar 里那份裁剪版本身是对的，坏的是**源文件被改写**：
 *   - 下一次 `pnpm test:*` / `pnpm pack` 全部失效（脚本一个都不剩）；
 *   - `git status` 只显示「modified package.json」，很容易被当成无关改动提交掉。
 *
 * 因此构建链末尾跑本守卫：被判为裁剪就「备份 + 还原 + 退出 1」。
 * 判定口径是「相对 git HEAD 缺东西」，所以合法的新增（多出来的 script、
 * 依赖）不会被误判。
 *
 * 用法：
 *   node scripts/check-root-package-json.cjs                    # 门禁（默认，失败退出 1）
 *   node scripts/check-root-package-json.cjs --no-fail          # 只还原不失败（手工排查用）
 *   node scripts/check-root-package-json.cjs --root <dir>       # 校验指定目录（测试用）
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/** 裁剪版一定会丢的段。缺任何一个都说明被外部工具改写成了打包形态。 */
const PROTECTED_KEYS = ['scripts', 'devDependencies', 'build']
/** 没有 git 基线时的兜底阈值：本仓库 scripts 长期在 300+，裁剪版是 0。 */
const FALLBACK_MIN_SCRIPTS = 200

function parseArgs(argv) {
  const options = { root: path.join(__dirname, '..'), fail: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--no-fail') options.fail = false
    else if (arg === '--root') options.root = path.resolve(argv[++i] ?? '')
    else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length))
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** git HEAD 里的版本：既是「期望内容」，也是「还原来源」。 */
function readHeadPackageJson(root, text) {
  try {
    const head = execFileSync('git', ['show', 'HEAD:package.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const parsed = parseJsonOrNull(head)
    return parsed ? { text: head, json: parsed } : null
  } catch {
    return null
  }
}

function scriptCount(json) {
  return json && typeof json.scripts === 'object' && json.scripts ? Object.keys(json.scripts).length : 0
}

/**
 * 相对 HEAD 的裁剪判定：
 *   1. 文件不再是合法 JSON（被写坏）；
 *   2. HEAD 里有的顶层段在现在这个文件里没了（scripts / build / devDependencies …）；
 *   3. script 数量变少（裁剪版恒为 0）。
 * 没有 git 基线时退化为「保护段缺失 + 数量低于兜底阈值」。
 */
function detectPruning(current, head) {
  const reasons = []
  if (!current) {
    reasons.push('package.json 不是合法 JSON')
    return reasons
  }
  if (head) {
    for (const key of Object.keys(head.json)) {
      if (!(key in current)) reasons.push(`顶层段 "${key}" 丢失（HEAD 里有）`)
    }
    const lost = scriptCount(head.json) - scriptCount(current)
    if (lost > 0) reasons.push(`scripts 从 ${scriptCount(head.json)} 个降到 ${scriptCount(current)} 个`)
    return reasons
  }
  for (const key of PROTECTED_KEYS) {
    if (!(key in current)) reasons.push(`顶层段 "${key}" 丢失（无 git 基线，按保护段判定）`)
  }
  if (scriptCount(current) < FALLBACK_MIN_SCRIPTS) {
    reasons.push(`scripts 只有 ${scriptCount(current)} 个（无 git 基线，兜底阈值 ${FALLBACK_MIN_SCRIPTS}）`)
  }
  return reasons
}

function backup(root, text) {
  const dir = path.join(root, 'out', 'diagnostics')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `pruned-root-package.json.${stamp}.json`)
  fs.writeFileSync(file, text)
  return file
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const file = path.join(options.root, 'package.json')
  if (!fs.existsSync(file)) {
    console.error(`[package-guard] FAIL 找不到 ${file}`)
    return options.fail ? 1 : 0
  }

  const currentText = readText(file)
  const current = parseJsonOrNull(currentText)
  const head = readHeadPackageJson(options.root, currentText)
  const reasons = detectPruning(current, head)

  if (!reasons.length) {
    console.log(`[package-guard] OK 根 package.json 完整：scripts=${scriptCount(current)}${head ? `（HEAD=${scriptCount(head.json)}）` : ''}，devDependencies=${current.devDependencies ? '有' : '无'}`)
    return 0
  }

  const savedTo = backup(options.root, currentText)
  console.error('[package-guard] FAIL 根 package.json 疑似被打包工具裁剪：')
  for (const reason of reasons) console.error(`[package-guard]   - ${reason}`)
  console.error(`[package-guard]   原始（裁剪后）内容已备份：${path.relative(options.root, savedTo)}`)

  if (!head) {
    console.error('[package-guard] 没有 git HEAD 基线可还原；请手工执行 `git checkout -- package.json`。')
    return options.fail ? 1 : 0
  }

  fs.writeFileSync(file, head.text)
  const restored = parseJsonOrNull(readText(file))
  if (scriptCount(restored) !== scriptCount(head.json)) {
    console.error('[package-guard] 还原后仍然校验失败，请手工检查 package.json')
    return 1
  }
  console.error(`[package-guard]   已从 HEAD 还原（scripts=${scriptCount(restored)}）。构建产物本身不受影响。`)
  return options.fail ? 1 : 0
}

process.exitCode = main()
