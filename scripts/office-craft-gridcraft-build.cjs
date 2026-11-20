'use strict'

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const JSZip = require('jszip')

const gridRevision = '476448d7d9f3a5f8e93fcf7d98b47fd52293fe7f'
const fontsRevision = 'b076417b5880bd4154bd22f00695b1d28c6bea83'
const rust = '1.97.1'
const bindingVersion = '0.2.129'
const optimizerVersion = '133'
const wasmTarget = 'wasm32-unknown-unknown'
const fontDirs = [
  'biz-ud-pgothic',
  'lxgw-wenkai-lite',
  'nanum-gothic',
  'noto-sans-arabic',
  'noto-sans-symbols',
  'noto-sans-symbols-2'
]
const cache = path.resolve(__dirname, '../out/office-craft-gridcraft-build')
const patch = path.join(__dirname, 'office-craft-gridcraft.patch')

function command(name, args, options = {}) {
  return execFileSync(name, args, { stdio: 'inherit', ...options })
}

function ensureCheckout(directory, remote, revision, sparsePaths) {
  if (!fs.existsSync(path.join(directory, '.git'))) {
    fs.mkdirSync(directory, { recursive: true })
    command('git', ['init', directory])
    if (sparsePaths) {
      command('git', ['-C', directory, 'sparse-checkout', 'set', '--no-cone', ...sparsePaths])
    }
    const fetchOptions = sparsePaths ? ['--filter=blob:none'] : []
    command('git', ['-C', directory, 'remote', 'add', 'origin', remote])
    command('git', ['-C', directory, 'fetch', '--depth=1', ...fetchOptions, 'origin', revision])
    command('git', ['-C', directory, 'checkout', '--detach', revision])
  }
  const head = command('git', ['-C', directory, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim()
  if (head !== revision) throw new Error('Unexpected source revision in ' + directory)
}

function build(destination) {
  const patchId = createHash('sha256').update(fs.readFileSync(patch)).digest('hex').slice(0, 12)
  const source = path.join(cache, 'gridcraft-' + patchId)
  const fonts = path.join(cache, 'fonts')
  ensureCheckout(source, 'https://github.com/storytold/gridcraft.git', gridRevision)
  ensureCheckout(fonts, 'https://github.com/storytold/craft-fonts.git', fontsRevision, [
    '/fonts/manifest.txt',
    '/fonts/simplified-chinese-manifest.txt',
    ...fontDirs.map(name => '/fonts/' + name + '/')
  ])
  try {
    command('git', ['apply', '--check', '--reverse', patch], { cwd: source, stdio: 'ignore' })
  } catch {
    command('git', ['apply', patch], { cwd: source })
  }

  command('rustup', ['toolchain', 'install', rust, '--profile', 'minimal', '--target', wasmTarget])
  const localTools = path.join(cache, 'tools')
  const installedBinding = path.join(localTools, 'bin', process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen')
  const binding = process.env.MYBUDDY_WASM_BINDGEN || installedBinding
  if (binding === installedBinding && !fs.existsSync(binding)) {
    command('cargo', ['+' + rust, 'install', 'wasm-bindgen-cli', '--locked', '--version', bindingVersion, '--root', localTools])
  }
  const bindingInfo = command(binding, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  if (bindingInfo !== 'wasm-bindgen ' + bindingVersion) throw new Error('Unexpected wasm-bindgen version ' + bindingInfo)
  const targetDir = path.join(cache, 'target')
  command('cargo', ['+' + rust, 'build', '--locked', '--target', wasmTarget, '--release', '-p', 'gridcraft-web'], {
    cwd: source,
    env: {
      ...process.env,
      CRAFT_FONTS_DIR: fonts,
      CRAFT_FONTS_REQUIRED: '1',
      CARGO_TARGET_DIR: targetDir,
      CARGO_NET_GIT_FETCH_WITH_CLI: 'true'
    }
  })

  assembleAssets({
    source, fonts, binding, destination,
    input: path.join(targetDir, wasmTarget, 'release/gridcraft-web.wasm')
  })
}

function assembleAssets({ source, fonts, binding, destination, input }) {
  fs.mkdirSync(destination, { recursive: true })
  command(binding, [
    input,
    '--target', 'web',
    '--no-typescript',
    '--out-dir', destination
  ])
  const optimizer = process.env.MYBUDDY_WASM_OPT || 'wasm-opt'
  const version = command(optimizer, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  if (!version.startsWith('wasm-opt version ' + optimizerVersion + ' ') && version !== 'wasm-opt version ' + optimizerVersion) {
    throw new Error('Unexpected Binaryen version ' + version)
  }
  const wasm = path.join(destination, 'gridcraft-web_bg.wasm')
  const optimized = path.join(destination, 'gridcraft-web_bg.opt.wasm')
  // Keep the module's feature set so Binaryen does not emit experimental import forms.
  command(optimizer, [wasm, '-Oz', '--strip-debug', '-o', optimized])
  if (!WebAssembly.validate(fs.readFileSync(optimized))) throw new Error('Optimized GridCraft WASM is not valid in V8')
  fs.renameSync(optimized, wasm)

  const sourceHtml = fs.readFileSync(path.join(source, 'apps/gridcraft-web/index.html'), 'utf8')
  const html = sourceHtml.replace(/^[ \t]*<link data-trunk[^\n]*\r?\n/gm, '').replace('</head>', [
    '<script type="module">',
    "import init from './gridcraft-web.js';",
    'await init();',
    '</script>',
    '</head>'
  ].join('\n'))
  fs.writeFileSync(path.join(destination, 'index.html'), html)
  for (const name of ['LICENSE-APACHE', 'LICENSE-MIT', 'NOTICE', 'ATTRIBUTION.md']) {
    fs.copyFileSync(path.join(source, name), path.join(destination, name))
  }
  fs.appendFileSync(path.join(destination, 'ATTRIBUTION.md'),
    '\n## MyBuddy web build\n\n' +
    'LXGW WenKai Lite Regular (SIL OFL 1.1) is embedded for Simplified Chinese text. ' +
    'Source: https://github.com/lxgw/LxgwWenKai-Lite/releases/tag/v1.530. ' +
    'License text: OFL-lxgw-wenkai-lite.txt.\n')
  for (const name of fontDirs) {
    fs.copyFileSync(path.join(fonts, 'fonts', name, 'OFL.txt'), path.join(destination, 'OFL-' + name + '.txt'))
  }
}

async function writeArchive(assetDirectory, vendorDirectory) {
  const archive = 'gridcraft-web-mybuddy.zip'
  const zip = new JSZip()
  const files = {}
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const filelist = fs.readdirSync(assetDirectory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(assetDirectory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
  for (const name of filelist) {
    const bytes = fs.readFileSync(path.join(assetDirectory, name))
    files[name] = hash(bytes)
    zip.file(name, bytes, { date: new Date('2026-11-12T00:00:00Z'), createFolders: false })
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  fs.mkdirSync(vendorDirectory, { recursive: true })
  fs.writeFileSync(path.join(vendorDirectory, archive), bytes)
  fs.writeFileSync(path.join(vendorDirectory, 'gridcraft-custom.json'),
    JSON.stringify({ sha256: hash(bytes), files, archive }, null, 2) + '\n')
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error('Pass the GridCraft asset output directory.')
  if (process.argv[2] === '--archive') {
    fs.mkdirSync(cache, { recursive: true })
    const assets = fs.mkdtempSync(path.join(cache, 'assets-'))
    build(assets)
    writeArchive(assets, path.resolve(__dirname, '../vendor/craft-office')).catch(error => {
      console.error(error)
      process.exitCode = 1
    })
  } else {
    build(path.resolve(process.argv[2]))
  }
}

module.exports = { assembleAssets, writeArchive }
