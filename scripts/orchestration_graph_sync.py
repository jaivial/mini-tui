#!/usr/bin/env python3
"""Durable mini-tui task/board projection into the local Rust property graph.
SQLite is the outbox: failed writes are retried from unchanged source snapshots.
"""
import json,sqlite3,time,os,hashlib,pathlib
from neo4j import GraphDatabase
HOME=pathlib.Path.home()
DB=pathlib.Path(os.environ.get('MINITUI_DB_PATH',str(HOME/'.config/mini-tui/sessions.db')))
STATE=HOME/'.config/mini-tui/orchestration-graph-status.json'
CACHE=HOME/'.config/mini-tui/orchestration-graph-cursor.json'
URI=os.environ.get('MINITUI_GRAPH_URI','bolt://127.0.0.1:7687')

REPORT_CACHE={}

def last_report(info, messages):
 # A model-authored final report is evidence, not a judge PASS. Keep the
 # current exit/error separately so a provider failure cannot erase the report.
 try: history=json.loads(messages or "[]")
 except (ValueError,TypeError): history=[]
 for m in reversed(history):
  if not isinstance(m,dict) or m.get("role")!="assistant":continue
  extra=m.get("extra") or {}
  text=extra.get("submission") if isinstance(extra,dict) else None
  if isinstance(text,str) and text.strip():return text,"assistant_submission"
 text=info.get("submission","")
 return (text,"exit_submission") if info.get("exit_status")=="Submitted" and isinstance(text,str) and text.strip() else ("","none")

def snapshot(c):
 nodes=[];edges=[]
 def node(label,id,**props):nodes.append(dict(label=label,id='mini-tui:'+id,props=dict(source='mini-tui',**props)))
 def edge(a,b,kind):edges.append(dict(a='mini-tui:'+a,b='mini-tui:'+b,kind=kind))
 for row in c.execute('select id,parent_id,title,task,cwd,exit_status,info_json,updated_at from sessions'):
  d=dict(row);sid=d.pop('id');parent=d.pop('parent_id') or ''
  try:info=json.loads(d.pop('info_json') or '{}')
  except:info={}
  stamp=d.pop('updated_at')
  cached=REPORT_CACHE.get(sid)
  if cached is None or cached[0]!=stamp:
   messages=c.execute('select messages_json from sessions where id=?',(sid,)).fetchone()[0]
   cached=(stamp,last_report(info,messages));REPORT_CACHE[sid]=cached
  d['result'],d['result_source']=cached[1]
  d['result_exit_status']=d['exit_status']
  d['exit_submission']=str(info.get('submission',''))
  d['result_is_judge_approval']=False
  node('MiniAgent',sid,**d)
  if parent:edge(parent,sid,'DELEGATES')
 for row in c.execute('select * from session_tasks'):
  d=dict(row);sid=d.pop('session_id');tid='task:'+sid;node('MiniTask',tid,**d);edge(sid,tid,'HAS_TASK')
 for row in c.execute('select * from kanban_cards'):
  d=dict(row);cid=d.pop('id');sid=d.pop('session_id');bid='board:'+sid
  node('MiniBoard',bid,session_id=sid,parent_id=sid.rsplit('~',1)[0] if '~' in sid else '',depth=sid.count('~'))
  node('MiniCard',cid,session_id=sid,**d);edge(sid,bid,'HAS_BOARD');edge(bid,cid,'HAS_CARD')
  if d['assignee']:edge(cid,sid+'~'+d['assignee'],'ASSIGNED_TO')
 for row in c.execute('select a,b,kind from kanban_links'):edge(row[0],row[1],'RELATED_TO')
 # Work-queue tasks: one node per task (title, description, brief, result), the worker session
 # that ran it, and the task-to-task relations the queue computed (similarity, redirects).
 try:
  for row in c.execute('select id,title,description,prompt,status,session_id,result,related,cwd,updated_at from queue_tasks'):
   d=dict(row);qid='queue:'+d.pop('id');rel=d.pop('related') or '[]'
   node('MiniTask',qid,session_id=d.get('session_id',''),title=d['title'],description=d['description'],task=d['prompt'][:1800],result=d['result'],status=d['status'],project_cwd=d['cwd'],updated_at=d['updated_at'])
   if d.get('session_id'):edge(d['session_id'],qid,'HAS_TASK')
   for r in json.loads(rel):edge(qid,'queue:'+r['id'],'RELATED_TO')
 except sqlite3.OperationalError:pass
 try:
  for row in c.execute('select * from orchestration_events'):
   d=dict(row);seq=d.pop('seq');entity=d.pop('entity_id');node('MiniEvent','event:'+str(seq),entity_id=entity,**d);edge(entity,'event:'+str(seq),'HAS_EVENT')
 except sqlite3.OperationalError:pass
 return {n['id']:n for n in nodes},edges

def run(once=False):
 try:cursor=json.loads(CACHE.read_text())
 except:cursor={}
 driver=GraphDatabase.driver(URI,auth=('mini-tui','local'))
 # data_version is meaningful only across reads on the SAME connection.
 # Capture it before snapshot: writes during projection must trigger the next pass.
 c=sqlite3.connect(f'file:{DB}?mode=ro',uri=True);c.row_factory=sqlite3.Row
 projected_version=None;last_status=None;last_projection=0.0
 while True:
  try:
   version=c.execute('PRAGMA data_version').fetchone()[0]
   if version==projected_version and last_status is not None and not once and time.monotonic()-last_projection<60:
    driver.verify_connectivity()
    status=dict(last_status,synced_at=int(time.time()*1000),changed=0,source_unchanged=True)
    tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(status));tmp.replace(STATE)
    time.sleep(3);continue
   nodes,edges=snapshot(c);changed=[]
   for id,n in nodes.items():
    digest=hashlib.sha256(json.dumps(n,sort_keys=True).encode()).hexdigest()
    if cursor.get(id)!=digest:changed.append((n,digest))
   edgehash=hashlib.sha256(json.dumps(edges,sort_keys=True).encode()).hexdigest()
   with driver.session() as s:
    for label in ['MiniAgent','MiniTask','MiniBoard','MiniCard','MiniEvent']:  # queue tasks are MiniTask too
     rows=[dict(id=n['id'],props=n['props'],digest=h) for n,h in changed if n['label']==label]
     for i in range(0,len(rows),100):
      batch=rows[i:i+100]
      s.run(f'UNWIND $rows AS row MERGE (n:{label} {{id: row.id}}) SET n += row.props',rows=batch).consume()
      # Immutable revisions retain assignment/status/result history, not just latest state.
      s.run('UNWIND $rows AS row MERGE (e:MiniRevision {id: row.id + ":" + row.digest}) SET e.entity_id = row.id, e.snapshot = row.props, e.recorded_at = $at',rows=[dict(id=r['id'],digest=r['digest'],props=json.dumps(r['props'],sort_keys=True)) for r in batch],at=int(time.time()*1000)).consume()
    if cursor.get('_edges')!=edgehash:
     for kind in sorted(set(e['kind'] for e in edges)):
      rows=[e for e in edges if e['kind']==kind]
      for i in range(0,len(rows),100):
       s.run(f'UNWIND $rows AS row MATCH (a {{id: row.a}}), (b {{id: row.b}}) MERGE (a)-[:{kind}]->(b)',rows=rows[i:i+100]).consume()
   cursor_changed=bool(changed) or cursor.get('_edges')!=edgehash
   cursor.update({n['id']:h for n,h in changed});cursor['_edges']=edgehash
   if cursor_changed:CACHE.write_text(json.dumps(cursor))
   status=dict(ok=True,synced_at=int(time.time()*1000),nodes=len(nodes),edges=len(edges),changed=len(changed),backend='neo4j-rust',uri=URI,source_unchanged=False)
   projected_version=version;last_status=status.copy();last_projection=time.monotonic()
  except Exception as e:
   projected_version=None
   status=dict(ok=False,checked_at=int(time.time()*1000),error=str(e)[:300],backend='neo4j-rust')
  tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(status));tmp.replace(STATE)
  if once:
   c.close();driver.close();print(json.dumps(status));return
  time.sleep(3)
if __name__=='__main__':
 import sys
 run('--once' in sys.argv)
