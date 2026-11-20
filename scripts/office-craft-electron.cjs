const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { mkdtempSync, mkdirSync, realpathSync, rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (!process.versions.electron) {
  const temp = realpathSync(os.tmpdir())
  const root = mkdtempSync(path.join(temp, 'mybuddy-craft-test-'))
  const env = { ...process.env, MYBUDDY_OFFICE_TEST_ROOT: root }
  delete env.ELECTRON_RUN_AS_NODE
  let child
  try {
    child = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  } finally {
    const cleanup = realpathSync(root)
    assert.equal(path.dirname(cleanup), temp)
    assert.equal(cleanup, root)
    rmSync(cleanup, { recursive: true, force: true, maxRetries: 3 })
  }
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}

const { app, BrowserWindow, WebContentsView } = require('electron')
const repo = path.resolve(__dirname, '..')
const root = process.env.MYBUDDY_OFFICE_TEST_ROOT ?? mkdtempSync(path.join(os.tmpdir(), 'mybuddy-craft-test-'))
const profile = path.join(root, 'profile')
mkdirSync(profile)
app.setPath('userData', profile)
app.setAppPath(repo)
app.on('window-all-closed', () => {})

const sourceFiles = new Set()
const activeFixtures = new Map()
let host

async function startHost() {
  const entry = path.join(root, 'office-use-host.cjs')
  const result = await require('esbuild').build({
    entryPoints: [path.join(repo, 'src/main/office-use/OfficeUseHost.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    write: false,
  })
  await fs.writeFile(entry, result.outputFiles[0].contents)
  const { OfficeUseHost } = require(entry)
  const targets = new WeakMap()
  host = new OfficeUseHost({
    drafts: path.join(root, 'drafts'),
    async target(_request, owner) {
      const target = targets.get(owner)
      assert.ok(target, 'Each owner must be authorized for its isolated test file')
      return target
    },
    async saveAs() { throw new Error('Unexpected save-as dialog') },
    async propose() { throw new Error('Unexpected live model request') },
  })
  return targets
}

async function waitForReady(wc) {
  const end = performance.now() + 90000
  while (performance.now() < end) {
    const state = await wc.executeJavaScript(`({
      ready: document.getElementById('editor').getAttribute('aria-busy') === 'false',
      status: document.getElementById('status').textContent
    })`)
    if (state.ready) return
    if (state.status !== '正在打开文档…') {
      if (process.env.MYBUDDY_OFFICE_TEST_TRACE) {
        console.error(await wc.executeJavaScript(`(() => {
          const editor = frames[0].frames[0]
          return {
            path: editor.location.pathname,
            status: editor.document.body?.innerText,
            assets: editor.performance.getEntriesByType('resource').map(({ name, responseStatus }) => [name, responseStatus])
          }
        })()`))
      }
      throw new Error(state.status)
    }
    await new Promise(resolve => setTimeout(resolve, 35))
  }
  throw new Error('Timed out waiting for production Office editor')
}

async function saveThroughHost(wc, source, readOnly) {
  if (readOnly) {
    // Exercise the production server's read-only write guard directly.
    const status = await wc.executeJavaScript("fetch('./save',{method:'POST',body:'aborted'}).then(r=>r.status)")
    assert.equal(status, 404, 'The session route must reject a read-only write')
    throw new Error('文档只读')
  }
  const previous = await fs.readFile(source)
  const external = Buffer.concat([previous, Buffer.from('external change fixture')])
  await fs.writeFile(source, external)
  try {
    await assert.rejects(wc.executeJavaScript('persist(false)'), /原文件已被修改/u)
    assert.deepEqual(await fs.readFile(source), external, 'A concurrent source update must survive the CAS refusal')
  } finally {
    await fs.writeFile(source, previous)
  }

  assert.equal(await wc.executeJavaScript("persist(false).then(() => document.getElementById('status').textContent)"), '已保存')
  const written = await fs.readFile(source)
  assert.notDeepEqual(written, previous, 'The production save must update the fixture on disk')
  return written
}

function openFixture(targets) {
  return async (kind, name, bytes, readOnly = false) => {
    assert.equal(path.basename(name), name)
    const fixtureDir = path.join(root, kind)
    await fs.mkdir(fixtureDir, { recursive: true })
    const source = path.join(fixtureDir, name)
    if (sourceFiles.has(source)) {
      // A production source has one writer. Reopening replaces the previous test view.
      await activeFixtures.get(source)?.()
      assert.deepEqual(await fs.readFile(source), Buffer.from(bytes), 'Reopen must read the file written by OfficeFile')
    } else {
      await fs.writeFile(source, bytes, { flag: 'wx' })
      sourceFiles.add(source)
    }

    const owner = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false })
    const ownerId = owner.webContents.id
    targets.set(owner, { path: source, name, kind, readOnly, identity: source, async check() {} })
    const timeout = setTimeout(() => {
      console.error('Office acceptance timed out:', name)
      host.dispose()
      app.exit(1)
    }, 150000)
    let id
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      activeFixtures.delete(source)
      try { if (id) await host.close(ownerId, id) }
      finally {
        clearTimeout(timeout)
        if (!owner.isDestroyed()) owner.destroy()
      }
    }
    try {
      const start = performance.now()
      ;({ id } = await host.open({ source: { type: 'artifact', id: source }, name }, owner))
      const view = owner.contentView.children.find(child => child instanceof WebContentsView)
      assert.ok(view, 'Production host attached a WebContentsView')
      const wc = view.webContents
      wc.on('console-message', details => {
        if (process.env.MYBUDDY_OFFICE_TEST_TRACE && details.level === 'error') {
          console.error(details.sourceId, details.message)
        }
      })
      const [width, height] = owner.getContentSize()
      host.bounds(ownerId, id, { x: 0, y: 0, width, height })
      owner.show()
      owner.focus()
      wc.focus()
      await waitForReady(wc)
      console.log('Opened', name, 'in', Math.round(performance.now() - start), 'ms')
      wc.debugger.attach('1.3')
      activeFixtures.set(source, close)
      const evaluate = (fn, arg) => wc.executeJavaScript('(' + fn + ')(' + (JSON.stringify(arg) ?? 'undefined') + ')')
      return {
        focus: async () => { owner.show(); owner.focus(); wc.focus() },
        page: (fn, arg) => evaluate(code => window.frames[0].frames[0].eval(code),
          '(' + fn + ')(' + (JSON.stringify(arg) ?? 'undefined') + ')'),
        cdp: (method, params) => wc.debugger.sendCommand(method, params),
        shot: async file => fs.writeFile(file, (await wc.capturePage()).toPNG()),
        call: async (command, fields = {}) => {
          if (command === 'document') return evaluate(query => window.officeDocument(query), fields)
          if (command === 'select') return evaluate(target => window.officeSelection(target), fields.target)
          if (command === 'apply') return evaluate(async ({ captured, proposal }) => {
            if (proposal.cells !== undefined) {
              // Typed proposals exercise the production transport directly. The review UI is text-only.
              return request('apply', { captured, proposal })
            }
            window.officeProposal(captured.captureId, proposal.text)
            await document.getElementById('apply').onclick()
            if (!document.getElementById('panel').hidden) throw new Error(document.getElementById('status').textContent)
          }, fields)
          if (command === 'undo' || command === 'redo') {
            const engine = {word:'wordcraft', excel:'gridcraft', ppt:'deckcraft'}[kind]
            return evaluate(([engine, command]) => frames[0].frames[0][engine].execute(command, {}), [engine, 'edit.' + command])
          }
          if (command !== 'save') throw new Error('Unknown Office action ' + command)
          const written = await saveThroughHost(wc, source, readOnly)
          const evidence = path.join(repo, 'out/tests/office-craft', kind)
          await fs.mkdir(evidence, { recursive: true })
          await fs.writeFile(path.join(evidence, name), written)
          return written
        },
        close,
      }
    } catch (error) {
      await close()
      throw error
    }
  }
}

async function run() {
  const targets = await startHost()
  await app.whenReady()
  const open = openFixture(targets)
  for (const kind of process.argv.length > 2 ? process.argv.slice(2) : ['word', 'excel', 'ppt']) {
    assert.ok(['word', 'excel', 'ppt'].includes(kind), 'Unknown engine ' + kind)
    await require('./office-craft-' + kind + '-test.cjs')({ open, assert })
    console.log('PASS', kind, 'Chinese Office acceptance through production host and disk')
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  host?.dispose()
  app.exit(process.exitCode ?? 0)
})
