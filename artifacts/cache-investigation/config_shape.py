import json, os, hashlib
from pathlib import Path
base=Path(os.environ['USERPROFILE'])/'.config'/'magpie'
p=json.loads((base/'providers.json').read_text(encoding='utf-8'))
rows=p.get('providers',[])
if isinstance(rows,dict): rows=[dict(v,id=k) for k,v in rows.items()]
for r in rows:
    if r.get('id')=='codex':
        print(json.dumps({k:r[k] for k in ['id','routing','switchOnly','models','extraBody','headers'] if k in r and k not in ['headers','extraBody']},ensure_ascii=False))
        print('extraBody_fields',list(r.get('extraBody',{})))
        print('header_names',list(r.get('headers',{})))
