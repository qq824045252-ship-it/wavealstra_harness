'use strict'
const $ = id => document.getElementById(id)
const frame = $('editor')
const channel = new MessageChannel()
const port = channel.port1
let sequence = 0
let captured, editId, proposalId, config, timer, busy = false, opened = false, revision = 0, stored = 0
let committed = 0
let writeQueue = Promise.resolve()
const pending = new Map()
const reviews = new Map()
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
    const review = !draft && [...reviews.values()].find(item => item.status === 'applied' && item.revision === before)
    const verified = review && before === revision &&
      await request('review-current', { proposalId: review.proposalId }).catch(() => false)
    const response = await api(draft ? 'draft' : 'save', { method: 'POST', body: bytes })
    stored = before
    if (!draft && response.headers.get('X-Office-Saved') === '1') {
      if (!config.copy) { committed = before; config.recovered = false }
      if (review && verified && before === revision) review.status = 'saved'
    }
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
function dismissReview() {
  const review = reviews.get(proposalId)
  if (review?.status === 'awaiting-user-review') review.status = 'cancelled'
  proposalId = undefined
  editId = undefined
}
function queueReview(id, target) {
  proposalId = id
  reviews.set(id, { proposalId: id, status: 'awaiting-user-review', target })
  if (reviews.size > 20) reviews.delete(reviews.keys().next().value)
}
function preview(selection, text) {
  dismissReview()
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
  $('rewrite').hidden = false
  $('apply').textContent = '应用到选区'
  $('panel').hidden = false
}
async function select(target) {
  if (busy) throw new Error('请先完成正在进行的 Office 操作。')
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
$('cancel').onclick = () => {
  if (reviews.get(proposalId)?.status === 'applying') return
  dismissReview()
  captured = undefined
  $('panel').hidden = true
}
$('generate').onclick = () => action(async () => {
  const selection = captured
  if (!selection || !$('instruction').value.trim()) throw new Error('请填写修改要求')
  status('模型正在生成建议…')
  const res = await api('propose', { method:'POST', body:JSON.stringify({selection,instruction:$('instruction').value}) })
  const text = await res.text()
  if (captured !== selection) return
  dismissReview()
  $('candidate').value = text
  status('请核对修改建议')
})
$('apply').onclick = () => action(async () => {
  const review = reviews.get(proposalId)
  if (review) review.status = 'applying'
  frame.inert = true
  try {
    const fields = editId ? { editId } : { captured, proposal: { text: $('candidate').value } }
    const result = await request('apply', { ...fields, proposalId })
    if (review) Object.assign(review, {
      status: result.changed ? 'applied' : 'unchanged',
      revision,
      verification: result.verification,
    })
    if (result.verification?.matched === false) status('修改已应用。回读结果需要核对。')
  } catch (error) {
    if (review) Object.assign(review, { status: 'failed', error: error.message })
    throw error
  } finally { frame.inert = false }
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
window.officeRender = async target => {
  if (!opened) throw new Error('编辑器仍在加载')
  const rendered = await request('render', { target })
  if (target.kind !== 'excel') return rendered
  const { x, y, width, height } = frame.getBoundingClientRect()
  return { x: Math.ceil(x), y: Math.ceil(y), width: Math.floor(width), height: Math.floor(height) }
}
window.officeReviewStatus = id => {
  const review = reviews.get(id)
  if (!review) return null
  const { revision: appliedRevision, ...receipt } = review
  return { ...receipt, ...(appliedRevision !== undefined ? { editorChangedSinceApply: appliedRevision !== revision } : {}) }
}
window.officeProposal = (id, text, reviewId) => {
  if (busy) throw new Error('请先完成正在进行的 Office 操作。')
  if (!captured || captured.captureId !== id) throw new Error('选区已更新，请重新读取')
  if (config.readOnly || captured.editable === false) throw new Error(captured.reason || '选区只读')
  preview(captured, text)
  if (reviewId) queueReview(reviewId, captured.target)
  return true
}
window.officeEditProposal = async (operation, reviewId) => {
  if (busy || !opened || config.readOnly) throw new Error('请在可编辑的 Office 文档中完成当前操作后重试。')
  busy = true
  try {
    const plan = await request('edit-stage', { operation })
    dismissReview()
    captured = undefined
    editId = plan.id
    queueReview(reviewId, plan.target)
    $('label').textContent = plan.label
    $('original').value = plan.before
    $('candidate').value = plan.after
    $('candidate').readOnly = true
    $('rewrite').hidden = true
    $('format-hint').hidden = true
    $('apply').textContent = '应用编辑'
    $('apply').disabled = false
    $('panel').hidden = false
    return true
  } finally { busy = false }
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
