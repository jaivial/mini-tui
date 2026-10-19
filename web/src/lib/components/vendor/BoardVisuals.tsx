import React from 'react';
import TaskRows from './beautiful/TaskRows';
import {Timeline,TimelineItem,TimelineIndicator,TimelineSeparator,TimelineContent,TimelineTitle,TimelineMeta} from './control/timeline';
import './control/timeline.css';
export type Card={id:string;session:string;title:string;description:string;column:string;assignee:string;result:string;updatedAt:number};
const columns=['backlog','doing','review','blocked','done'];
const titles:Record<string,string>={backlog:'To do',doing:'In progress',review:'Review',blocked:'Blocked',done:'Completed'};
export default function BoardVisuals({cards,mode,labels}:{cards:Card[];mode:string;labels:Record<string,string>}) {
 const rows=(data:Card[])=>data.map(c=>({key:c.id,label:c.title,amount:'',status:(c.column==='done'?'done':c.column==='doing'?'running':c.column==='blocked'?'blocked':'sequence') as any,details:[{label:'Owner',meta:c.assignee||'Unassigned'},{label:'Status',meta:titles[c.column]||c.column},{label:c.description,meta:''},...(c.result?[{label:c.result,meta:'Saved result'}]:[])]}));
 const done=cards.filter(c=>c.column==='done').length;
 return <div className="board-visuals" data-component-sources="control-ui beautifului">
  <div className="board-stats"><div><strong>{cards.length}</strong><span>Tasks</span></div><div><strong>{cards.filter(c=>c.column==='doing').length}</strong><span>In progress</span></div><div><strong>{done}</strong><span>Completed</span></div><div><strong>{cards.filter(c=>c.column==='blocked').length}</strong><span>Blocked</span></div></div>
  <div className="board-progress"><span style={{width:`${cards.length?100*done/cards.length:0}%`}} /></div>
  {mode==='list'?<Timeline className="board-tree">{Array.from(new Set(cards.map(c=>c.session))).sort().map(b=><TimelineItem key={b} state="success" style={{marginLeft:Math.min(b.split('~').length-1,4)*12}}><TimelineIndicator><span className="board-dot"/></TimelineIndicator><TimelineSeparator/><TimelineContent><TimelineTitle className="board-title">{labels[b]||b}</TimelineTitle><TimelineMeta className="board-meta">Level {b.split('~').length-1} · {cards.filter(c=>c.session===b).length} tasks</TimelineMeta><TaskRows rows={rows(cards.filter(c=>c.session===b))} variant="List" className="board-task-list"/></TimelineContent></TimelineItem>)}</Timeline>:<div className="board-columns" aria-label="Kanban columns">{(cards.length?columns.filter(col=>cards.some(c=>c.column===col)):columns).map(col=><section key={col} className={'board-column status-'+col} aria-label={titles[col]}><header><span className="board-dot"/><h4>{titles[col]}</h4><span className="column-count">{cards.filter(c=>c.column===col).length}</span></header><TaskRows rows={rows(cards.filter(c=>c.column===col))} variant="Capsules" className="board-task-list"/>{!cards.some(c=>c.column===col)&&<div className="board-empty">No tasks</div>}</section>)}</div>}
  {!cards.length&&<p className="board-empty">No matching tasks. Try a different filter.</p>}
 </div>;
}
