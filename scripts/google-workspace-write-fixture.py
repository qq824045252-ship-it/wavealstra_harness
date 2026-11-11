"""Local-only fake gws SDK/CLI. No HTTP library, credentials or external writes."""
import sys, os, json, base64, email, email.header, time
from pathlib import Path
ROOT=Path(__file__).parent
STATE=ROOT/'fixture-state.json'
AUDIT=ROOT/'fixture-audit.jsonl'
class Failure(Exception):
    def __init__(self,status):
        self.resp=type('Response',(),{'status':status})(); super().__init__('synthetic error')
def read_state(): return json.loads(STATE.read_text())
def save_state(value): STATE.write_text(json.dumps(value,ensure_ascii=False))
def audit(action,args):
    with AUDIT.open('a') as f: f.write(json.dumps({'action':action,'args':args},ensure_ascii=False)+'\n')
class Request:
    def __init__(self,action,args): self.action=action; self.args=args; self.headers={}
    def execute(self,num_retries=0):
        assert num_retries==0
        audit(self.action,self.args)
        s=read_state(); a=self.args
        if self.action=='profile': return {'emailAddress':'owner@example.test'}
        if self.action=='send':
            m=email.message_from_bytes(base64.urlsafe_b64decode(a['body']['raw']))
            item={'id':'sent'+str(len(s['sent'])+1),'threadId':'thread1','to':m['To'],'cc':m['Cc'],'subject':str(email.header.decode_header(m['Subject'])[0][0]) if False else str(email.header.make_header(email.header.decode_header(m['Subject']))),'body':m.get_payload(decode=True).decode(m.get_content_charset() or 'utf-8'),'messageId':m['Message-ID'],'from':m['From']}
            s['sent'].append(item);save_state(s)
            if (ROOT/'unknown-outcome').exists(): os._exit(27)
            return {'id':item['id'],'threadId':item['threadId']}
        if self.action=='get':
            if a['eventId'] not in s['events']: raise Failure(404)
            return s['events'][a['eventId']]
        if self.action=='insert':
            item=dict(a['body'],id='created'+str(len(s['events'])+1),etag='"v1"',htmlLink='https://calendar.google.com/calendar/event?eid=fixture')
            s['events'][item['id']]=item;save_state(s);return item
        if self.action=='patch':
            item=s['events'].get(a['eventId'])
            if not item: raise Failure(404)
            if self.headers.get('If-Match')!=item['etag'] or (ROOT/'conflict').exists(): raise Failure(412)
            item.update(a['body']);item['etag']='"v2"';save_state(s);return item
        raise Failure(400)
class Service:
    def users(self): return self
    def messages(self): return self
    def events(self): return self
    def getProfile(self,**kw): return Request('profile',kw)
    def send(self,**kw): return Request('send',kw)
    def get(self,**kw): return Request('get',kw)
    def insert(self,**kw): return Request('insert',kw)
    def patch(self,**kw): return Request('patch',kw)
def svc(name,version):
    assert (ROOT/'isolated-fixture-marker').exists()
    assert name in ['gmail','calendar']
    return Service()
def cli():
    args=sys.argv[1:];s=read_state()
    if args==['--help']: print('Google Workspace CLI cal gmail'); return
    if args[:2]==['gmail','search']:
        if '--json' in args: print(json.dumps([{'id':'mail731'}]));return
        print('约 1 条匹配，显示前 1 条：\n- Wed, 11 Nov 2026 09:00:00 +0800\n  发件: Alice <alice@example.test>\n  主题: 合同确认 CONTRACT_731\n  id=mail731  (未读)');return
    if args[:2]==['gmail','read']:
        print('发件: Alice <alice@example.test> | 日期: 2026-11-11\n主题: 合同确认 CONTRACT_731\n'+'-'*40+'\n请在星期五前核对合同，预算为731元。正文标记 BODY_731。');return
    if args[:2]==['cal','agenda']:
        print(json.dumps(list(s['events'].values()),ensure_ascii=False));return
    raise RuntimeError('unsupported fixture command')
if __name__=='__main__': cli()
