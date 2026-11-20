'use strict'
const frame = document.querySelector('iframe')
const engines = { word: 'wordcraft', excel: 'gridcraft', ppt: 'deckcraft' }
let port, kind, engine, name, api, adapter, capture, edit, opened, readOnly
let startup, saving, verifiedEdit, initializing = false
let composing = false
function deadline(label, ms = 45000) {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  const timer = setTimeout(() => reject(new Error(label)), ms)
  return { promise: promise.finally(() => clearTimeout(timer)), resolve, reject }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function filename() {
  if (kind === 'word') return (await api.uiInspect()).documents?.find(d => d.active)?.path
  const doc = await api.docInspect()
  return kind === 'excel' ? doc.title : doc.path
}
async function chineseFont() {
  const response = await fetch('/fonts/NotoSansCJKsc-Regular.otf')
  if (!response.ok) throw new Error('未能载入中文字体')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1))
    reader.onerror = () => reject(reader.error)
    response.blob().then(blob => reader.readAsDataURL(blob)).catch(reject)
  })
}
async function installFont(data) {
  try {
    await api.execute('font.add', { data, name: 'NotoSansCJKsc-Regular.otf' })
  } catch (error) {
    // WordCraft retains installed fonts in IndexedDB on this origin.
    if (!String(error?.message || error).includes('already available: Noto Sans CJK SC')) throw error
  }
}
function changed() {
  if (!opened || readOnly) return
  port.postMessage({type:'modified'})
}
window.addEventListener('message', ({ origin, source, data, ports }) => {
  if (origin !== location.origin) return
  if (source === parent && data?.type === 'mybuddy-office-connect' && !port && ports.length === 1) {
    port = ports[0]
    let queue = Promise.resolve()
    port.onmessage = ({ data: request }) => {
      queue = queue.then(async () => {
        try {
          const result = await dispatch(request)
          port.postMessage({ id: request.id, ok: true, result }, result instanceof ArrayBuffer ? [result] : [])
        } catch (error) {
          port.postMessage({ id: request.id, ok: false, error: error?.message || String(error) })
        }
      })
    }
    port.postMessage({ type: 'ready' })
    return
  }
  if (source !== frame.contentWindow || !engine) return
  if (data?.type === engine + ':ready') startup?.resolve()
  if (data?.type === engine + ':failed') startup?.reject(new Error(data.error || 'Office 编辑器启动失败'))
  if (data?.type === engine + ':dirty' && data.dirty) changed()
  if (data?.type === engine + ':save') {
    const payload = data.bytes
    if (!ArrayBuffer.isView(payload) && !(payload instanceof ArrayBuffer)) return
    const bytes = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength).slice().buffer
    if (saving && data.name === name) saving.resolve(bytes)
    else if (opened && !readOnly) {
      const suffix = { word:'.docx', excel:'.xlsx', ppt:'.pptx' }[kind]
      if (!data.name?.toLowerCase().endsWith(suffix)) {
        port.postMessage({ type:'notice', text:'请在编辑器中使用“另存为”，选择当前 Office 格式。' })
      } else {
        const type = !data.saveAs && data.name === name ? 'save-requested' : 'export-requested'
        port.postMessage({type, bytes}, [bytes])
      }
    }
  }
})
async function open(request) {
  if (initializing || !Object.hasOwn(engines, request.kind)) throw new Error('无法打开文档')
  initializing = true
  kind = request.kind
  name = request.name
  readOnly = Boolean(request.readOnly)
  engine = engines[kind]
  adapter = globalThis.MyBuddyCraftAdapters[kind]
  startup = deadline('Office 编辑器启动超时')
  frame.src = '/' + engine + '/index.html?host=parent'
  const [, font] = await Promise.all([startup.promise, kind === 'excel' ? undefined : chineseFont()])
  const win = frame.contentWindow
  api = win[engine]
  // Install before loading slides: DeckCraft caches thumbnails during document import.
  if (font) await installFont(font)
  // File payloads go through the native host transport without a base64 copy.
  win.postMessage({ type: engine + ':open', name, bytes: request.bytes }, location.origin, [request.bytes])
  {
    const until = performance.now() + 45000
    for (;;) {
      try {
        if (await filename() === name) break
      } catch (error) {
        if (kind !== 'excel' || !String(error?.message || error).includes('no workbook open')) throw error
      }
      if (performance.now() > until) throw new Error('编辑器未能打开 ' + name)
      await pause(30)
    }
  }
  await adapter.attach?.(api, win)
  const nativeReadOnly = readOnly && await globalThis.enableMyBuddyCraftReadOnly(kind, api)
  if (readOnly && !nativeReadOnly) {
    // The canvas also contains editing menus. Only navigation reaches it in reference views.
    for (const type of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','contextmenu','drop','paste','cut','beforeinput','compositionstart','compositionupdate','compositionend']) {
      win.addEventListener(type, event => { event.preventDefault(); event.stopImmediatePropagation() }, true)
    }
  }
  win.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!readOnly && !event.repeat) port.postMessage({ type: event.shiftKey ? 'export-requested' : 'save-requested' })
    } else if (readOnly && !nativeReadOnly && !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End','Tab'].includes(event.key)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }, true)
  win.addEventListener('compositionstart', () => { composing = true }, true)
  win.addEventListener('compositionend', () => { composing = false }, true)
  win.addEventListener('blur', () => { composing = false })
  opened = true
  return { readOnly }
}
async function dispatch(request) {
  if (request.type === 'open') return open(request)
  if (!opened || await filename() !== name) throw new Error('当前文件已切换，请从 MyBuddy 重新打开文档')
  if (request.type === 'document') {
    const query = request.query
    if (query.action === 'read' && query.target?.kind !== kind) throw new Error('请提供与当前文档格式匹配的读取位置。')
    if (query.action === 'find' && !query.query?.trim()) throw new Error('请提供查找关键词。')
    if (query.action === 'evaluate' && (kind !== 'excel' || !query.evaluation)) throw new Error('请提供 Excel 工作表、公式和单元格。')
    return { kind, name, readOnly, ...await adapter.document(api, query) }
  }
  if (request.type === 'render') {
    const target = request.target
    if (target?.kind !== kind) throw new Error('渲染位置与当前 Office 文档格式不符。')
    if (kind === 'excel') {
      const book = await api.docInspect()
      if (book.sheets[book.activeSheet]?.name !== target.sheet) throw new Error('请在编辑器中切换到要检查的 Excel 工作表。')
      return true
    }
    const params = kind === 'word' ? { page: target.pageIndex + 1 } : { slide: target.slideIndex }
    const rendered = await api.request('ui.render', { ...params, scale: 1 })
    return rendered.png
  }
  if (request.type === 'review-current') {
    if (verifiedEdit?.id !== request.proposalId || !verifiedEdit?.check) return false
    return (await verifiedEdit.check()).matched
  }
  if (request.type === 'select') {
    capture = undefined
    edit = undefined
    const target = request.target
    if (target) {
      if (target.kind !== kind) throw new Error('定位位置与当前 Office 文档格式不符。')
      if (readOnly) throw new Error('只读文档请使用文档读取工具。')
      if (composing || (await api.uiInspect()).dialog) throw new Error('请先完成编辑器里正在进行的输入或对话框操作。')
    }
    const selection = await (target ? adapter.captureTarget(api, target) : adapter.read(api))
    capture = { ...selection, captureId: crypto.randomUUID() }
    if (readOnly) Object.assign(capture, { editable: false, reason: '文档只读' })
    return capture
  }
  if (readOnly) throw new Error('文档只读')
  if (request.type === 'edit-stage') {
    if (request.operation?.kind !== kind) throw new Error('编辑操作与当前文档格式不符。')
    if (composing || (await api.uiInspect()).dialog) throw new Error('请先完成编辑器里正在进行的输入或对话框操作。')
    const plan = await adapter.prepareEdit(api, request.operation)
    capture = undefined
    edit = { id: crypto.randomUUID(), apply: plan.apply }
    return { ...plan.preview, id: edit.id }
  }
  if (request.type === 'save') {
    saving = deadline('编辑器未返回保存文件')
    try {
      const [bytes] = await Promise.all([saving.promise, api.execute('file.save', {})])
      return bytes
    } finally { saving = undefined }
  }
  if (request.type === 'apply') {
    let result
    if (request.editId) {
      if (!edit || request.editId !== edit.id) throw new Error('编辑提议已过期，请重新提交。')
      if (composing || (await api.uiInspect()).dialog) throw new Error('请先完成编辑器里正在进行的输入或对话框操作。')
      const { apply } = edit
      edit = undefined
      result = await apply()
    } else {
      if (!capture || capture.captureId !== request.captured?.captureId) throw new Error('选区已变化，请重新选择')
      if (capture.editable === false) throw new Error(capture.reason || '选区只读')
      result = await adapter.apply(api, capture, request.proposal)
      capture = undefined
    }
    const { check, ...receipt } = result
    if (receipt.changed) {
      verifiedEdit = request.proposalId && check ? { id: request.proposalId, check } : undefined
      changed()
    }
    return receipt
  } else throw new Error('未知编辑操作')
}
