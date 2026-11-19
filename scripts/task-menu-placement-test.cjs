// Exercise the production measurement callback and placement math, not copied formulas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/src/components/sidebar/TaskItem.tsx'), 'utf8');
const start = source.indexOf('  const syncMenuPos = (): void => {');
const end = source.indexOf('\n  useLayoutEffect(', start);
assert(start >= 0 && end > start, 'production measurement callback exists');
const callback = esbuild.transformSync(source.slice(start, end), {loader: 'ts', target: 'es2022'}).code;
const placementModule = {exports: {}};
new Function('module', 'exports', esbuild.transformSync(fs.readFileSync(path.join(root, 'src/renderer/src/lib/placeFixedMenu.ts'), 'utf8'), {loader: 'ts', format: 'cjs'}).code)(placementModule, placementModule.exports);
const {placeFixedMenu} = placementModule.exports;
function measure(anchor, menu, viewport = {width: 1344, height: 821}) {
  let position;
  new Function('menuAnchorRef', 'menuPortalRef', 'layoutRect', 'layoutViewportSize', 'placeFixedMenu', 'setMenuPos', 'MENU_MIN_WIDTH', 'MENU_MAX_HEIGHT', callback + '\nsyncMenuPos();')(
    {current: anchor}, {current: menu}, value => value, () => viewport, placeFixedMenu, value => {position = value;}, 200, 420);
  return position;
}
const menu = {scrollHeight: 148, offsetHeight: 150, clientHeight: 148, offsetWidth: 200};
const low = {top: 703, bottom: 723, left: 169, right: 189};
assert.equal(measure(low, menu).top + menu.offsetHeight, low.top - 4, 'short menu opens upward exactly 4px from trigger, including borders');
const high = {top: 80, bottom: 100, left: 169, right: 189};
assert.equal(measure(high, menu).top, high.bottom + 4, 'downward placement stays attached');
const fitsBelow = {top: 610, bottom: 630, left: 169, right: 189};
assert.equal(measure(fitsBelow, menu).top, fitsBelow.bottom + 4, 'short actual height must not spuriously flip upward');
const tall = {scrollHeight: 600, offsetHeight: 300, clientHeight: 298, offsetWidth: 200};
assert.equal(measure(low, tall).maxHeight, 420, 'natural content height retains the height cap');
assert.equal(measure(low, tall).top, low.top - 4 - 420, 'clipped tall menu still attaches upward');
assert(Number.isFinite(measure(low, null).top), 'unmounted menu has safe fallback');
console.log('PASS task menu measurement and placement (6 checks)');
