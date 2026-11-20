(() => {
  const captures = new WeakMap()
  const maxLength = 32000
  const forbidden = /[\u0000-\u001f\u2028\u2029\ufffc]/u
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const conflict = () => error('selection-conflict', '原 Word 选区已变化，请重新选取。')
  const { clip, page, textPage, uniqueOffset, literalPattern, reviewedEdit } = globalThis.MyBuddyOfficeDocument

  function error(code, message) {
    return Object.assign(new Error(message), { code })
  }

  function formatAt(block, start, end) {
    const direct = block.runs ?? []
    // v0.18.1 exposes only the first 50 nonempty formatting runs per paragraph.
    if (direct.length === 50 && end > direct[49].end) return null
    const runs = direct.filter(run => run.start < end && run.end > start)
    if (!runs.length) return '{}'
    if (runs.length !== 1 || runs[0].start > start || runs[0].end < end) return null
    const props = runs[0].props ?? {}
    if (props.ins || props.del || props.fmtChange || props.link) return null
    return JSON.stringify(props)
  }

  function inspect(doc) {
    const { anchor, focus, text: content } = doc.selection ?? {}
    if (typeof content !== 'string' || !content || content.length > maxLength) {
      throw error('unsupported-selection', '请在 Word 中选取不超过 32,000 字符的文字。')
    }
    const selection = { anchor, focus, content }
    if (anchor?.story !== 'body' || focus?.story !== 'body' ||
        anchor.path?.length !== 1 || focus.path?.length !== 1 ||
        anchor.path[0] !== focus.path[0] || forbidden.test(content)) {
      return { ...selection, reason: '请选择单段 Word 正文中的连续文字。' }
    }
    const block = doc.blocks.find(item => item.index === anchor.path[0])
    if (block?.type !== 'paragraph' || typeof block.text !== 'string' ||
        block.objects?.length || doc.comments || doc.trackChanges) {
      return { ...selection, reason: '请选择不含内嵌对象、批注或修订的正文文字。' }
    }
    // WordCraft addresses ranges in UTF-8 bytes. Office Use displays UTF-16 offsets.
    const bytes = encoder.encode(block.text)
    const start = Math.min(anchor.off, focus.off)
    const end = Math.max(anchor.off, focus.off)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > bytes.length ||
        bytes.length !== block.len || decoder.decode(bytes.subarray(start, end)) !== content) {
      return { ...selection, reason: 'WordCraft 无法确认该选区的位置。' }
    }
    const format = formatAt(block, start, end)
    if (format === null) return { ...selection, reason: '请选择一段格式一致的普通文字。' }
    const prefix = decoder.decode(bytes.subarray(0, start))
    return { ...selection, block, start, end, prefix, suffix: decoder.decode(bytes.subarray(end)), format }
  }

  async function snapshot(api) {
    const { document } = await api.uiInspect()
    const protection = await api.execute('review.restrict', {})
    const current = inspect(await api.docInspect({ text: true }))
    if (protection.protection) current.reason = '当前 Word 文档已限制编辑。'
    return { ...current, document }
  }

  async function read(api) {
    captures.delete(api)
    const current = await snapshot(api)
    const id = crypto.randomUUID()
    captures.set(api, { id, current })
    return {
      target: {
        kind: 'word', id, story: current.anchor?.story,
        anchor: current.anchor, focus: current.focus,
        ...(current.prefix !== undefined ? { paragraphIndex: current.block.index, offset: current.prefix.length } : {}),
        length: current.content.length,
      },
      content: current.content,
      editable: !current.reason,
      ...(current.reason ? { reason: current.reason } : {}),
    }
  }

  async function document(api, query) {
    const doc = await api.docInspect({ text: true })
    if (query.action === 'inspect') {
      return { pages: doc.pages, words: doc.words, ...page(doc.blocks, query, block => ({
        blockIndex: block.index, type: block.type, style: block.style, preview: clip(block.text),
        rows: block.rows, columns: block.cols, list: block.list, objectCount: block.objects?.length,
      })) }
    }
    if (query.action === 'find') {
      const pattern = literalPattern(query.query)
      const hits = []
      const match = (text, location) => {
        const found = typeof text === 'string' && pattern.exec(text)
        if (found) hits.push({ ...location, text: found[0], preview: clip(text.slice(Math.max(0, found.index - 100))) })
      }
      for (const block of doc.blocks) {
        match(block.text, { blockIndex: block.index })
        block.cells?.forEach((row, y) => row.forEach((text, x) => match(text, { blockIndex: block.index, row: y, column: x })))
      }
      return page(hits, query)
    }
    const block = doc.blocks.find(item => item.index === query.target.blockIndex)
    if (!block) throw new Error('找不到指定的 Word 正文块。')
    const location = { blockIndex: block.index, type: block.type, style: block.style, list: block.list }
    if (Array.isArray(block.cells)) return { ...location, columns: block.cols, ...page(block.cells, query, row => row.map(text => clip(text, 300))) }
    return { ...location, ...textPage(block.text ?? '', query.offset) }
  }

  async function captureTarget(api, target) {
    const doc = await api.docInspect({ text: true })
    const block = doc.blocks.find(item => item.index === target.blockIndex)
    if (block?.type !== 'paragraph' || typeof block.text !== 'string') throw new Error('Word 定位改写需要指定一个正文段落。')
    const start = uniqueOffset(block.text, target.text)
    const anchor = { story: 'body', path: [block.index], off: encoder.encode(block.text.slice(0, start)).length }
    const focus = { ...anchor, off: anchor.off + encoder.encode(target.text).length }
    await api.execute('select.range', { anchor, focus })
    const selection = await read(api)
    if (selection.target.anchor?.path?.[0] !== block.index || selection.target.anchor.off !== anchor.off ||
        selection.target.focus?.off !== focus.off || selection.content !== target.text) throw conflict()
    return selection
  }

  async function apply(api, captured, proposal) {
    const text = proposal?.text
    if (typeof text !== 'string' || text.length > maxLength || forbidden.test(text)) {
      throw error('invalid-proposal', '请使用不超过 32,000 字符的单段 Word 替换文字。')
    }
    const saved = captures.get(api)
    if (!saved || captured?.target?.kind !== 'word' || captured.target.id !== saved.id ||
        captured.content !== saved.current.content) throw conflict()
    if (saved.current.reason) throw error('unsupported-selection', saved.current.reason)

    let current
    try {
      current = await snapshot(api)
    } catch (cause) {
      if (cause.code !== 'unsupported-selection') throw cause
      throw conflict()
    }
    if (current.reason || JSON.stringify(current) !== JSON.stringify(saved.current)) throw conflict()

    captures.delete(api)
    const verification = { matched: true, blockIndex: current.block.index, preview: clip(text) }
    if (text === current.content) return { content: text, changed: false, verification }

    // The native replacement and deletion each create a single undo action.
    if (text) await api.execute('text.insert', { text, raw: true })
    else await api.execute('text.delete', {})

    const rangeEnd = current.start + encoder.encode(text).length
    const check = async () => {
      const doc = await api.docInspect({ text: true })
      const block = doc.blocks.find(item => item.index === current.block.index)
      const matched = block?.text === current.prefix + text + current.suffix &&
        JSON.stringify(block.props) === JSON.stringify(current.block.props) &&
        (!text || formatAt(block, current.start, rangeEnd) === current.format)
      return { ...verification, matched }
    }
    if (!(await check()).matched) {
      await api.execute('edit.undo', {})
      throw error('unsupported-selection', 'WordCraft 无法保留此选区的格式，已撤销替换。')
    }
    return { content: text, changed: true, verification, check }
  }

  async function prepareEdit(api, { action, blockIndex, style }) {
    if (action !== 'paragraphStyle' || !['Normal', 'Title', 'Heading1', 'Heading2', 'Heading3'].includes(style)) {
      throw new Error('请选择支持的 Word 段落样式。')
    }
    const read = async () => {
      const doc = await api.docInspect({ text: true })
      const block = doc.blocks.find(item => item.index === blockIndex)
      if (doc.trackChanges || block?.type !== 'paragraph') throw new Error('请选择可编辑的 Word 正文段落，并先结束修订。')
      return block
    }
    const original = await read()
    return reviewedEdit({
      preview: {
        target: { kind: 'word', blockIndex }, label: `Word 正文 · 第 ${blockIndex + 1} 个内容块`,
        before: `${original.style ?? 'Normal'}\n${clip(original.text, 1200)}`, after: `段落样式改为 ${style}`,
      },
      original, read, unchanged: (original.style ?? 'Normal') === style,
      async write() {
        const point = { story: 'body', path: [blockIndex], off: 0 }
        await api.execute('select.range', { anchor: point, focus: point })
        await api.execute('para.style', { style })
      },
      async verify() {
        const block = await read()
        return { matched: block.style === style && block.text === original.text, style: block.style }
      },
    })
  }

  globalThis.MyBuddyCraftAdapters ??= {}
  globalThis.MyBuddyCraftAdapters.word = { document, read, captureTarget, apply, prepareEdit }
})()
