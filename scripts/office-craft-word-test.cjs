const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell } = require('docx')
const JSZip = require('jszip')

const prefix = '原文：'
const original = '这段文字需要改写'
const suffix = '。请保留末尾。'
const rewrite = '已经更新这段中文'
const untouched = '邻近段落须原样保留。'
const imeAnchor = '输入占位'
const imeCommit = '中文输入成功'
const filename = '中文改写验收.docx'

async function fixture() {
  return Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph({ children: [
          new TextRun(prefix),
          new TextRun({ text: original, bold: true, color: 'AA3300' }),
          new TextRun(suffix),
        ] }),
        new Paragraph(untouched),
        new Paragraph(imeAnchor),
        new Table({ rows: [['事项', '状态'], ['采购凭据', '待复核']].map(row => new TableRow({
          children: row.map(text => new TableCell({ children: [new Paragraph(text)] }))
        })) }),
      ],
    }],
  }))
}

module.exports = async function testWord({ open, assert }) {
  const session = await open('word', filename, await fixture())
  const inspect = () => session.page(() => window.wordcraft.docInspect({ text: true }))
  const select = text => session.page(value => window.wordcraft.execute('select.text', { text: value }), text)
  let saved
  try {
    const baseline = await inspect()
    assert.equal(baseline.blocks[0].text, prefix + original + suffix)
    const outline = await session.call('document', { action: 'inspect', limit: 1 })
    assert.equal(outline.items[0].preview, prefix + original + suffix)
    assert.equal(outline.nextOffset, 1)
    const found = await session.call('document', { action: 'find', query: untouched })
    assert.equal(found.items[0].blockIndex, 1)
    assert.equal((await session.call('document', { action: 'read', target: { kind: 'word', blockIndex: 1 } })).text, untouched)
    const tableHit = (await session.call('document', { action: 'find', query: '采购凭据' })).items[0]
    assert.deepEqual([tableHit.blockIndex, tableHit.row, tableHit.column], [3, 1, 0])
    assert.deepEqual((await session.call('document', { action: 'read', target: { kind: 'word', blockIndex: 3 }, offset: 1 })).items, [['采购凭据', '待复核']])
    const glyphs = await session.page(() => window.wordcraft.execute('file.strictReport', {}))
    assert.equal(glyphs.total_missing_glyphs, 0, JSON.stringify(glyphs))

    await select(original)
    const captured = await session.call('select')
    assert.equal(captured.editable, true, captured.reason)
    assert.equal(captured.content, original)
    assert.equal(captured.target.offset, prefix.length)
    await select(untouched)
    await assert.rejects(session.call('apply', { captured, proposal: { text: rewrite } }), /选区已变化/u)
    assert.deepEqual((await inspect()).blocks, baseline.blocks)

    await assert.rejects(session.call('select', { target: { kind: 'word', blockIndex: 0, text: '原文已过期' } }), /原文已变化/)
    const fresh = await session.call('select', { target: { kind: 'word', blockIndex: 0, text: original } })
    assert.equal(fresh.content, original)
    await session.call('apply', { captured: fresh, proposal: { text: rewrite } })
    const changed = await inspect()
    assert.equal(changed.blocks[0].text, prefix + rewrite + suffix)
    assert.equal((await session.call('document', { action: 'read', target: { kind: 'word', blockIndex: 0 } })).text, prefix + rewrite + suffix)
    assert.deepEqual(changed.blocks[0].runs[0].props, baseline.blocks[0].runs[0].props)
    assert.equal(changed.blocks[1].text, untouched)

    await session.call('undo')
    assert.deepEqual((await inspect()).blocks, baseline.blocks)
    await session.call('redo')
    assert.deepEqual((await inspect()).blocks, changed.blocks)

    // A visible focused window lets Chromium send input through the native IME path.
    await session.focus?.()
    // Click the real document so eframe activates its own text input agent.
    await select(imeAnchor)
    const point = await session.page(async () => {
      const { caret } = await window.wordcraft.uiInspect()
      const canvas = document.querySelector('canvas').getBoundingClientRect()
      let x = canvas.left + caret.x
      let y = canvas.top + caret.y + caret.h / 2
      for (let view = window; view.frameElement; view = view.parent) {
        const frame = view.frameElement.getBoundingClientRect()
        x += frame.left
        y += frame.top
      }
      return [x, y]
    })
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.cdp('Input.dispatchMouseEvent', { type, x: point[0], y: point[1], button: 'left', clickCount: 1 })
    }
    assert.equal(await session.page(() => document.activeElement?.matches('input[type=text]')), true)
    await select(imeAnchor)
    await session.cdp('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 })
    assert.equal((await inspect()).blocks[2].text, imeAnchor)
    await session.cdp('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    assert.equal((await inspect()).blocks[2].text, imeAnchor)
    await session.cdp('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 })
    assert.equal((await inspect()).blocks[2].text, imeAnchor)
    await session.cdp('Input.insertText', { text: imeCommit })
    let input = (await inspect()).blocks[2].text
    const until = Date.now() + 2000
    while (input === imeAnchor && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 25))
      input = (await inspect()).blocks[2].text
    }
    assert.equal(input, imeCommit)
    await session.call('undo')
    assert.equal((await inspect()).blocks[2].text, imeAnchor)
    await session.call('redo')
    assert.equal((await inspect()).blocks[2].text, imeCommit)
    const afterInput = await session.page(() => window.wordcraft.execute('file.strictReport', {}))
    assert.equal(afterInput.total_missing_glyphs, 0, JSON.stringify(afterInput))

    const evidence = join(__dirname, '../out/tests')
    mkdirSync(evidence, { recursive: true })
    await session.shot(join(evidence, 'office-craft-word-chinese.png'))
    saved = await session.call('save')
    const xml = await (await JSZip.loadAsync(saved)).file('word/document.xml').async('string')
    assert.ok(xml.includes(rewrite))
    assert.ok(xml.includes(imeCommit))
    assert.ok(xml.includes(untouched))
    assert.ok(xml.includes('AA3300'))
    assert.ok(!xml.includes(original))
  } finally {
    await session.close()
  }

  const reopened = await open('word', filename, saved)
  try {
    const doc = await reopened.page(() => window.wordcraft.docInspect({ text: true }))
    assert.deepEqual(doc.blocks.map(block => block.type), ['paragraph', 'paragraph', 'paragraph', 'table', 'paragraph'])
    assert.deepEqual(doc.blocks.filter(block => block.type === 'paragraph').map(block => block.text), [prefix + rewrite + suffix, untouched, imeCommit, ''])
    assert.deepEqual(doc.blocks[3].cells, [['事项', '状态'], ['采购凭据', '待复核']])
    assert.equal(doc.blocks[0].runs[0].props.bold, true)
    assert.equal(doc.canUndo, false)
  } finally {
    await reopened.close()
  }

  const reference = await open('word', filename, saved, true)
  try {
    await reference.page(text => window.wordcraft.execute('select.text', { text }), rewrite)
    const selection = await reference.call('select')
    assert.equal(selection.content, rewrite)
    assert.equal(selection.editable, false)
    await assert.rejects(reference.call('save'), /只读/u)
    await assert.rejects(reference.page(() => window.wordcraft.execute('text.insert', { text: '忽略' })), /protected/u)
    const doc = await reference.page(() => window.wordcraft.docInspect({ text: true }))
    assert.equal(doc.blocks[0].text, prefix + rewrite + suffix)
  } finally {
    await reference.close()
  }
}
