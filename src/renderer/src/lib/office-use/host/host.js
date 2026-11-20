'use strict'
const $ = id => document.getElementById(id)
const frame = $('editor')
const channel = new MessageChannel()
const port = channel.port1
let sequence = 0
let captured, config, timer, busy = false, opened = false, revision = 0, stored = 0
let committed = 0
let writeQueue = Promise.resolve()
const pending = new Map()
let statusTimer
const status = (text, visible = true, duration = 0) => {
  clearTimeout(statusTimer)
  const message = $('status')
  message.textContent = text
  message.hidden = !text || !visible
  if (duration) statusTimer = setTimeout(() => { message.hidden = true }, duration)
}
function request(type, fields = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    port.postMessage({ id, type, ...fields }, fields.bytes ? [fields.bytes] : [])
  })
}
async function api(action, options) {
  const response = await fetch('./' + action, { cache: 'no-store', ...options })
  if (!response.ok) throw new Error(await response.text())
  return response
}
function persist(draft, serialized) {
  clearTimeout(timer)
  const serializedRevision = revision
  const run = async () => {
    if (!opened || config.readOnly || (draft && stored >= revision)) return
    if (!draft && !serialized && !config.copy && !config.recovered && committed === revision) {
      status('没有未保存的修改', true, 2500)
      return
    }
    const before = serialized ? serializedRevision : revision
    const bytes = serialized ?? await request('save')
    const response = await api(draft ? 'draft' : 'save', { method: 'POST', body: bytes })
    stored = before
    if (!draft && !config.copy) { committed = before; config.recovered = false }
    status(draft ? '草稿已保留' : await response.text(), !draft, draft ? 0 : 3000)
  }
  writeQueue = writeQueue.catch(() => {}).then(run)
  return writeQueue
}
function changed() {
  revision++
  status('有未保存的修改', false)
  clearTimeout(timer)
  timer = setTimeout(() => persist(true).catch(e => status(e.message)), 1200)
}
function preview(selection, text) {
  captured = selection
  $('original').value = selection.content
  $('candidate').value = text ?? selection.content
  const t = selection.target
  if (config.kind === 'excel') $('label').textContent = t.sheet + ' · ' + t.address
  else if (config.kind === 'ppt') $('label').textContent = '第 ' + (t.slideIndex + 1) + ' 页 · 对象 ' + t.shapeId
  else $('label').textContent = (t.paragraphIndex === undefined ? 'Word 选区' : 'Word 正文 · 第 ' + (t.paragraphIndex + 1) + ' 个内容块') + ' · ' + Array.from(selection.content).length + ' 个字符'
  const locked = config.readOnly || selection.editable === false
  $('candidate').readOnly = locked
  $('generate').disabled = $('apply').disabled = locked
  if (locked) status(selection.reason || '选区只读')
  $('format-hint').hidden = config.kind !== 'excel'
  $('panel').hidden = false
}
async function select(target) {
  if (!opened) throw new Error('编辑器仍在加载')
  const selection = await request('select', { target })
  preview(selection)
  return selection
}
async function action(fn) {
  if (busy) return
  busy = true
  try { await fn() } catch(e) { status(e.message) } finally { busy = false }
}
const exportDocument = serialized => action(async () => {
  const bytes = serialized ?? await request('save')
  let result = await fetch('./export', {method:'POST',body:bytes})
  if (result.status === 409) {
    const message = await result.text()
    status(message)
    if (!window.confirm(message + '\n是否单独导出引擎生成的副本？此副本可能缺少可编辑的图表工作簿。')) return
    result = await api('export-engine-copy', {method:'POST',body:bytes})
  }
  if (!result.ok) throw new Error(await result.text())
  status(await result.text(), true, 3000)
})
$('cancel').onclick = () => { captured = undefined; $('panel').hidden = true }
$('generate').onclick = () => action(async () => {
  const selection = captured
  if (!selection || !$('instruction').value.trim()) throw new Error('请填写修改要求')
  status('模型正在生成建议…')
  const res = await api('propose', { method:'POST', body:JSON.stringify({selection,instruction:$('instruction').value}) })
  const text = await res.text()
  if (captured !== selection) return
  $('candidate').value = text
  status('请核对修改建议')
})
$('apply').onclick = () => action(async () => {
  await request('apply', { captured, proposal: { text: $('candidate').value } })
  $('cancel').click()
})
window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return
  event.preventDefault()
  if (opened && !config.readOnly && !event.repeat) {
    if (event.shiftKey) void exportDocument()
    else void persist(false).catch(error => status(error.message))
  }
}, true)
window.officeSelection = select
window.officeDocument = (query) => {
  if (!opened) throw new Error('编辑器仍在加载')
  return request('document', { query })
}
window.officeProposal = (id, text) => {
  if (!captured || captured.captureId !== id) throw new Error('选区已更新，请重新读取')
  if (config.readOnly || captured.editable === false) throw new Error(captured.reason || '选区只读')
  preview(captured, text)
  return true
}
window.flushOfficeDraft = () => persist(true)
port.onmessage = async ({data}) => {
  if (data.type === 'error') {
    for (const {reject} of pending.values()) reject(new Error(data.error))
    pending.clear()
    status(data.error)
  } else if (data.type === 'notice') {
    status(data.text)
  } else if (data.type === 'ready') {
    try {
      config = await (await api('config')).json()
      const bytes = await (await api('source')).arrayBuffer()
      const result = await request('open', {kind:config.kind,name:config.name,readOnly:config.readOnly,bytes})
      config.readOnly ||= result.readOnly
      opened = true
      frame.setAttribute('aria-busy', 'false')
      status(config.conflict ? '已恢复草稿。原文件有更新，请另存为。' : config.recovered ? '已恢复草稿' : config.readOnly ? '只读' : '')
    } catch (e) { status(e.message) }
  } else if (data.type === 'modified') {
    if (opened && !config.readOnly) changed()
  } else if (data.type === 'save-requested' || data.type === 'export-requested') {
    if (opened && !config.readOnly) {
      if (data.type === 'export-requested') void exportDocument(data.bytes)
      else void persist(false, data.bytes).catch(error => status(error.message))
    }
  } else if (pending.has(data.id)) {
    const {resolve,reject} = pending.get(data.id)
    pending.delete(data.id)
    if (data.ok) resolve(data.result)
    else reject(new Error(data.error || '编辑器操作失败'))
  }
}
frame.onload = () => frame.contentWindow.postMessage({type:'mybuddy-office-connect'}, location.origin, [channel.port2])
frame.src = '/craft/bridge.html'
