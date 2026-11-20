(() => {
  'use strict'

  function clip(text, length = 400) {
    return typeof text === 'string' && text.length > length ? text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '') + '…' : text
  }

  function page(items, { offset = 0, limit = 20 }, project = item => item) {
    const rows = []
    let size = 0
    for (let i = offset; i < items.length && rows.length < limit; i++) {
      const row = project(items[i], i)
      size += JSON.stringify(row).length + 1
      if (size > 20_000) {
        if (!rows.length) throw new Error('内容过长，请缩小读取范围。')
        break
      }
      rows.push(row)
    }
    const end = offset + rows.length
    return { items: rows, total: items.length, ...(end < items.length ? { nextOffset: end } : {}) }
  }

  function uniqueOffset(content, expected) {
    const offset = content.indexOf(expected)
    if (offset < 0) throw new Error('该位置的原文已变化，请重新读取。')
    if (content.indexOf(expected, offset + 1) !== -1) throw new Error('原文在同一段中出现多次，请提供更长且唯一的原文。')
    return offset
  }

  function textPage(text, start = 0) {
    let end = Math.min(start + 4_000, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    return { text: text.slice(start, end), totalCharacters: text.length, ...(end < text.length ? { nextOffset: end } : {}) }
  }

  function literalPattern(text) {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  }

  globalThis.MyBuddyOfficeDocument = { clip, page, textPage, uniqueOffset, literalPattern }
})()
