import pathlib,json,hashlib,sys
base=pathlib.Path(__file__).parent
m=json.loads((base/'source-manifest.json').read_text()); root=pathlib.Path(m['root']);bad=[]
for row in m['files']:
 p=root/row['path']
 if not p.is_file() or p.stat().st_size!=row['size'] or hashlib.sha256(p.read_bytes()).hexdigest()!=row['sha256']:bad.append(row['path'])
h=base/'instrumentation-manifest.json'
if h.exists():
 for row in json.loads(h.read_text())['files']:
  p=pathlib.Path(row['path'])
  if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=row['sha256']:bad.append(row['path'])
print(json.dumps({'checkedSourceFiles':len(m['files']),'mismatches':bad}))
sys.exit(bool(bad))
