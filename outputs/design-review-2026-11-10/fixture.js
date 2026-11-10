'use strict';
// Review-only adapter. No network fallback, credentials or production messages.
const params = new URLSearchParams(location.search);
const theme = ["blue","sand","graphite","dusk"].includes(params.get('theme')) ? params.get('theme') : 'blue';
document.documentElement.dataset.theme = theme;
const mark = '<svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="15"/><path class="mark-bubble" d="M12 17a5 5 0 0 1 5-5h14a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5h-8l-7 5v-5a5 5 0 0 1-4-5z"/><path class="mark-line" d="m19 20 3.3 4 6.7-7M19 26h10" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
document.querySelectorAll('.brand img,.rail-brand img').forEach(img=>{const span=document.createElement('span'); span.innerHTML=mark; img.replaceWith(span.firstChild);});
const people=[{id:'lin',username:'lin',display_name:'林晓',is_admin:true,is_bot:false},{id:'chen',username:'chen',display_name:'陈夏',is_bot:false},{id:'zhou',username:'zhou',display_name:'周牧',is_bot:false},{id:'dsh',username:'dsh',display_name:'小同',is_bot:true}];
const texts=['新版界面先看这几个方向，大家选一个顺眼的。','聊天和文件入口都保持原来的位置。','我更关注长时间阅读，背景柔和一些。','把登录页也放在一起对比吧。','已整理好可审核的界面方案。'];
const authors=[1,1,2,0,3];
const messages=texts.map((text,i)=>({id:i+1,conversation_id:'product',client_id:'sample-'+i,text,sender:people[authors[i]],attachment:null,created_at:'2026-11-10T02:'+String(10+i).padStart(2,'0')+':00Z'}));
const chats=[{id:'product',title:'产品协作组',is_direct:false,members:people,updated_at:'2026-11-10T02:14:00Z',unread_count:0,last_message:messages.at(-1)},{id:'dm',title:'',is_direct:true,members:[people[0],people[2]],updated_at:'2026-11-10T01:55:00Z',unread_count:1,last_message:{id:0,text:'晚点一起看下配色。',sender:people[2],created_at:'2026-11-10T01:55:00Z'}}];
window.__previewRequests=[];
window.fetch=async(input,options={})=>{const u=new URL(String(input),location.href);window.__previewRequests.push(u.pathname);let data;
if(u.pathname==='/api/login') data={token:'review-only-no-auth',user:people[0]};
else if(u.pathname==='/api/users') data=people;
else if(u.pathname==='/api/conversations'&&options.method==='POST'){data=chats.find(c=>c.is_direct)||chats[0];}
else if(u.pathname==='/api/conversations')data=chats;
else if(u.pathname.endsWith('/messages')&&options.method==='POST'){const body=JSON.parse(options.body);data={...messages[0],...body,id:messages.length+1,sender:people[0],created_at:new Date().toISOString()}; messages.push(data);}
else if(u.pathname.endsWith('/messages'))data=u.pathname.includes('/dm/')?[]:messages;
else if(u.pathname.endsWith('/read'))data={ok:true};
else if(u.pathname==='/api/ws-ticket')data={ticket:'review-only'};
else if(u.pathname==='/api/logout')data={ok:true};
else return new Response(JSON.stringify({detail:'审核预览未连接此操作。'}),{status:400,headers:{'Content-Type':'application/json'}});
return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});};
window.WebSocket=class {static OPEN=1;constructor(){this.readyState=1;setTimeout(()=>this.onopen?.(),0);} send(){}close(){this.readyState=3;}};
S.base=location.origin==='null'?'https://review.example.com':location.origin;
$('server-url').value=S.base; $('username').value=''; $('password').value=''; $('connection-settings').open=false;
if(params.get('screen')!=='login') { S.me=people[0];S.token='review-only-no-auth';S.conversations=chats;S.users=people;$('my-avatar').textContent='林';$('login-view').hidden=true;$('app-view').hidden=false; connection('online'); $('connection-text').hidden=false; $('connection-text').textContent='演示预览'; renderConversations(); selectConversation('product').then(()=>{document.activeElement?.blur();window.__previewReady=true;}); }
else window.__previewReady=true;
