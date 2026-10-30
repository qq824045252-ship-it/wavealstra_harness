#!/usr/bin/env node
/**
 * check-root-package-json.cjs 的契约测试。
 *
 * 真实现场：electron-builder 打包时把仓库根 package.json 换成裁剪版
 * （scripts/devDependencies/build 全丢），之后 `pnpm test:*` 全线失效。
 * 这里用临时 git 仓库复现该形态，断言守卫会「备份 + 还原 + 非零退出」，
 * 同时不误伤合法的 package.json 变更。
 */
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const GUARD = path.join(__dirname, 'check-root-package-json.cjs')

function gitAvailable() {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return probe.status === 0
}

/** 完整形态：打包前仓库里的样子。 */
function fullPackage(extraScripts = {}) {
  return {
    name: 'fixture-app',
    version: '9.9.9',
    description: 'fixture',
    main: './out/main/index.js',
    private: true,
    scripts: { build: 'echo build', 'test:a': 'echo a', ...extraScripts },
    dependencies: { left: '1.0.0' },
    devDependencies: { right: '2.0.0' },
    build: { appId: 'com.fixture.app', productName: 'Fixture' },
  }
}

/** electron-builder 裁剪后的形态（实测字段集合）。 */
function prunedPackage(version = '9.9.9') {
  return {
    name: 'fixture-app',
    version,
    description: 'fixture',
    main: './out/main/index.js',
    private: true,
    dependencies: { left: '1.0.0' },
  }
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-guard-'))
  const write = (value) => fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(value, null, 2)}\n`)
  const read = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const raw = () => fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  return { root, write, read, raw }
}

function gitInit(root) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  }
  run(['init', '-q'])
  run(['config', 'user.email', 'guard@example.test'])
  run(['config', 'user.name', 'guard-test'])
  run(['add', 'package.json'])
  run(['commit', '-q', '-m', 'fixture'])
}

function runGuard(root, extraArgs = []) {
  const result = spawnSync(process.execPath, [GUARD, '--root', root, ...extraArgs], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function backups(root) {
  const dir = path.join(root, 'out', 'diagnostics')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith('pruned-root-package.json.')) : []
}

function main() {
  if (!gitAvailable()) {
    console.log('root-package-json-guard-test: SKIP（本机没有 git，无法构造基线）')
    return
  }

  // 1. 被裁剪：备份 + 还原 + 非零退出
  {
    const repo = makeRepo()
    const head = fullPackage()
    repo.write(head)
    gitInit(repo.root)
    const headText = repo.raw()
    repo.write(prunedPackage())
    const { status, stderr } = runGuard(repo.root)
    assert.equal(status, 1, '裁剪后必须非零退出')
    assert.equal(repo.raw(), headText, '必须还原成 HEAD 的完整内容')
    assert.match(stderr, /scripts 从 2 个降到 0 个/)
    assert.match(stderr, /devDependencies/)
    const saved = backups(repo.root)
    assert.equal(saved.length, 1, '裁剪内容必须留一份备份')
    const backupText = fs.readFileSync(path.join(repo.root, 'out', 'diagnostics', saved[0]), 'utf8')
    assert.deepEqual(JSON.parse(backupText), prunedPackage(), '备份内容应是裁剪后的原文')
    fs.rmSync(repo.root, { recursive: true, force: true })
  }

  // 2. 合法新增（多脚本、改版本）不误判、不改文件
  {
    const repo = makeRepo()
    repo.write(fullPackage())
    gitInit(repo.root)
    const touched = fullPackage({ 'test:b': 'echo b' })
    touched.version = '9.9.10'
    repo.write(touched)
    const before = repo.raw()
    const { status, stdout } = runGuard(repo.root)
    assert.equal(status, 0)
    assert.match(stdout, /OK/)
    assert.equal(repo.raw(), before, '合法改动不能被还原')
    assert.equal(backups(repo.root).length, 0, '合法改动不该产生备份')
    fs.rmSync(repo.root, { recursive: true, force: true })
  }

  // 3. 只丢一段（scripts 数量不变但 devDependencies 消失）也算裁剪
  {
    const repo = makeRepo()
    repo.write(fullPackage())
    gitInit(repo.root)
    const partial = fullPackage()
    delete partial.devDependencies
    repo.write(partial)
    const { status, stderr } = runGuard(repo.root)
    assert.equal(status, 1)
    assert.match(stderr, /顶层段 "devDependencies" 丢失/)
    assert.equal(repo.read().devDependencies.right, '2.0.0', '必须还原出 devDependencies')
    fs.rmSync(repo.root, { recursive: true, force: true })
  }

  // 4. 被写坏成非法 JSON：同样备份 + 还原 + 非零退出
  {
    const repo = makeRepo()
    repo.write(fullPackage())
    gitInit(repo.root)
    const headText = repo.raw()
    fs.writeFileSync(path.join(repo.root, 'package.json'), '{"name": "fixture-app",,}\n')
    const { status, stderr } = runGuard(repo.root)
    assert.equal(status, 1)
    assert.match(stderr, /不是合法 JSON/)
    assert.equal(repo.raw(), headText)
    fs.rmSync(repo.root, { recursive: true, force: true })
  }

  // 5. --no-fail：仍然还原，但不让构建链失败
  {
    const repo = makeRepo()
    repo.write(fullPackage())
    gitInit(repo.root)
    const headText = repo.raw()
    repo.write(prunedPackage())
    const { status } = runGuard(repo.root, ['--no-fail'])
    assert.equal(status, 0)
    assert.equal(repo.raw(), headText, '--no-fail 只影响退出码，不影响还原')
    fs.rmSync(repo.root, { recursive: true, force: true })
  }

  // 6. 没有 git 基线：报错但没法还原，必须明确提示手工处理，且不销毁现场
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-guard-nogit-'))
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(prunedPackage(), null, 2)}\n`)
    const { status, stderr } = runGuard(root)
    assert.equal(status, 1)
    assert.match(stderr, /没有 git HEAD 基线可还原/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name, 'fixture-app', '无基线时保持现场不动')
    assert.equal(backups(root).length, 1, '无基线也必须留下备份')
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log('root-package-json-guard-test: ok')
}

main()
