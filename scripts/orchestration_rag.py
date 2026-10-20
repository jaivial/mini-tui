#!/usr/bin/env python3
"""Local multilingual, chunked graph RAG over the Rust Bolt property graph."""
import hashlib,json,math,os,pathlib,re,threading,time,uuid
from collections import Counter
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import numpy as np
from fastembed import TextEmbedding
from fastembed.common.model_description import ModelSource,PoolingType
from neo4j import GraphDatabase
HOME=pathlib.Path.home()
MODEL='intfloat/multilingual-e5-small'
VERSION=MODEL+':qint8:384:chunk900-overlap150:v2'
TextEmbedding.add_custom_model(model=MODEL,pooling=PoolingType.MEAN,normalization=True,sources=ModelSource(hf=MODEL),dim=384,model_file='onnx/model_qint8_avx512_vnni.onnx',size_in_gb=.12)
model=TextEmbedding(MODEL,cache_dir=str(HOME/'.cache/mini-tui-embeddings'),threads=2)
lock=threading.Lock();index_lock=threading.Lock()
driver=GraphDatabase.driver(os.getenv('MINITUI_GRAPH_URI','bolt://127.0.0.1:7687'),auth=('mini-tui','local'))
STATE=pathlib.Path(os.getenv('MINITUI_RAG_STATE',str(HOME/'.config/mini-tui/orchestration-rag-status.json')))
status=dict(ok=False,model=MODEL,version=VERSION,indexed=0)
def embed(texts,query=False):
 with lock:return [v.tolist() for v in model.embed([('query: ' if query else 'passage: ')+t for t in texts])]
def chunks(text):
 text=text.strip()
 return [text[i:i+900] for i in range(0,len(text),750) if text[i:i+900].strip()] or ['(empty record)']
def terms(text):return re.findall(r'[\w-]{3,}',text.lower())
def write_status():
 tmp=STATE.with_suffix('.tmp');tmp.write_text(json.dumps(status));tmp.replace(STATE)
def index_once():
 with index_lock,driver.session() as s:
  agents={r['id'].removeprefix('mini-tui:'):r['cwd'] for r in s.run('MATCH (n:MiniAgent) RETURN n.id AS id,n.cwd AS cwd')}
  total=0;count=0;changed=0
  for label in ['MiniCard','MiniAgent','MiniTask']:
   rows=list(s.run(f'MATCH (n:{label}) RETURN n.id AS id,n.session_id AS sid,n.title AS title,n.description AS description,n.task AS task,n.result AS result,n.rag_hash AS hash,n.project_cwd AS cwd'))
   for r in rows:
    sid=r['sid'] or r['id'].removeprefix('mini-tui:').removeprefix('task:')
    # Keep late results: chunk all fields instead of truncating the document prefix.
    text='\n'.join(str(r.get(k) or '')[:limit] for k,limit in [('title',240),('description',1800),('task',1800),('result',6000)])
    cwd=agents.get(sid,'') or agents.get(sid.split('~')[0],'');parts=chunks(text)
    digest=hashlib.sha256((VERSION+cwd+text).encode()).hexdigest();total+=len(parts);count+=1
    if digest==r['hash']:continue
    vectors=embed(parts);records=[]
    for i,(part,vector) in enumerate(zip(parts,vectors)):
     records.append(dict(id=r['id']+':chunk:'+digest+':'+str(i),entity=r['id'],sid=sid,cwd=cwd,title=str(r['title'] or '')[:240],text=part,vector=json.dumps(vector),hash=digest,ordinal=i))
    s.run('UNWIND $rows AS row MERGE (c:MiniChunk {id:row.id}) SET c.entity_id=row.entity,c.session_id=row.sid,c.project_cwd=row.cwd,c.title=row.title,c.text=row.text,c.embedding=row.vector,c.model=$model,c.version=$version,c.hash=row.hash,c.ordinal=row.ordinal',rows=records,model=MODEL,version=VERSION).consume()
    s.run('UNWIND $rows AS row MATCH (n {id:row.entity}),(c:MiniChunk {id:row.id}) MERGE (n)-[:HAS_CHUNK]->(c)',rows=records).consume()
    # Publish the new document revision only after every chunk is durable.
    s.run(f'MATCH (n:{label} {{id:$id}}) SET n.rag_hash=$hash,n.rag_version=$version,n.project_cwd=$cwd',id=r['id'],hash=digest,version=VERSION,cwd=cwd).consume();changed+=1
    status.update(ok=True,indexing=True,processed=count,indexed=max(status['indexed'],count),chunks=max(status.get('chunks',0),total),updated_at=int(time.time()*1000));write_status()
   status.update(ok=True,indexing=True,processed=count,indexed=max(status['indexed'],count),chunks=max(status.get('chunks',0),total),updated_at=int(time.time()*1000));write_status()
  status.update(ok=True,indexing=False,indexed=count,chunks=total,changed=changed,updated_at=int(time.time()*1000),error=None);write_status()
def index_loop():
 while True:
  try:index_once()
  except Exception as e:status.update(ok=False,error=str(e)[:300]);write_status()
  time.sleep(5)
def retrieve(data):
 query=str(data.get('query',''))[:6000];root=str(data.get('root','')).split('~')[0];cwd=str(data.get('cwd',''));scope=str(data.get('scope',''))
 if not query.strip() or not root:raise ValueError('query and root session required')
 if not status['ok']:raise RuntimeError('multilingual index not ready')
 if cwd in ['/tmp','/','',str(HOME)]:cwd='__no_project__'
 q=np.array(embed([query],True)[0]);tokens=Counter(terms(query));candidates=[]
 with driver.session() as s:
  rows=list(s.run('MATCH (n)-[:HAS_CHUNK]->(c:MiniChunk) WHERE n.rag_hash=c.hash AND c.version=$version AND (c.session_id=$root OR c.session_id STARTS WITH $prefix OR c.project_cwd=$cwd) RETURN c.id AS id,c.entity_id AS entity,c.session_id AS sid,c.title AS title,c.text AS text,c.embedding AS embedding,c.ordinal AS ordinal LIMIT 8001',version=VERSION,root=root,prefix=root+'~',cwd=cwd))
  if len(rows)>8000:raise RuntimeError('project exceeds exact-search budget of8000 chunks; narrow project scope')
  docs=[Counter(terms(r['text'])) for r in rows];df=Counter(k for doc in docs for k in doc);n=len(rows)
  for r,doc in zip(rows,docs):
   v=np.array(json.loads(r['embedding']));cos=float(np.dot(q,v)/(np.linalg.norm(q)*np.linalg.norm(v)))
   lexical=sum(math.log(1+(n-df[t]+.5)/(df[t]+.5))*min(doc[t],3) for t in tokens if t in doc)
   # E5 cosine is naturally high even for unrelated text; use relative reranking,
   # a floor and a score-window, not the previous MiniLM .28 threshold.
   score=cos+min(lexical/30,.12)
   if cos>=.70:candidates.append(dict(id=r['entity'],chunk_id=r['id'],session=r['sid'],title=r['title'],score=round(cos,4),hybrid=round(score,4),text=r['text'],ordinal=r['ordinal']))
  candidates.sort(key=lambda h:h['hybrid'],reverse=True)
  hits=[];seen=Counter();texts=set();ceiling=candidates[0]['hybrid'] if candidates else 0
  for h in candidates:
   fingerprint=hashlib.sha256(h['text'].encode()).hexdigest()
   if h['hybrid']<ceiling-.10 or seen[h['id']]>=2 or fingerprint in texts:continue
   hits.append(h);seen[h['id']]+=1;texts.add(fingerprint)
   if len(hits)==6:break
  # Include parent/session provenance, not private global neighbors from other projects.
  for h in hits:h['hierarchy']=h['session'].split('~');h['depth']=h['session'].count('~')
  rid='mini-tui:retrieval:'+str(uuid.uuid4());at=int(time.time()*1000)
  s.run('CREATE (r:MiniRetrieval {id:$id,root:$root,scope:$scope,query:$text,model:$model,version:$version,hits:$hits,created_at:$at,candidates:$candidates})',id=rid,root=root,scope=scope,text=query,model=MODEL,version=VERSION,hits=json.dumps(hits),at=at,candidates=n).consume()
  for h in hits:s.run('MATCH (r:MiniRetrieval {id:$rid}),(c:MiniChunk {id:$cid}) MERGE (r)-[:RETRIEVED]->(c)',rid=rid,cid=h['chunk_id']).consume()
 return dict(ok=True,retrieval_id=rid,model=MODEL,version=VERSION,search='chunked multilingual exact cosine + lexical reranking',hits=hits,candidates=n,indexed=status['indexed'])
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):self.reply(200,status)
 def do_POST(self):
  try:
   size=int(self.headers.get('Content-Length','0'))
   if size<1 or size>30000:raise ValueError('request size invalid')
   self.reply(200,retrieve(json.loads(self.rfile.read(size))))
  except Exception as e:self.reply(503,dict(ok=False,error=str(e)[:300]))
 def reply(self,code,data):
  body=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
if __name__=='__main__':
 threading.Thread(target=index_loop,daemon=True).start()
 ThreadingHTTPServer(('127.0.0.1',int(os.getenv('MINITUI_RAG_PORT','9446'))),Handler).serve_forever()
