/** Fixed source embedded by electron-vite; no checkout-relative Python assets. */
export const GOOGLE_WORKSPACE_BRIDGE = String.raw`
import sys,json,base64,importlib.util,contextlib,io,datetime,re,hashlib
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formatdate
started=False
class Invalid(Exception): pass
class Conflict(Exception): pass
def require(ok):
    if not ok: raise Invalid()
def event_data(e,calendar):
    require(isinstance(e,dict) and isinstance(e.get('id'),str) and 0<len(e['id'])<=256 and isinstance(e.get('etag'),str) and 0<len(e['etag'])<=256)
    start=e.get('start',{}); end=e.get('end',{}); day='date' in start
    times({},dict(start=start.get('date' if day else 'dateTime'),end=end.get('date' if day else 'dateTime'),allDay=day))
    link=e.get('htmlLink'); link=link if isinstance(link,str) and re.match(r'https://(?:calendar\.google\.com|www\.google\.com)/',link) else None
    return dict(id=e['id'],etag=e['etag'],calendar=calendar,title=e.get('summary','(无标题)'),start=start.get('date' if day else 'dateTime',''),end=end.get('date' if day else 'dateTime',''),allDay=day,description=e.get('description',''),location=e.get('location',''),timeZone=start.get('timeZone'),attendees=[a['email'] for a in e.get('attendees',[]) if 'email' in a],htmlLink=link)
def times(body,r,current=None):
    current=current or {}
    if not any(k in r for k in ['start','end','allDay','timeZone']): return
    day=r.get('allDay','date' in current.get('start',{})); key='date' if day else 'dateTime'
    start=r.get('start',current.get('start',{}).get(key)); end=r.get('end',current.get('end',{}).get(key))
    require(isinstance(start,str) and isinstance(end,str))
    if day:
        require(re.fullmatch(r'\d{4}-\d{2}-\d{2}',start) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',end))
        a=datetime.date.fromisoformat(start); b=datetime.date.fromisoformat(end)
    else:
        pattern=r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})'
        require(re.fullmatch(pattern,start) and re.fullmatch(pattern,end))
        a=datetime.datetime.fromisoformat(start.replace('Z','+00:00')); b=datetime.datetime.fromisoformat(end.replace('Z','+00:00'))
    require(b>a); body['start']={key:start}; body['end']={key:end}
    if current and day != ('date' in current.get('start',{})):
        for boundary in ['start','end']:
            body[boundary]['dateTime' if day else 'date']=None
            if day: body[boundary]['timeZone']=None
    zone=r.get('timeZone',current.get('start',{}).get('timeZone'))
    if zone and not day:
        from zoneinfo import ZoneInfo
        ZoneInfo(zone); body['start']['timeZone']=zone; body['end']['timeZone']=zone
def main():
    global started
    payload=json.loads(sys.stdin.read(262145)); action=payload['action']; r=payload['request']
    require(action in ['sendMail','createEvent','updateEvent','getEvent'])
    spec=importlib.util.spec_from_file_location('mybuddy_existing_gws',sys.argv[1]); gws=importlib.util.module_from_spec(spec); spec.loader.exec_module(gws)
    if action=='sendMail':
        service=gws.svc('gmail','v1')
        sender=service.users().getProfile(userId='me').execute(num_retries=0).get('emailAddress')
        require(isinstance(sender,str) and re.fullmatch(r'[^\s<>\r\n]+@[^\s<>\r\n]+',sender))
        m=EmailMessage(policy=SMTP); m['To']=', '.join(r['to'])
        m['From']=sender; m['Date']=formatdate(localtime=False)
        m['Message-ID']='<'+hashlib.sha256(r['operationId'].encode()).hexdigest()+'@mybuddy.local>'
        if r.get('cc'): m['Cc']=', '.join(r['cc'])
        m['Subject']=r['subject']; m.set_content(r['body'])
        raw=base64.urlsafe_b64encode(m.as_bytes()).decode('ascii')
        command=service.users().messages().send(userId='me',body={'raw':raw})
        started=True; result=command.execute(num_retries=0); require(isinstance(result.get('id'),str))
        return dict(id=result['id'],threadId=result.get('threadId'),operationId=r['operationId'])
    calendar=r.get('calendar','primary'); events=gws.svc('calendar','v3').events()
    if action=='getEvent': return event_data(events.get(calendarId=calendar,eventId=r['id']).execute(num_retries=0),calendar)
    current={}
    if action=='updateEvent':
        current=events.get(calendarId=calendar,eventId=r['id']).execute(num_retries=0)
        if current.get('etag')!=r['etag']: raise Conflict()
        require(not current.get('recurrence') and not current.get('recurringEventId'))
    require(not (current.get('attendees') or r.get('attendees')) or r.get('notifyAttendees') is True)
    body={}
    for source,target in [('title','summary'),('description','description'),('location','location')]:
        if source in r: body[target]=r[source]
    times(body,r,current)
    if 'attendees' in r:
        previous={a.get('email','').lower():a for a in current.get('attendees',[])}
        safe=['displayName','optional','resource','responseStatus','comment','additionalGuests']
        body['attendees']=[dict({k:v for k,v in previous.get(email.lower(),{}).items() if k in safe},email=email) for email in r['attendees']]
    updates='all' if r.get('notifyAttendees') is True else 'none'
    if action=='createEvent': command=events.insert(calendarId=calendar,body=body,sendUpdates=updates)
    else:
        command=events.patch(calendarId=calendar,eventId=r['id'],body=body,sendUpdates=updates); command.headers['If-Match']=r['etag']
    started=True; result=command.execute(num_retries=0)
    answer=event_data(result,calendar); answer['operationId']=r['operationId']; return answer
try:
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()): result=main()
    print(json.dumps({'ok':True,'data':result}))
except BaseException as e:
    status=getattr(getattr(e,'resp',None),'status',None)
    code='service_error'; outcome='unknown' if started else 'not_started'
    if isinstance(e,Conflict) or status==412: code='conflict'; outcome='failed'
    elif isinstance(e,(Invalid,ValueError,KeyError)): code='invalid_response' if started else 'invalid_request'
    elif status==401: code='auth_required'; outcome='failed'
    elif status==403: code='permission_denied'; outcome='failed'
    elif type(e).__name__ in ['RefreshError','DefaultCredentialsError']: code='auth_required'; outcome='not_started' if not started else 'unknown'
    elif isinstance(e,(ImportError,AttributeError)) and not started: code='unsupported_cli'; outcome='not_started'
    elif status in [400,404,409,422]: outcome='failed'
    print(json.dumps({'ok':False,'error':{'code':code,'outcome':outcome}}))
`;
