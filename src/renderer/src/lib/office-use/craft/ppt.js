(() => {
  'use strict'

  globalThis.MyBuddyCraftAdapters ??= {}
  const { clip, page, textPage, uniqueOffset } = globalThis.MyBuddyOfficeDocument

  const comparePosition = (left, right) => left[0] - right[0] || left[1] - right[1]

  function selectedTarget(document) {
    const { slide: slideIndex, text } = document.selection
    if (!text || text.notes || text.cell || document.selection.cells ||
        !Number.isInteger(text.shape) || comparePosition(text.anchor, text.caret) === 0) {
      throw new Error('请在幻灯片的文本框内选中要改写的文字。')
    }
    const [start, end] = [text.anchor, text.caret].sort(comparePosition)
    return {
      kind: 'shape-text-span',
      slideIndex,
      slideId: document.slides[slideIndex].id,
      shapeId: text.shape,
      start,
      end
    }
  }

  async function read(api) {
    const document = await api.docInspect()
    const target = selectedTarget(document)
    const { paragraphs } = await api.execute('text.get', { id: target.shapeId })
    const [first, from] = target.start
    const [last, to] = target.end
    const content = paragraphs.slice(first, last + 1).map(({ text }, index) => {
      const paragraph = first + index
      return Array.from(text).slice(paragraph === first ? from : 0, paragraph === last ? to : undefined).join('')
    }).join('\n')
    if (!content) throw new Error('请在幻灯片的文本框内选中要改写的文字。')
    return { target, content }
  }

  async function document(api, query) {
    if (query.action === 'inspect') {
      const deck = await api.docInspect()
      return { activeSlideIndex: deck.selection.slide, ...page(deck.slides, query, slide => ({
        slideIndex: slide.index, slideId: slide.id, title: clip(slide.title), layout: slide.layout,
        shapeCount: slide.shapes, hidden: slide.hidden, hasNotes: Boolean(slide.notes),
      })) }
    }
    if (query.action === 'find') {
      const hits = await api.execute('text.find', { text: query.query })
      return page(hits, query, hit => ({ slideIndex: hit.slide, shapeId: hit.shape, paragraphIndex: hit.para, from: hit.start, to: hit.end }))
    }
    const { slideIndex, shapeId, notes } = query.target
    const slide = await api.execute('slide.inspect', { index: slideIndex })
    const location = { slideIndex, slideId: slide.id, title: clip(slide.title) }
    if (notes) return { ...location, section: 'notes', ...textPage(slide.notes ?? '', query.offset) }
    if (shapeId !== undefined) {
      const shape = slide.shapes.find(item => item.id === shapeId)
      if (!shape) throw new Error('找不到指定的 PowerPoint 对象。')
      const description = { ...location, shapeId, type: shape.kind, label: clip(shape.name) }
      if (shape.table?.cells) return { ...description, columns: shape.table.cols, ...page(shape.table.cells, query, row => row.map(text => clip(text, 300))) }
      return { ...description, ...textPage(shape.text ?? '', query.offset) }
    }
    return { ...location, notesPreview: clip(slide.notes), ...page(slide.shapes, query, shape => ({
      shapeId: shape.id, type: shape.kind, label: clip(shape.name), preview: clip(shape.text), rows: shape.table?.rows, columns: shape.table?.cols,
    })) }
  }

  async function captureTarget(api, target) {
    const slide = await api.execute('slide.inspect', { index: target.slideIndex })
    if (!slide.shapes.some(shape => shape.id === target.shapeId && typeof shape.text === 'string' && shape.text.includes(target.text))) {
      throw new Error('找不到包含指定原文的幻灯片文本框，请重新读取。')
    }
    await api.execute('slide.go', { id: slide.id })
    const { paragraphs } = await api.execute('text.get', { id: target.shapeId })
    const matching = paragraphs.map((item, index) => ({ text: item.text, index })).filter(item =>
      (target.paragraphIndex === undefined || target.paragraphIndex === item.index) && item.text.includes(target.text))
    if (matching.length !== 1) throw new Error('请指定唯一的 PowerPoint 段落和原文。')
    const { text, index } = matching[0]
    const offset = uniqueOffset(text, target.text)
    const start = Array.from(text.slice(0, offset)).length
    const anchor = [index, start]
    const caret = [index, start + Array.from(target.text).length]
    await api.execute('text.edit', { id: target.shapeId, at: anchor })
    await api.execute('text.select', { anchor, caret })
    const selection = await read(api)
    if (selection.target.slideId !== slide.id || selection.target.shapeId !== target.shapeId || selection.content !== target.text ||
        comparePosition(selection.target.start, anchor) !== 0 || comparePosition(selection.target.end, caret) !== 0) {
      throw new Error('PowerPoint 当前对象或选区已变化，请重新读取。')
    }
    return selection
  }

  async function apply(api, captured, { text }) {
    let current
    try {
      current = await read(api)
    } catch {
      throw new Error('幻灯片选区已变化，请重新读取。')
    }
    if (JSON.stringify(current.target) !== JSON.stringify(captured.target) || current.content !== captured.content) {
      throw new Error('幻灯片选区已变化，请重新读取。')
    }
    const replacement = text.replace(/\r\n?/g, '\n')
    if (replacement === current.content) return { changed: 0 }
    const target = selectedTarget(await api.docInspect())
    if (JSON.stringify(target) !== JSON.stringify(current.target)) {
      throw new Error('幻灯片选区已变化，请重新读取。')
    }
    if (target.start[0] === target.end[0] && !/\n|\v/.test(replacement)) {
      // The positioned replacement keeps the selected run's style, even at its left edge.
      // Find skips overlapping matches, so exact selections it cannot find use the text editor.
      try {
        await api.execute('text.replace', {
          text: current.content,
          with: replacement,
          matchCase: true,
          at: {
            slide: target.slideIndex,
            shape: target.shapeId,
            para: target.start[0],
            start: target.start[1]
          }
        })
        return { changed: 1 }
      } catch (error) {
        if (!/no matches/.test(String(error))) throw error
        const latest = await read(api)
        if (JSON.stringify(latest.target) !== JSON.stringify(target) || latest.content !== current.content) {
          throw new Error('幻灯片选区已变化，请重新读取。')
        }
      }
    }
    if (replacement.length) await api.execute('text.insert', { text: replacement })
    else await api.execute('text.delete', { dir: 'forward' })
    return { changed: 1 }
  }

  globalThis.MyBuddyCraftAdapters.ppt = { document, read, captureTarget, apply }
})()
