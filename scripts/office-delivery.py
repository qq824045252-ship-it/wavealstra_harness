#!/usr/bin/env python3
"""Disk-only Office acceptance. Never reads an officecli resident or preview cache.
Usage: office-delivery.py FILE EXPECTATIONS.json REPORT.json [--close] [--render DIR]
Expectation keys: texts, pages, cells {Sheet!A1: value}, template (original PPTX).
"""
import argparse, hashlib, json, re, subprocess, shutil, zipfile
from pathlib import Path
import xml.etree.ElementTree as ET


def inspect(path, expected):
    errors, unverified = [], []
    facts = {}
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        xml = {n: ET.fromstring(z.read(n)) for n in names if n.endswith('.xml') and n.startswith(('word/', 'xl/', 'ppt/'))}
        text = '\n'.join(t.text or '' for root in xml.values() for t in root.iter() if t.tag.rsplit('}', 1)[-1] in ('t', 'v'))
        for needle in expected.get('texts', []):
            if needle not in text: errors.append('missing text: ' + needle)
        if path.suffix == '.xlsx':
            import openpyxl
            formulas = openpyxl.load_workbook(path, data_only=False)
            cached = openpyxl.load_workbook(path, data_only=True)
            checked = {}
            # A deliberately small independent formula set; everything else stays unverified.
            def value(sheet, address, visiting=()):
                if address in visiting: raise ValueError('cyclic formula')
                v = formulas[sheet][address].value
                if not isinstance(v, str) or not v.startswith('='): return v
                expression = v[1:].upper()
                if re.fullmatch(r'SUM\([A-Z]+[0-9]+:[A-Z]+[0-9]+\)', expression):
                    from openpyxl.utils.cell import range_boundaries
                    lo, row, hi, end = range_boundaries(expression[4:-1])
                    from openpyxl.utils import get_column_letter
                    return sum(value(sheet, f'{get_column_letter(col)}{r}', visiting + (address,)) or 0 for r in range(row, end + 1) for col in range(lo, hi + 1))
                if re.fullmatch(r'[A-Z]+[0-9]+\+[A-Z]+[0-9]+', expression):
                    a, b = expression.split('+'); return value(sheet, a, visiting + (address,)) + value(sheet, b, visiting + (address,))
                raise ValueError('unsupported formula ' + v)
            for key, target in expected.get('cells', {}).items():
                sheet, address = key.rsplit('!', 1)
                try:
                    actual = value(sheet, address)
                    cache = cached[sheet][address].value
                    checked[key] = {'recomputed': actual, 'cached': cache, 'expected': target}
                    if actual != target: errors.append('wrong cell: ' + key)
                    if formulas[sheet][address].data_type == 'f' and cache != actual: errors.append('stale/missing formula cache: ' + key)
                except ValueError as e: unverified.append(key + ': ' + str(e))
            facts['cells'] = checked
            unverified.append('Only requested cells; independent formulas: SUM(range), cell+cell. Other formulas not recalculated.')
        elif path.suffix == '.pptx':
            slides = [n for n in names if re.fullmatch(r'ppt/slides/slide\d+.xml', n)]
            facts['pages'] = len(slides)
            ns = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main', 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
            size = xml['ppt/presentation.xml'].find('p:sldSz', ns)
            width, height = int(size.attrib['cx']), int(size.attrib['cy'])
            for n in slides:
                for xfrm in xml[n].findall('.//a:xfrm', ns):
                    off, ext = xfrm.find('a:off', ns), xfrm.find('a:ext', ns)
                    if off is not None and ext is not None:
                        x, y, w, h = (int(off.attrib['x']), int(off.attrib['y']), int(ext.attrib['cx']), int(ext.attrib['cy']))
                        if x < 0 or y < 0 or x+w > width or y+h > height: errors.append('object outside slide: ' + n)
            if expected.get('template'):
                with zipfile.ZipFile(expected['template']) as original:
                    for n in original.namelist():
                        if n.startswith(('ppt/slideMasters/', 'ppt/slideLayouts/', 'ppt/theme/')) and not n.endswith('/'):
                            if n not in names or z.read(n) != original.read(n): errors.append('template changed: ' + n)
            unverified.append('Text overflow inside shapes and visual fidelity require review of every rendered page.')
        elif path.suffix == '.docx':
            facts['paragraphs'] = sum(1 for t in xml['word/document.xml'].iter() if t.tag.endswith('}p'))
            unverified.append('DOCX layout/target format requires rendered review.')
        else: raise ValueError('Only DOCX/XLSX/PPTX supported')
        if 'pages' in expected and expected['pages'] != facts.get('pages'): errors.append('page count mismatch')
    return facts, errors, unverified


def main():
    p = argparse.ArgumentParser(__doc__)
    p.add_argument('file', type=Path); p.add_argument('expectations', type=Path); p.add_argument('report', type=Path)
    p.add_argument('--close', action='store_true', help='Flush and close officecli before any disk read')
    p.add_argument('--render', type=Path)
    args = p.parse_args()
    path = args.file.resolve()
    if args.close: subprocess.run(['officecli', 'close', str(path)], check=True, capture_output=True)
    expected = json.loads(args.expectations.read_text())
    before = path.read_bytes()
    facts, errors, unverified = inspect(path, expected)
    if not args.close: unverified.append('No save/close evidence supplied; resident changes cannot be accepted.')
    rendered = []
    if args.render:
        engine = shutil.which('libreoffice') or shutil.which('soffice')
        if engine:
            args.render.mkdir(parents=True, exist_ok=True)
            profile = (args.render / 'lo-profile').resolve().as_uri()
            result = subprocess.run([engine, '-env:UserInstallation=' + profile, '--headless', '--convert-to', 'pdf', '--outdir', str(args.render.resolve()), str(path)], capture_output=True, timeout=90)
            pdf = args.render / (path.stem + '.pdf')
            if result.returncode or not pdf.exists(): errors.append('render failed')
            else:
                rendered.append(str(pdf.resolve()))
                if shutil.which('pdftoppm'):
                    subprocess.run(['pdftoppm', '-scale-to', '1400', '-png', str(pdf), str(args.render / path.stem)], check=True, capture_output=True)
                    rendered.extend(str(f.resolve()) for f in sorted(args.render.glob(path.stem + '-*.png')))
                unverified.append('Render produced; per-page visual review not automated.')
        else: unverified.append('LibreOffice unavailable; no rendering verified.')
    else: unverified.append('Rendering not requested.')
    if before != path.read_bytes(): errors.append('file changed during validation')
    report = {'status': 'FAIL' if errors else 'PARTIAL' if unverified else 'PASS', 'path': str(path), 'sha256': hashlib.sha256(before).hexdigest(), 'mtimeNs': path.stat().st_mtime_ns, 'facts': facts, 'errors': errors, 'unverified': unverified, 'rendered': rendered, 'saveClose': args.close}
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'report': str(args.report)}))
    return 1 if errors else 0

if __name__ == '__main__': raise SystemExit(main())
