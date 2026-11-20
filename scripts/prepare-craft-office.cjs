'use strict'
const { createHash, randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises')
const path = require('node:path')
const JSZip = require('jszip')
const root = path.resolve(__dirname, '../vendor/craft-office')
const releases = require('../vendor/craft-office/releases.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const verifyAt = process.argv.indexOf('--verify-assets')
const dest = verifyAt < 0 ? path.join(root,'assets') : path.resolve(process.argv[verifyAt + 1])
const verify = verifyAt >= 0 || process.argv.includes('--verify')
const font = 'NotoSansCJKsc-Regular.otf'
const fontSha = '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b'

async function valid(file, sha) {
  try { return digest(await readFile(file)) === sha }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false }
}
async function install(file, bytes, sha) {
  if (digest(bytes) !== sha) throw new Error('Office asset failed SHA-256 verification: ' + file)
  await mkdir(path.dirname(file), { recursive:true })
  const temp = file + '.' + randomUUID()
  try { await writeFile(temp, bytes, {flag:'wx'}); await rename(temp, file) }
  finally { await rm(temp,{force:true}) }
}
async function download(url) {
  const response = await fetch(url, { signal:AbortSignal.timeout(240000) })
  if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + url)
  return Buffer.from(await response.arrayBuffer())
}
async function engine(name, release) {
  const missing = []
  for (const [entry,sha] of Object.entries(release.files)) {
    if (!await valid(path.join(dest,name,entry), sha)) missing.push(entry)
  }
  if (!missing.length) return
  if (verify) throw new Error('Missing or invalid ' + name + ' assets: ' + missing.join(', '))
  const bytes = release.archive ? await readFile(path.join(root,release.archive)) : await download(release.url)
  if (digest(bytes) !== release.sha256) throw new Error(name + ' release archive failed SHA-256 verification')
  const zip = await JSZip.loadAsync(bytes)
  const prefix = Object.keys(zip.files).find(k => k === 'index.html' || /^[^/]+\/index\.html$/.test(k))?.slice(0,-10)
  if (prefix === undefined) throw new Error('Missing editor entry point: ' + name)
  for (const entry of missing) {
    const member = zip.file(prefix + entry)
    if (!member) throw new Error('Missing archive member ' + entry)
    await install(path.join(dest,name,entry), await member.async('nodebuffer'), release.files[entry])
  }
}
async function main() {
  const grid = require('../vendor/craft-office/gridcraft-custom.json')
  for (const [name,release] of Object.entries({...releases, gridcraft:grid})) await engine(name, release)
  const file = path.join(dest,'fonts',font)
  if (!await valid(file,fontSha)) {
    if (verify) throw new Error('Missing or invalid Chinese font')
    await install(file, await download('https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/' + font), fontSha)
  }
  console.log('Verified WordCraft, GridCraft, DeckCraft and the Chinese font.')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
