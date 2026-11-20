(function () {
  'use strict'

  const MAX_TEXT = 32_000
  const chartKinds = new Map([['column', 'ColumnClustered'], ['bar', 'BarClustered'], ['line', 'Line'], ['pie', 'Pie']])
  const { clip, page, reviewedEdit } = globalThis.MyBuddyOfficeDocument
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
    return { address: width * height === 1 ? first + top : `${first}${top}:${last}${bottom}`, width, height, startRow: Number(top), startColumn: column(first) }
  }

  function columnLabel(column) {
    let label = ''
    for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label
    return label
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
      freeze: sheet.freeze, autofilter: sheet.autofilter, chartCount: sheet.charts.length, tableCount: sheet.tables.length,
    })) }
    if (query.action === 'evaluate') {
      const { sheet, cell, formula } = query.evaluation
      const range = rectangle(cell, 1)
      if (sheetIndex(book, sheet) !== book.activeSheet) throw new Error('试算使用当前工作表。请先在编辑器中切换到指定工作表。')
      return { sheet, cell: range.address, formula, value: await api.execute('formulas.evaluate', { cell: range.address, formula }) }
    }
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

  async function prepareEdit(api, operation) {
    const { action, sheet, title, chartType } = operation
    const readSheet = async () => {
      const book = await api.docInspect()
      const index = sheetIndex(book, sheet)
      if (book.sheets[index].protected) throw new Error('当前 Excel 工作表受保护。')
      return { index, state: book.sheets[index] }
    }
    const target = { kind: 'excel', sheet }
    if (action === 'freezeTopRow') {
      const read = async () => {
        const { index, state } = await readSheet()
        return { index, freeze: state.freeze }
      }
      const original = await read()
      const frozen = JSON.stringify(original.freeze) === '[1,0]'
      return reviewedEdit({
        preview: { target, label: sheet, before: original.freeze ? `当前冻结行列 ${original.freeze.join('、')}` : '未冻结窗格', after: '仅冻结第一行' },
        original, read, unchanged: frozen,
        write: () => api.execute('view.freezeTopRow', { sheet: original.index }),
        async verify() {
          const { freeze } = await read()
          return { matched: JSON.stringify(freeze) === '[1,0]', freeze }
        },
      })
    }
    if (action === 'numberFormat') {
      const { code } = operation
      if (typeof code !== 'string' || !code.trim() || code.length > 80 || /[\u0000-\u001f]/.test(code)) throw new Error('请提供有效的数字格式代码。')
      const range = rectangle(operation.address, 64)
      const cells = Array.from({ length: range.width * range.height }, (_, i) =>
        columnLabel(range.startColumn + (i % range.width)) + (range.startRow + Math.floor(i / range.width)))
      const read = async () => {
        const { index } = await readSheet()
        const values = await Promise.all(cells.map(cell => api.execute('cell.get', { cell, sheet: index })))
        return { index, values: values.map(({ value, formula, style }) => ({ value, formula, format: style.num_fmt })) }
      }
      const original = await read()
      return reviewedEdit({
        preview: {
          target: { ...target, address: range.address }, label: `${sheet} · ${range.address}`,
          before: Array.from(new Set(original.values.map(cell => cell.format))).join('\n'), after: code,
        },
        original, read, unchanged: original.values.every(cell => cell.format === code),
        write: () => api.execute('home.numberFormat', { sheet: original.index, range: range.address, code }),
        async verify() {
          const result = await read()
          const expected = original.values.map(cell => ({ ...cell, format: code }))
          return { matched: JSON.stringify(result.values) === JSON.stringify(expected), numberFormat: code }
        },
      })
    }
    if (action !== 'insertChart' || !chartKinds.has(chartType)) throw new Error('该 Excel 图表类型或编辑操作不可用。')
    const range = rectangle(operation.address, 1024).address
    const at = rectangle(operation.at, 1).address
    const read = async () => {
      const { index, state } = await readSheet()
      const data = await api.execute('sheet.read', { sheet: index, range })
      return { index, charts: state.charts, values: data.values }
    }
    const original = await read()
    return reviewedEdit({
      preview: {
        target: { ...target, address: range }, label: `${sheet} · ${range}`,
        before: original.values.slice(0, 4).map(row => row.map(value => clip(String(value ?? ''), 80)).join('\t')).join('\n'),
        after: `在 ${at} 插入 ${chartType} 图表\n${title}`,
      },
      original, read,
      write: () => api.execute('insert.chart', { sheet: original.index, range, at, type: chartType, title }),
      async verify({ chart: id }) {
        const { state } = await readSheet()
        const chart = state.charts.find(item => item.id === id)
        return { matched: chart?.at === at && chart?.title === title && chart?.kind === chartKinds.get(chartType), chart }
      },
    })
  }

  adapters.excel = {
    document,
    read,
    captureTarget,
    prepareEdit,

    async apply(api, captured, proposal) {
      const cells = decode(proposal, captured.cells)
      const { document, sheetUid, target } = captured
      const result = await api.execute('mybuddy.rangeReplace', {
        captured: { document, sheetUid, target, cells: captured.cells },
        cells
      })
      const check = async () => {
        const book = await api.docInspect()
        const sheet = sheetIndex(book, target.sheet)
        const [raw, formulas] = await Promise.all([
          api.execute('sheet.read', { sheet, range: target.address }),
          api.execute('sheet.read', { sheet, range: target.address, formulas: true }),
        ])
        const expected = cells.map(row => row.map(cell => cell.value ?? null))
        const matched = JSON.stringify(expected) === JSON.stringify(formulas.values)
        return {
          matched, sheet: target.sheet, address: target.address,
          errors: raw.values.flat().filter(value => value && typeof value === 'object' && 'error' in value).slice(0, 10),
        }
      }
      try {
        return { ...result, verification: await check(), check }
      } catch (error) {
        return { ...result, verification: { matched: false, error: String(error?.message ?? error) } }
      }
    }
  }
})()
