(function () {
  'use strict'

  const MAX_TEXT = 32_000
  const { clip, page } = globalThis.MyBuddyOfficeDocument
  const NUMBER_FIELD = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/
  function asTsvField(cell) {
    const value = String(cell.value ?? '')
    const needsTypeQuote = cell.kind === 'text' && (value.startsWith('=') || NUMBER_FIELD.test(value))
    return needsTypeQuote || /^"|[\t\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value
  }

  // Quoted fields preserve literal tabs, quotes and newlines.
  function parseTsv(input) {
    const rows = []
    let row = []
    let offset = 0
    while (true) {
      let value = ''
      const quoted = input[offset] === '"'
      if (quoted) {
        offset += 1
        let closed = false
        while (offset < input.length) {
          const character = input[offset++]
          if (character === '"') {
            if (input[offset] !== '"') {
              closed = true
              break
            }
            offset += 1
          }
          value += character
        }
        if (!closed || (offset < input.length && !/[\t\n\r]/.test(input[offset]))) {
          throw new Error('Invalid quoted spreadsheet field.')
        }
      } else {
        while (offset < input.length && !/[\t\n\r]/.test(input[offset])) value += input[offset++]
      }
      row.push({ value, quoted })
      if (input[offset] === '\t') {
        offset += 1
        continue
      }
      rows.push(row)
      if (offset === input.length) return rows
      row = []
      if (input[offset] === '\r' && input[offset + 1] === '\n') offset += 1
      offset += 1
    }
  }

  function tsvCell(field, original) {
    const { value, quoted } = field
    if (value === String(original.value ?? '') && (!quoted || original.kind === 'text' || /^"|[\t\r\n]/.test(value))) return original
    if (value === '') return { kind: 'empty' }
    if (quoted) return { kind: 'text', value }
    if (value.startsWith('=')) return { kind: 'formula', value }
    if (NUMBER_FIELD.test(value) &&
        Number.isFinite(Number(value))) {
      return { kind: 'number', value: Number(value) }
    }
    return { kind: 'text', value }
  }

  function typedCell(cell, original) {
    if (cell === null) return original
    if (cell?.kind === 'empty') return { kind: 'empty' }
    if (cell?.kind === 'text' && cell.value === '') return { kind: 'empty' }
    if (cell?.kind === 'number' && Number.isFinite(cell.value)) return { kind: cell.kind, value: cell.value }
    if (typeof cell?.value === 'string' &&
        (cell.kind === 'text' || (cell.kind === 'formula' && /^=.+/.test(cell.value)))) {
      return { kind: cell.kind, value: cell.value }
    }
    throw new Error('Invalid typed spreadsheet cell.')
  }

  function decode(proposal, original) {
    const typed = proposal.cells !== undefined
    if (!typed && (typeof proposal.text !== 'string' || proposal.text.length > MAX_TEXT)) {
      throw new Error('Provide a spreadsheet replacement of at most 32,000 characters.')
    }
    const rows = typed ? proposal.cells : parseTsv(proposal.text)
    if (!Array.isArray(rows) || rows.length !== original.length ||
        rows.some(row => !Array.isArray(row) || row.length !== original[0].length)) {
      throw new Error('The replacement must have the same number of rows and columns as the selection.')
    }
    const cells = rows.map((row, y) => row.map((cell, x) =>
      typed ? typedCell(cell, original[y][x]) : tsvCell(cell, original[y][x])))
    if (cells.some(row => row.some(cell =>
      typeof cell.value === 'string' && (cell.value.length > MAX_TEXT ||
        (cell.kind === 'formula' && (cell.value.length < 2 || /[\r\n]/.test(cell.value))))))) {
      throw new Error('Spreadsheet formulas must be single-line, and each cell can hold up to 32,000 characters.')
    }
    return cells
  }

  const adapters = globalThis.MyBuddyCraftAdapters ??= {}

  function rectangle(address, maxCells) {
    const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/.exec(address.toUpperCase())
    if (!match) throw new Error('请提供类似 A1:D20 的单元格范围。')
    const column = letters => Array.from(letters).reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0)
    const [, first, top, last = first, bottom = top] = match
    const width = column(last) - column(first) + 1
    const height = Number(bottom) - Number(top) + 1
    if (width < 1 || height < 1 || column(last) > 16384 || Number(bottom) > 1048576) throw new Error('该区域超出 Excel 工作表范围。')
    if (width * height > maxCells) throw new Error(`单次最多处理 ${maxCells} 个单元格，请缩小范围。`)
    return { address: width * height === 1 ? first + top : `${first}${top}:${last}${bottom}`, width, startRow: Number(top) }
  }

  function sheetIndex(book, name) {
    const index = book.sheets.findIndex(sheet => sheet.name === name)
    if (index < 0) throw new Error('找不到该 Excel 工作表，请重新查看工作簿。')
    return index
  }

  async function document(api, query) {
    const book = await api.docInspect()
    if (query.action === 'inspect') return { activeSheet: book.sheets[book.activeSheet]?.name, selection: book.selection, ...page(book.sheets, query, sheet => ({
      name: sheet.name, usedRange: sheet.usedRange, protected: sheet.protected, visibility: sheet.visibility,
    })) }
    if (query.action === 'find') {
      if (book.sheets.reduce((sum, sheet) => sum + sheet.cells, 0) > 250_000) {
        throw new Error('工作簿有超过 250,000 个已用单元格。请用 read 按工作表分批读取。')
      }
      try {
        const found = await api.execute('edit.find', {
          what: query.query.replace(/[~*?]/g, '~$&'), within: 'workbook', lookIn: 'values', all: true,
        })
        return page(found.results, query, hit => ({ sheet: hit.sheet, address: hit.cell, preview: clip(hit.value) }))
      } catch (error) {
        if (!String(error?.message || error).includes("couldn't find what you were looking for")) throw error
        return page([], query)
      }
    }
    const target = query.target
    const range = rectangle(target.address, 1024)
    const data = await api.execute('sheet.read', {
      sheet: sheetIndex(book, target.sheet), range: range.address,
      formulas: target.values === 'formulas', formatted: target.values === 'formatted',
    })
    const charsPerCell = Math.min(4_000, Math.floor(2_400 / range.width))
    let truncated = false
    const result = page(data.values, query, row => row.map(value => {
      const bounded = clip(value, charsPerCell)
      truncated ||= bounded !== value
      return bounded
    }))
    return { sheet: data.sheet, address: data.range, values: target.values ?? 'raw', firstRow: range.startRow + (query.offset ?? 0), ...result, ...(truncated ? { truncated: true } : {}) }
  }

  async function read(api) {
    const captured = await api.execute('mybuddy.rangeRead', {})
    const content = captured.cells.map(row => row.map(asTsvField).join('\t')).join('\n')
    if (content.length > MAX_TEXT) throw new Error('Select up to 32,000 characters of spreadsheet content.')
    return { ...captured, content, reason: captured.editable ? undefined : 'Select cells on an unprotected sheet.' }
  }

  async function captureTarget(api, target) {
    const range = rectangle(target.address, 256)
    const book = await api.docInspect()
    const sheet = sheetIndex(book, target.sheet)
    const state = await api.uiInspect()
    if (state.editor || state.dialog || state.selectedObject != null) throw new Error('请先结束正在进行的 Excel 编辑，再定位单元格。')
    await api.execute('selection.set', { range: range.address, sheet })
    const captured = await read(api)
    if (captured.target.sheet !== target.sheet || captured.target.address !== range.address) throw new Error('Excel 当前工作表或选区已变化，请重新读取。')
    return captured
  }

  adapters.excel = {
    document,
    read,
    captureTarget,

    async apply(api, captured, proposal) {
      const cells = decode(proposal, captured.cells)
      const { document, sheetUid, target } = captured
      return api.execute('mybuddy.rangeReplace', {
        captured: { document, sheetUid, target, cells: captured.cells },
        cells
      })
    }
  }
})()
