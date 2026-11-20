const JSZip = require('jszip')
const pptxgen = require('pptxgenjs')
const { nativeImage } = require('electron')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

const original = '前言：季度总结；复核：季度总结。'
const rewritten = '前言：阶段成果；复核：季度总结。'
const prepared = '季度汇报.pptx'

async function presentation() {
  const deck = new pptxgen()
  deck.layout = 'LAYOUT_WIDE'
  const slide = deck.addSlide()
  slide.addNotes('演讲者备注：复核生产统计。')
  slide.addText([
    { text: '前言：', options: { bold: true, color: 'BA2200' } },
    { text: '季度总结', options: { color: '1155BB' } },
    { text: '；复核：季度总结。', options: { italic: true, color: '008822' } }
  ], { x: 0.6, y: 0.8, w: 10.5, h: 0.7, fontFace: 'Calibri', fontSize: 28, margin: 0 })
  slide.addChart(deck.ChartType.bar, [
    { name: '产量', labels: ['第一季度', '第二季度'], values: [7, 12] }
  ], { x: 1, y: 2, w: 6, h: 3, title: '生产统计', showTitle: true })
  for (const character of ['人', '國']) {
    deck.addSlide().addText(character, {
      x: 1, y: 1, w: 2, h: 2, fontFace: 'Calibri', fontSize: 64, color: '000000', margin: 0
    })
  }
  deck.addSlide().addTable([['投入', '产量'], ['车间一', '12']], { x: 1, y: 1, w: 5 })
  return deck.write({ outputType: 'nodebuffer' })
}

function glyphMask(png) {
  const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
  const bitmap = image.toBitmap()
  const { width, height } = image.getSize()
  let dark = 0
  for (let offset = 0; offset < width * height * 4; offset += 4) {
    if (bitmap[offset + 3] > 180 && Math.max(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]) < 100) dark++
  }
  return dark
}

async function waitForText(session, shape, expected, assert) {
  let actual
  for (let attempt = 0; attempt < 30; attempt++) {
    actual = await session.page(async id => (await deckcraft.execute('text.get', { id })).text, shape)
    if (actual === expected) return
    await new Promise(resolve => setTimeout(resolve, 35))
  }
  const events = await session.page(() => window.textInputEvents)
  assert.equal(actual, expected, 'Composition events: ' + JSON.stringify(events))
}

async function enterTextEditor(session, shape, assert) {
  await session.focus()
  const point = await session.page(async () => {
    await deckcraft.execute('text.exit', {})
    const { slideRect, canvasScale } = await deckcraft.uiInspect()
    const canvas = document.querySelector('canvas').getBoundingClientRect()
    let x = canvas.left + slideRect[0] + 74 * canvasScale
    let y = canvas.top + slideRect[1] + 83 * canvasScale
    for (let frame = window; frame !== frame.top; frame = frame.parent) {
      const offset = frame.frameElement.getBoundingClientRect()
      x += offset.left
      y += offset.top
    }
    return { x, y }
  })
  for (const clickCount of [1, 2]) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.cdp('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount })
    }
  }
  let active
  for (let attempt = 0; attempt < 20; attempt++) {
    active = await session.page(async () => ({
      shape: (await deckcraft.docInspect()).selection.text?.shape,
      input: document.hasFocus() && document.activeElement?.matches('input[type="text"]')
    }))
    if (active.shape === shape && active.input) break
    await new Promise(resolve => setTimeout(resolve, 35))
  }
  assert.deepEqual(active, { shape, input: true }, 'Double-clicking the slide activated its native text input')
}

async function waitForCompositionEvents(session, type, expected, assert) {
  let events
  let matching
  for (let attempt = 0; attempt < 25; attempt++) {
    events = await session.page(() => window.textInputEvents)
    matching = events.filter(event => event.type === type).map(event => event.data)
    if (matching.length >= expected.length) break
    await new Promise(resolve => setTimeout(resolve, 35))
  }
  assert.deepEqual(matching, expected, 'Composition events: ' + JSON.stringify(events))
}

module.exports = async ({ open, assert }) => {
  const source = await presentation()
  const session = await open('ppt', prepared, source)
  try {
    const outline = await session.call('document', { action: 'inspect', limit: 1 })
    assert.equal(outline.total, 4)
    assert.equal(outline.nextOffset, 1)
    const secondSlide = await session.call('document', { action: 'read', target: { kind: 'ppt', slideIndex: 1 } })
    const textBox = secondSlide.items.find(shape => shape.preview === '人')
    assert.ok(textBox)
    const search = await session.call('document', { action: 'find', query: '人' })
    assert.equal(search.items[0].slideIndex, 1)
    assert.equal(search.items[0].shapeId, textBox.shapeId)
    const tableSlide = await session.call('document', { action: 'read', target: { kind: 'ppt', slideIndex: 3 } })
    const table = tableSlide.items.find(shape => shape.type === 'table')
    assert.deepEqual((await session.call('document', { action: 'read', target: { kind: 'ppt', slideIndex: 3, shapeId: table.shapeId } })).items, [['投入', '产量'], ['车间一', '12']])
    assert.match((await session.call('document', { action: 'read', target: { kind: 'ppt', slideIndex: 0, notes: true } })).text, /复核生产统计/)
    assert.equal((await session.page(() => deckcraft.docInspect())).selection.slide, 0)
    const [simple, complex] = await session.page(async () => {
      const simple = await deckcraft.request('ui.render', { slide: 1 })
      const complex = await deckcraft.request('ui.render', { slide: 2 })
      return [simple.png, complex.png]
    })
    const simpleInk = glyphMask(simple)
    const complexInk = glyphMask(complex)
    assert.ok(simpleInk > 100, 'Visible ink for 人')
    assert.ok(complexInk > simpleInk * 1.5, '國 has more ink than 人 at the same font size')

    const matches = await session.page(() => deckcraft.execute('text.find', { text: '季度总结' }))
    assert.equal(matches.length, 2)
    const [first, second] = matches
    const select = match => session.page(async ({ shape, para, start, end }) => {
      await deckcraft.execute('text.edit', { id: shape, at: [para, start] })
      await deckcraft.execute('text.select', { anchor: [para, start], caret: [para, end] })
    }, match)
    await enterTextEditor(session, first.shape, assert)
    await session.page(({ para, start, end }) => deckcraft.execute('text.select', {
      anchor: [para, start], caret: [para, end]
    }), first)
    const compose = text => session.cdp('Input.imeSetComposition', {
      text, selectionStart: text.length, selectionEnd: text.length
    })
    await session.page(() => {
      window.textInputEvents = []
      for (const type of ['focusout', 'focusin', 'compositionstart', 'compositionupdate', 'beforeinput', 'input', 'compositionend']) {
        window.addEventListener(type, event => {
          if (event.isTrusted && event.target.matches('input[type="text"]')) {
            window.textInputEvents.push({ type, data: event.data, value: event.target.value, inputType: event.inputType })
          }
        }, true)
      }
    })
    await compose('zhongwen')
    await waitForCompositionEvents(session, 'compositionupdate', ['zhongwen'], assert)
    await waitForText(session, first.shape, original, assert)
    await compose('')
    await waitForCompositionEvents(session, 'compositionupdate', ['zhongwen', ''], assert)
    await waitForText(session, first.shape, original, assert)
    await compose('输入法验收')
    await waitForText(session, first.shape, original, assert)
    await session.cdp('Input.insertText', { text: '输入法验收' })
    await waitForText(session, first.shape, '前言：输入法验收；复核：季度总结。', assert)
    await compose('通过')
    await waitForText(session, first.shape, '前言：输入法验收；复核：季度总结。', assert)
    await session.cdp('Input.insertText', { text: '通过' })
    await waitForText(session, first.shape, '前言：输入法验收通过；复核：季度总结。', assert)
    const folder = join(__dirname, '../out/tests')
    mkdirSync(folder, { recursive: true })
    await session.shot(join(folder, 'office-craft-ppt-chinese.png'))
    await session.page(() => deckcraft.execute('edit.undo', {}))
    await waitForText(session, first.shape, '前言：输入法验收；复核：季度总结。', assert)
    await session.page(() => deckcraft.execute('edit.undo', {}))
    await waitForText(session, first.shape, original, assert)

    await select(first)
    const captured = await session.call('select')
    assert.equal(captured.content, '季度总结')
    await select(second)
    await assert.rejects(session.call('apply', { captured, proposal: { text: '提前批准' } }), /选区/)
    await waitForText(session, first.shape, original, assert)

    await select(first)
    const current = await session.call('select')
    await session.call('apply', { captured: current, proposal: { text: '阶段成果' } })
    await waitForText(session, first.shape, rewritten, assert)
    await session.call('undo')
    await waitForText(session, first.shape, original, assert)
    await session.call('redo')
    await waitForText(session, first.shape, rewritten, assert)

    const saved = Buffer.from(await session.call('save'))
    const zip = await JSZip.loadAsync(saved)
    const slide = await zip.file('ppt/slides/slide1.xml').async('string')
    for (const [text, color] of [['前言：', 'BA2200'], ['阶段成果', '1155BB'], ['；复核：季度总结。', '008822']]) {
      const runs = [...slide.matchAll(/<a:r>[\s\S]*?<\/a:r>/g)]
      const run = runs.find(([xml]) => xml.includes('<a:t>' + text + '</a:t>'))
      assert.ok(run?.[0].toUpperCase().includes(color), 'Preserved run color for ' + text)
      if (color === 'BA2200') assert.match(run[0], /\bb="1"/)
      if (color === '008822') assert.match(run[0], /\bi="1"/)
    }
    const chartPart = Object.keys(zip.files).find(name => /^ppt\/charts\/[^/]+\.xml$/.test(name))
    assert.ok(chartPart, 'Saved as an editable OOXML chart')
    const chart = await zip.file(chartPart).async('string')
    for (const value of ['产量', '第一季度', '第二季度', '7', '12']) {
      assert.ok(chart.includes('<c:v>' + value + '</c:v>'), 'Preserved chart value ' + value)
    }
    const originalZip = await JSZip.loadAsync(source)
    const workbookPath = Object.keys(originalZip.files).find(name => /^ppt\/embeddings\/[^/]+\.xlsx$/.test(name))
    const relationshipId = /<c:externalData r:id="([^"]+)"/.exec(chart)?.[1]
    assert.ok(workbookPath && relationshipId, 'Chart retains the embedded workbook relationship')
    const relationships = await zip.file('ppt/charts/_rels/' + chartPart.split('/').pop() + '.rels').async('string')
    const workbookTarget = [...relationships.matchAll(/<Relationship\b[^>]*>/g)]
      .find(([entry]) => entry.includes('Id="' + relationshipId + '"'))?.[0]
      .match(/Target="\.\.\/(embeddings\/[^"]+)"/)?.[1]
    assert.ok(workbookTarget, 'Chart relationship resolves to a workbook part')
    assert.deepEqual(
      await zip.file('ppt/' + workbookTarget).async('nodebuffer'),
      await originalZip.file(workbookPath).async('nodebuffer')
    )

    const reopened = await open('ppt', prepared, saved)
    try {
      const found = await reopened.page(() => deckcraft.execute('text.find', { text: '阶段成果' }))
      assert.equal(found.length, 1)
      assert.equal(found[0].slide, 0)
      await waitForText(reopened, found[0].shape, rewritten, assert)
      const otherSlide = { kind: 'ppt', slideIndex: 1 }
      const { items } = await reopened.call('document', { action: 'read', target: otherSlide })
      const target = { ...otherSlide, shapeId: items.find(shape => shape.preview === '人').shapeId }
      const targeted = await reopened.call('select', { target: { ...target, text: '人' } })
      assert.equal(targeted.content, '人')
      assert.equal(targeted.target.slideIndex, 1)
      await reopened.call('apply', { captured: targeted, proposal: { text: '大' } })
      assert.equal((await reopened.call('document', { action: 'read', target })).text, '大')
    } finally {
      await reopened.close()
    }
    console.log('DeckCraft 中文字形、输入法、精确选区改写、撤销、PPTX 样式、图表和重新打开通过')
  } finally {
    await session.close()
  }
}
