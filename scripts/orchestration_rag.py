#!/usr/bin/env python3
"""Local semantic retrieval from neo4j-rust. Embeddings live on graph nodes.
No external embedding calls. Exact cosine over bounded project candidates.
"""
import json,os,time,threading,hashlib,pathlib,uuid
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import numpy as np
from fastembed import TextEmbedding
from neo4j import GraphDatabase
HOME=pathlib.Path.home()
MODEL='sentence-transformers/all-MiniLM-L6-v2'
model=TextEmbedding(MODEL,cache_dir=str(HOME/'.cache/mini-tui-embeddings'),threads=2)
lock=threading.Lock()
driver=GraphDatabase.driver(os.getenv('MINITUI_GRAPH_URI','bolt://127.0.0.1:7687'),auth=('mini-tui','local'))
STATE=HOME/'.config/mini-tui/orchestration-rag-status.json'
status={'ok':False,'model':MODEL,'indexed':0}
def embed(texts):
 with lock:return [v.tolist() for v in model.embed(texts)]
def index():
 while True:
  try:
   with driver.session() as s:
    agents={r['id'].removeprefix('mini-tui:'):r['cwd'] for r in s.run('MATCH (n:MiniAgent) RETURN n.id AS id,n.cwd AS cwd')}
    count=0;changed=[]
    for label in ['MiniCard','MiniAgent','MiniTask']:
     rows=[dict(r) for r in s.run(f'MATCH (n:{label}) RETURN n.id AS id,n.session_id AS sid,n.title AS title,n.description AS description,n.task AS task,n.result AS result,n.embedding_hash AS hash,n.project_cwd AS cwd')]
     count+=len(rows)
     for r in rows:
      sid=r['sid'] or r['id'].removeprefix('mini-tui:').removeprefix('task:')
      text='\n'.join(str(r.get(k) or '') for k in ['title','description','task','result'])[:6000]
      digest=hashlib.sha256((MODEL+text).encode()).hexdigest()
      cwd=agents.get(sid,'') or agents.get(sid.split('~')[0],'')
      if digest!=r['hash'] or r['cwd']!=cwd:changed.append(dict(id=r['id'],sid=sid,cwd=cwd,text=text,hash=digest,label=label))
    for label in ['MiniCard','MiniAgent','MiniTask']:
     items=[r for r in changed if r['label']==label]
     for i in range(0,len(items),16):
      batch=items[i:i+16];vectors=embed([r['text'] for r in batch])
      for r,v in zip(batch,vectors):r['vector']=json.dumps(v)
      s.run(f'UNWIND $rows AS row MATCH (n:{label} {{id:row.id}}) SET n.embedding=row.vector,n.embedding_model=$model,n.embedding_hash=row.hash,n.retrieval_text=row.text,n.project_cwd=row.cwd,n.retrieval_session=row.sid',rows=batch,model=MODEL).consume()
   status.update(ok=True,indexed=count,updated_at=int(time.time()*1000),changed=len(changed))
   status.pop('error',None)
  except Exception as e:status.update(ok=False,error=str(e)[:300])
  tmp=STATE.with_suffix(".tmp");tmp.write_text(json.dumps(status));tmp.replace(STATE)
  time.sleep(5)
def retrieve(data):
 query=str(data.get('query',''))[:6000];root=str(data.get('root','')).split('~')[0];cwd=str(data.get('cwd',''))
 if not query.strip() or not root:raise ValueError('query and local root session required')
 if not status['ok']:raise RuntimeError('semantic index not ready: '+str(status.get('error','starting')))
 q=np.array(embed([query])[0]);hits=[]
 with driver.session() as s:
  rows=s.run('MATCH (n) WHERE n.embedding_model=$model AND (n.retrieval_session=$root OR n.retrieval_session STARTS WITH $prefix OR n.project_cwd=$cwd) RETURN n.id AS id,n.retrieval_session AS sid,n.retrieval_text AS text,n.embedding AS embedding LIMIT 4000',model=MODEL,root=root,prefix=root+"~",cwd=cwd if cwd not in ['/tmp','/','',str(HOME)] else '__no_project__')
  for r in rows:
   v=np.array(json.loads(r['embedding']));score=float(np.dot(q,v)/(np.linalg.norm(q)*np.linalg.norm(v)))
   if score>=0.28:hits.append(dict(id=r['id'],session=r['sid'],score=round(score,4),text=r['text'][:1600]))
  hits=sorted(hits,key=lambda x:x['score'],reverse=True)[:4]
  rid='mini-tui:retrieval:'+str(uuid.uuid4());at=int(time.time()*1000)
  # Audit persisted before delivery. Node IDs and scores, no fabricated citations.
  s.run('CREATE (r:MiniRetrieval {id:$id,root:$root,query:$text,model:$model,hits:$hits,created_at:$at})',id=rid,root=root,text=query,model=MODEL,hits=json.dumps(hits),at=at).consume()
  for h in hits:s.run('MATCH (r:MiniRetrieval {id:$rid}),(n {id:$id}) MERGE (r)-[:RETRIEVED]->(n)',rid=rid,id=h['id']).consume()
 return dict(ok=True,retrieval_id=rid,model=MODEL,search='exact cosine on neo4j-rust embeddings',hits=hits,indexed=status['indexed'])
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):self.reply(200,status)
 def do_POST(self):
  try:
   size=int(self.headers.get('Content-Length','0'))
   if size>24000:raise ValueError('request too large')
   data=json.loads(self.rfile.read(size));self.reply(200,retrieve(data))
  except Exception as e:self.reply(503,dict(ok=False,error=str(e)[:300]))
 def reply(self,code,data):
  body=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
if __name__=='__main__':
 threading.Thread(target=index,daemon=True).start()
 ThreadingHTTPServer(('127.0.0.1',9446),Handler).serve_forever()
