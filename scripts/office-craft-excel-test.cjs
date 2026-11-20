'use strict'

const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const xlsx = require('xlsx')

const filename = '中文单元格改写验收.xlsx'
const initial = '请优先复核报销凭据'
const rewritten = '请复核预算与凭据'
const untouched = '邻近单元格保持原样'
const imeText = '中文输入验证成功'

function fixture() {
  const book = xlsx.utils.book_new()
  const sheet = xlsx.utils.aoa_to_sheet([
    [initial, 3, null, { t: 'n', v: 10, f: 'B1+7', z: '0.00' }],
    ['项目\t名称\n含 "引号"', null, untouched]
  ])
  sheet['!cols'] = [{ wch: 24 }, { wch: 14 }, { wch: 22 }, { wch: 10 }]
  xlsx.utils.book_append_sheet(book, sheet, '财务明细')
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['另一个工作表']]), '汇总')
  return xlsx.write(book, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = async function testExcel({ open, assert }) {
  const session = await open('excel', filename, fixture())
  const command = (id, params) => session.page(([name, args]) => window.gridcraft.execute(name, args), [id, params])
  const request = (id, params) => session.page(([name, args]) => window.gridcraft.request(name, args), [id, params])
  const select = range => command('selection.set', { range })
  const cell = address => request('cell.get', { cell: address })
  const glyphs = () => request('mybuddy.activeCellGlyphs', {})
  const editor = () => session.page(async () => (await window.gridcraft.uiInspect()).editor)

  async function waitFor(read, test, label) {
    let value
    for (let attempt = 0; attempt < 35; attempt++) {
      value = await read()
      if (test(value)) return value
      await new Promise(resolve => setTimeout(resolve, 35))
    }
    assert.fail(label + ' ' + JSON.stringify(value))
  }

  async function pressKey(key, virtualKey) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await session.cdp('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: virtualKey })
    }
  }

  async function compose(text) {
    await session.cdp('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
  }

  let saved
  let baselineD1
  try {
    const baseline = await session.page(() => window.gridcraft.docInspect())
    assert.equal(baseline.activeSheet, 0)
    assert.deepEqual(baseline.sheets.map(sheet => sheet.name), ['财务明细', '汇总'])
    const outline = await session.call('document', { action: 'inspect' })
    assert.deepEqual(outline.items.map(item => item.name), ['财务明细', '汇总'])
    const otherSheet = { kind: 'excel', sheet: '汇总', address: 'A1' }
    assert.deepEqual((await session.call('document', { action: 'read', target: otherSheet })).items, [['另一个工作表']])
    assert.deepEqual((await session.call('document', { action: 'find', query: '另一个' })).items, [{ sheet: '汇总', address: 'A1', preview: '另一个工作表' }])
    assert.deepEqual((await session.call('document', { action: 'read', target: { kind: 'excel', sheet: '财务明细', address: 'D1', values: 'formulas' } })).items, [['=B1+7']])
    const calc = await session.call('document', { action: 'evaluate', evaluation: { sheet: '财务明细', cell: 'D1', formula: '=SUM(B1,7)' } })
    assert.equal(calc.value, 10)
    assert.equal((await session.page(() => window.gridcraft.docInspect())).activeSheet, 0)
    const targeted = await session.call('select', { target: otherSheet })
    assert.equal(targeted.content, '另一个工作表')
    await session.call('apply', { captured: targeted, proposal: { text: '汇总已复核' } })
    assert.deepEqual((await session.call('document', { action: 'read', target: otherSheet })).items, [['汇总已复核']])
    await session.call('undo')
    await command('sheet.activate', { sheet: 0 })
    assert.equal((await cell('A1')).value, initial)
    baselineD1 = await cell('D1')
    assert.equal(baselineD1.formula, '=B1+7')
    assert.equal(baselineD1.text, '10.00')
    const baselineA1Style = (await cell('A1')).style
    await select('A1')
    assert.deepEqual(await glyphs(), { text: initial, missing: '' })

    // A real drag on the sheet selects A1:B2 for the capture button.
    await request('ui.cell.drag', { from: 'A1', to: 'B2' })
    await waitFor(() => session.page(() => window.gridcraft.docInspect()), book => book.selection === 'A1:B2', 'Selection did not follow grid drag')
    const captured = await session.call('select')
    assert.equal(captured.editable, true, captured.reason)
    assert.equal(captured.content, initial + '\t3\n"项目\t名称\n含 ""引号"""\t')
    assert.deepEqual(captured.target, {
      kind: 'cell-range', sheet: '财务明细', sheetIndex: 0, address: 'A1:B2',
      startColumn: 0, endColumn: 1, startRow: 0, endRow: 1
    })
    const reviewed = {
      text: rewritten + '\t4\n"项目\t名称\n含 ""引号"""\t"=保留为文本"'
    }

    await select('C2')
    await assert.rejects(session.call('apply', { captured, proposal: reviewed }), /range changed/i)
    assert.equal((await cell('A1')).value, initial)
    await select('A1:B2')
    await command('cell.set', { cell: 'B1', input: 5 })
    await assert.rejects(session.call('apply', { captured, proposal: reviewed }), /cells changed/i)
    await command('edit.undo', {})

    const fresh = await session.call('select')
    await assert.rejects(session.call('apply', { captured: fresh, proposal: { text: '不会写入\t=(' + '\n保留\t' } }), /formula/i)
    assert.equal((await cell('A1')).value, initial)
    await session.call('apply', { captured: fresh, proposal: reviewed })
    assert.equal((await cell('A1')).value, rewritten)
    assert.equal((await cell('B1')).value, 4)
    assert.equal((await cell('B2')).formula, null)
    assert.equal((await cell('B2')).value, '=保留为文本')
    assert.deepEqual((await cell('A1')).style, baselineA1Style)
    assert.equal((await cell('C2')).value, untouched)
    assert.equal((await cell('D1')).formula, baselineD1.formula)
    assert.equal((await cell('D1')).text, '11.00')
    assert.deepEqual((await cell('D1')).style, baselineD1.style)

    await session.call('undo')
    assert.equal((await cell('A1')).value, initial)
    assert.equal((await cell('B1')).value, 3)
    assert.equal((await cell('B2')).value, null)
    await session.call('redo')
    assert.equal((await cell('A1')).value, rewritten)
    assert.equal((await cell('B2')).value, '=保留为文本')

    await select('E1:F1')
    const typed = await session.call('select')
    await session.call('apply', { captured: typed, proposal: { cells: [[
      { kind: 'formula', value: '=2+3' }, { kind: 'text', value: '23' }
    ]] } })
    assert.equal((await cell('E1')).formula, '=2+3')
    assert.equal((await cell('E1')).value, 5)
    assert.equal((await cell('F1')).type, 'text')
    assert.equal((await cell('F1')).value, '23')

    // Enter the cell editor with F2 before sending Chromium's composition events.
    await request('ui.cell.click', { cell: 'A3' })
    await session.page(() => document.querySelector('canvas').focus())
    await waitFor(() => session.page(() => window.gridcraft.docInspect()), book => book.selection === 'A3', 'A3 was not selected')
    await pressKey('F2', 113)
    await waitFor(editor, state => state?.cell === 'A3', 'The cell editor did not open')
    await waitFor(() => session.page(() => document.activeElement?.matches('input[type=text]')), Boolean, 'The eframe text input was not focused')

    await compose('zhongwen')
    assert.equal((await cell('A3')).value, null)
    await compose('')
    await waitFor(editor, state => state?.text === '', 'Canceled composition remained in the editor')
    assert.equal((await cell('A3')).value, null)
    await compose('zhongwen')
    await session.cdp('Input.insertText', { text: imeText })
    await waitFor(editor, state => state?.text === imeText, 'Committed composition was not in the cell editor')
    assert.equal((await cell('A3')).value, null)
    await pressKey('Enter', 13)
    await waitFor(() => cell('A3'), entry => entry.value === imeText, 'The committed editor text did not reach the workbook')
    await select('A3')
    assert.deepEqual(await glyphs(), { text: imeText, missing: '' })
    const imeCaptured = await session.call('select')
    assert.equal(imeCaptured.target.address, 'A3')
    assert.equal(imeCaptured.content, imeText)
    await session.call('stage', { id: 'freeze', operation: { kind: 'excel', action: 'freezeTopRow', sheet: '汇总' } })
    assert.deepEqual((await session.call('approve', 'freeze')).verification, { matched: true, freeze: [1, 0] })
    await session.call('stage', { id: 'chart', operation: {
      kind: 'excel', action: 'insertChart', sheet: '财务明细', address: 'B1:D1', chartType: 'column', at: 'H4', title: '复核数据',
    } })
    const chart = await session.call('approve', 'chart')
    assert.equal(chart.verification?.matched, true, JSON.stringify(chart))
    assert.equal(chart.verification.chart.at, 'H4')
    await session.call('stage', { id: 'format', operation: {
      kind: 'excel', action: 'numberFormat', sheet: '财务明细', address: 'B1:C1', code: '0.000',
    } })
    const format = await session.call('approve', 'format')
    assert.deepEqual(format.verification, { matched: true, numberFormat: '0.000' }, JSON.stringify(format))

    const output = join(__dirname, '../out/tests')
    mkdirSync(output, { recursive: true })
    await session.shot(join(output, 'office-craft-excel-chinese.png'))
    saved = await session.call('save')
    const written = xlsx.read(saved)
    assert.deepEqual(written.SheetNames, ['财务明细', '汇总'])
    assert.equal(written.Sheets['财务明细'].A3.v, imeText)
    assert.equal(written.Sheets['财务明细'].B2.v, '=保留为文本')
    assert.equal(written.Sheets['财务明细'].D1.f, 'B1+7')
    assert.equal(written.Sheets['财务明细'].E1.f, '2+3')
    assert.equal(written.Sheets['财务明细'].F1.t, 's')
    assert.equal(written.Sheets['汇总'].A1.v, '另一个工作表')
  } finally {
    await session.close()
  }

  const reopened = await open('excel', filename, saved)
  try {
    const result = await reopened.page(async () => {
      const api = window.gridcraft
      return {
        book: await api.docInspect(),
        a1: await api.request('cell.get', { cell: 'A1' }),
        a3: await api.request('cell.get', { cell: 'A3' }),
        b1: await api.request('cell.get', { cell: 'B1' }),
        d1: await api.request('cell.get', { cell: 'D1' })
      }
    })
    assert.equal(result.book.dirty, false)
    assert.deepEqual(result.book.undo, [])
    assert.equal(result.a1.value, rewritten)
    assert.equal(result.a3.value, imeText)
    assert.equal(result.d1.formula, baselineD1.formula)
    assert.equal(result.b1.text, '4.000')
    assert.deepEqual(result.d1.style, baselineD1.style)
    assert.equal(result.book.sheets[0].charts[0].title, '复核数据')
    assert.deepEqual(result.book.sheets[1].freeze, [1, 0])
  } finally {
    await reopened.close()
  }
}
