import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'outputs/design-review-2026-11-10');
await mkdir(join(out, 'client'), { recursive: true }); await mkdir(join(out, 'images'), { recursive: true });
const files = ['app.js', 'styles.css', 'tokens.css', 'logo.svg'];
for (const file of files) await copyFile(join(root, 'workspace/client', file), join(out, 'client', file));
let html = await readFile(join(root, 'workspace/client/index.html'), 'utf8');
html = html.replaceAll('href="logo.svg"', 'href="client/logo.svg"').replaceAll('src="logo.svg"', 'src="client/logo.svg"')
  .replace('href="styles.css"', 'href="client/styles.css"').replace('src="app.js"', 'src="client/app.js"')
  .replace('</head>', '<link rel="stylesheet" href="themes.css"><script src="fixture.js" defer></script></head>');
await writeFile(join(out, 'screen.html'), html);
const themes = {
 blue: { name:'霁蓝', desc:'冷灰白与蓝，扁平、清爽', paper:'#f6f8fc', chat:'#f6f8fc', white:'#ffffff', soft:'#edf2fa', hover:'#e5edf9', selected:'#e1ebff', ink:'#25344b', muted:'#56657b', primary:'#205bd0', primaryInk:'#ffffff', deep:'#1b3158', rail:'#edf2fa', railInk:'#435776', own:'#e4edff', field:'#77869b', line:'#dce3ee', focus:'#1c58c9', inverse:'#ffffff', error:'#b53b3b', errorSurface:'#ffeded', radius:'9px', sidebar:'292px', bubble:'12px' },
 sand: { name:'暖砂', desc:'米白与赤陶，纸感、利落', paper:'#f5f0e7', chat:'#f5f0e7', white:'#fffcf7', soft:'#ece5d9', hover:'#e9dfd0', selected:'#edddd0', ink:'#342e28', muted:'#6c5b4b', primary:'#a74525', primaryInk:'#fffaf4', deep:'#4e3629', rail:'#e9dfcf', railInk:'#66523e', own:'#eed9ca', field:'#8a7a68', line:'#d8cdbd', focus:'#a74525', inverse:'#fffaf4', error:'#a52d31', errorSurface:'#fbe4e0', radius:'3px', sidebar:'300px', bubble:'4px' },
 graphite: { name:'石墨', desc:'深灰与琥珀，紧凑、专注', paper:'#171a1d', chat:'#171a1d', white:'#21262b', soft:'#292f35', hover:'#343b42', selected:'#3a3427', ink:'#edf0f2', muted:'#aeb8c2', primary:'#eab45c', primaryInk:'#241d13', deep:'#edf0f2', rail:'#121518', railInk:'#b7c0c8', own:'#343a40', field:'#7d8893', line:'#3a424a', focus:'#eab45c', inverse:'#172027', error:'#ff9d98', errorSurface:'#4a2728', radius:'5px', sidebar:'278px', bubble:'6px' },
 dusk: { name:'暮紫', desc:'石板与雾紫，柔和、舒展', paper:'#20212e', chat:'#242634', white:'#2d2f40', soft:'#35384c', hover:'#41445c', selected:'#41415f', ink:'#f0eef8', muted:'#b8b9ce', primary:'#b7aff5', primaryInk:'#282139', deep:'#eeebfb', rail:'#282a39', railInk:'#c0bed3', own:'#41415f', field:'#9193ad', line:'#47495f', focus:'#c4baff', inverse:'#24202e', error:'#ffb0a7', errorSurface:'#4e303b', radius:'17px', sidebar:'310px', bubble:'20px' }
};
const stamp = `/* Hallmark · shape: app screen · genre: modern-minimal · theme: brand + Furrow + Console + Dusk · scope: app · redesign: restyle · v2.0.0
 * nav: kept icon rail · signature: same conversation in four visual systems · states: full, empty, error and loading use original client logic · copy: verbatim
 * axes: light and dark/grotesk-sans/warm and cool · posture: restrained · typography: system face retained for Chinese app work
 * finish-review: subagent · fix · 2 findings · 2 resolved · gap: none
 */
/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4 · weakest: E, dark surfaces split primary ink from paper and every token gets a contrast check */
`;
let css = stamp + `/* Hallmark · waive 39b · two-line conversation row · Conversation selections hold a name, preview and time; their row height preserves readable chat previews rather than toolbar geometry. */
/* Hallmark · waive 72 · clipped conversation summary · The conversation summary keeps one-line ellipsis; range geometry includes clipped text while the visible row retains 16px horizontal padding. */
/* Hallmark · dismissed 40 · Four computed theme checks pass text contrast; rail selections are icons needing 3:1, while primary text has at least 5.574:1. Static merged theme variables do not describe a rendered theme. */
/* Hallmark · dismissed 41 · The primary-ink and surface roles are separate in every active theme, verified by real browser computed styles for both light and dark buttons. */
:root { --font-body:"Segoe UI","Microsoft YaHei",sans-serif; --font-code:Consolas,monospace; --primary-ink:#ffffff; --radius-control:9px; --radius-bubble:12px; --sidebar-width:292px; }\n`;
for (const [key,t] of Object.entries(themes)) css += `:root[data-theme="${key}"] {
 --ink:${t.ink}; --muted:${t.muted}; --primary:${t.primary}; --primary-ink:${t.primaryInk}; --primary-deep:${t.deep}; --primary-hover:${t.primary}; --primary-pressed:${t.primary}; --accent:${t.primary}; --focus:${t.focus};
 --paper:${t.paper}; --chat:${t.chat}; --surface:${t.paper}; --surface-white:${t.white}; --surface-soft:${t.soft}; --surface-hover:${t.hover}; --surface-selected:${t.selected}; --surface-pressed:${t.selected}; --line:${t.line}; --field-line:${t.field};
 --rail-bg:${t.rail}; --rail-ink:${t.railInk}; --rail-active:${t.selected}; --inverse-ink:${t.inverse}; --selection-surface:${t.selected}; --selection-ink:${t.ink};
 --avatar-surface:${t.soft}; --avatar-ink:${t.muted}; --assistant-surface:${t.selected}; --avatar-warm:${t.soft}; --avatar-warm-ink:${t.ink}; --avatar-blue:${t.soft}; --avatar-blue-ink:${t.ink}; --avatar-rose:${t.soft}; --avatar-rose-ink:${t.ink}; --avatar-indigo:${t.soft}; --avatar-indigo-ink:${t.ink}; --self-avatar-surface:${t.selected}; --self-avatar-ink:${t.ink};
 --own-bubble:${t.own}; --own-bubble-line:${t.line}; --media-ground:${t.soft}; --video-ground:${t.rail}; --file-surface:${t.soft}; --file-ink:${t.ink}; --red:${t.error}; --error-surface:${t.errorSurface}; --warning:${t.primary}; --drop-surface:${t.soft}; --drop-line:${t.primary}; --shadow:${t.line}; --backdrop:#10141b80; --image-backdrop:#10141bed; --toast-surface:${t.ink};
 --radius-control:${t.radius}; --radius-bubble:${t.bubble}; --sidebar-width:${t.sidebar};
}\n`;
css += `html,body { overflow-x:clip; } :root { font-size:16px; }
body { color:var(--ink); background:var(--paper); }
button,input,textarea,select { font-family:var(--font-body); }
h1,h2,h3 { min-width:0; overflow-wrap:break-word; }
.app-view { max-width:1680px; margin-inline:auto; min-height:0; height:100dvh; }
.rail { background:var(--rail-bg); color:var(--rail-ink); border-right:1px solid var(--line); width:72px; }
.rail-button:hover,.rail-button.active { background:var(--surface-selected); color:var(--primary); }
.rail-button,.icon-button,.primary,.secondary,.input-icon,.search-box,.conversation,.attachment-options,.modal { border-radius:var(--radius-control); }
.primary,.unread { background:var(--primary); color:var(--primary-ink); }
.primary:hover { filter:brightness(.94); } .primary:active { filter:brightness(.88); }
.sidebar { width:var(--sidebar-width); background:var(--surface-white); }
.conversation { padding:16px; } .conversation-name { font-size:15px; } .conversation-summary p { font-size:13px; }
.conversation.selected { background:var(--surface-selected); }
.avatar { border-radius:var(--radius-control); } .bubble { font-size:16px; line-height:1.7; border-radius:var(--radius-bubble); background:var(--surface-white); border-color:var(--line); }
.message.own .bubble { background:var(--own-bubble); color:var(--ink); border-color:var(--own-bubble-line); }
.message-author,.message-time { color:var(--muted); } .message { margin-bottom:24px; }
.chat-heading h2 { font-size:20px; } .composer textarea { font-size:16px; }
.messages { padding:28px 32px; } .chat-header { background:var(--surface-white); }
.composer { background:var(--surface-white); } .message-timestamp time { background:var(--surface-white); color:var(--ink); }
.login-panel { max-width:352px; } .login-brand { margin-bottom:40px; } .login-form label,.input-icon input { font-size:16px; }
.brand-mark { width:40px; height:40px; flex-shrink:0; } .rail-brand .brand-mark { width:36px; height:36px; }
.brand-mark rect { fill:var(--primary); } .brand-mark .mark-bubble { fill:var(--primary-ink); } .brand-mark .mark-line { stroke:var(--primary); }
.toast { background:var(--toast-surface); color:var(--paper); }
:where(button,a,summary,input,textarea,select,[tabindex]):focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
.rail-button:focus-visible { outline-color:var(--focus); }
.search-box { min-height:44px; padding-block:0; } .search-box input { min-height:32px; }
:root[data-theme="sand"] .conversation.selected { box-shadow:inset 3px 0 var(--primary); }
:root[data-theme="sand"] .bubble { border:0; border-left:2px solid var(--line); }
:root[data-theme="graphite"] .conversation { padding-block:12px; } :root[data-theme="graphite"] .message { margin-bottom:16px; }
:root[data-theme="graphite"] .bubble { border:0; } :root[data-theme="graphite"] .rail-button.active { box-shadow:inset 2px 0 var(--primary); }
:root[data-theme="dusk"] .conversation { padding-block:20px; } :root[data-theme="dusk"] .message { margin-bottom:24px; }
:root[data-theme="dusk"] .bubble { border:0; padding:12px 20px; } :root[data-theme="dusk"] .login-panel { max-width:372px; }
@media(max-width:1000px) { .sidebar { width:250px; } .messages { padding:24px; } }
@media(max-width:600px) { .rail { width:52px; } .sidebar { width:180px; } .messages { padding:12px; } }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { transition:none!important; animation:none!important; scroll-behavior:auto!important; } }
`;
await writeFile(join(out, 'themes.css'), css);
await writeFile(join(out, 'fixture.js'), `'use strict';
// Review-only adapter. No network fallback, credentials or production messages.
const params = new URLSearchParams(location.search);
const theme = ${JSON.stringify(Object.keys(themes))}.includes(params.get('theme')) ? params.get('theme') : 'blue';
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
`);
const cards=Object.entries(themes).map(([key,t],i)=>`<figure data-choice="${key}"><figcaption><h2>${String.fromCharCode(65+i)} ${t.name}</h2><p>${t.desc}</p><a href="?theme=${key}&screen=chat" data-choose="${key}">查看方案</a></figcaption><a class="preview-visual" href="?theme=${key}&screen=chat" data-choose="${key}" aria-label="查看${t.name}聊天方案"><img src="images/${key}-chat-1280.png" alt="${t.name}聊天界面，使用同一组合成演示消息" width="1280" height="860"></a></figure>`).join('');
await writeFile(join(out,'index.html'),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="同频聊天与登录的四套配色和风格审核，使用合成演示数据。"><title>同频风格审核</title><link rel="stylesheet" href="review.css"><script src="review.js" defer></script></head><body><header><div><h1>同频风格审核</h1><p>同一界面，四种方向。消息均为演示数据。</p></div><nav aria-label="审核界面"><a data-screen="chat" href="?screen=chat" aria-current="page">聊天</a><a data-screen="login" href="?screen=login">登录</a></nav></header><main><nav class="theme-nav" aria-label="选择方案"><a href="?theme=overview&screen=chat" data-theme="overview" aria-current="page">四图对照</a>${Object.entries(themes).map(([key,t],i)=>`<a data-theme="${key}" href="?theme=${key}&screen=chat">${String.fromCharCode(65+i)} ${t.name}</a>`).join('')}</nav><section id="comparison" class="comparison" aria-label="四套方案对比">${cards}</section><section id="single" hidden><div class="single-heading"><h2 id="theme-title">霁蓝</h2><p id="theme-note">可切换聊天与登录，也可操作附件、成员和设置。</p><a id="full-link" href="screen.html?theme=blue&screen=chat" target="_blank" rel="noopener">原尺寸查看</a></div><iframe id="live-screen" title="所选方案的可操作演示" src="about:blank"></iframe></section><p class="review-note">这是独立审核预览。输入只在演示内存中显示；选择方案后，在当前 Codex 对话回复 A、B、C 或 D。</p></main></body></html>`);
await writeFile(join(out,'review.js'),`'use strict';
const themes=${JSON.stringify(themes)}, url=new URL(location.href);let choice=Object.hasOwn(themes,url.searchParams.get('theme'))?url.searchParams.get('theme'):'overview';let screen=url.searchParams.get('screen')==='login'?'login':'chat';
function render(){document.querySelectorAll('[data-theme]').forEach(a=>{a.href='?theme='+a.dataset.theme+'&screen='+screen;if(a.dataset.theme===choice)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});document.querySelectorAll('[data-screen]').forEach(a=>{a.href='?theme='+choice+'&screen='+a.dataset.screen;if(a.dataset.screen===screen)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});document.querySelectorAll('[data-choice]').forEach(f=>{const key=f.dataset.choice;f.querySelector('img').src='images/'+key+'-'+screen+'-1280.png';f.querySelector('img').alt=themes[key].name+(screen==='chat'?'聊天':'登录')+'界面，演示数据';f.querySelectorAll('[data-choose]').forEach(a=>a.href='?theme='+key+'&screen='+screen);});document.getElementById('comparison').hidden=choice!=='overview';document.getElementById('single').hidden=choice==='overview';if(choice!=='overview'){document.getElementById('theme-title').textContent='ABCD'[['blue','sand','graphite','dusk'].indexOf(choice)]+' '+themes[choice].name;document.getElementById('theme-note').textContent=themes[choice].desc;const route='screen.html?theme='+choice+'&screen='+screen;document.getElementById('live-screen').src=route;document.getElementById('full-link').href=route;}url.searchParams.set('theme',choice);url.searchParams.set('screen',screen);history.replaceState(null,'',url);}
document.addEventListener('click',e=>{const a=e.target.closest('a[data-theme],a[data-screen],a[data-choose]');if(!a)return;e.preventDefault();if(a.dataset.theme)choice=a.dataset.theme;if(a.dataset.screen)screen=a.dataset.screen;if(a.dataset.choose)choice=a.dataset.choose;render();});render();
`);
await writeFile(join(out,'review.css'),stamp+`:root { --font-body:"Segoe UI","Microsoft YaHei",sans-serif; --ink:#243247; --muted:#59677a; --paper:#f4f6fa; --surface:#ffffff; --line:#cbd4e2; --accent:#205bd0; --on-accent:#ffffff; --hover:#e5edf9; --focus:#1c58c9; --space:16px; }
*{box-sizing:border-box;}html,body{overflow-x:clip;}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 var(--font-body);}h1,h2,p,figure{margin:0;}h1,h2{min-width:0;overflow-wrap:break-word;text-wrap:balance;}header,main{width:calc(100% - 64px);max-width:1560px;margin-inline:auto;}header{display:flex;justify-content:space-between;align-items:center;padding-block:24px;border-bottom:1px solid var(--line);}h1{font-size:24px;font-weight:600;}header p,.review-note{color:var(--muted);font-size:14px;}a{color:var(--accent);text-decoration:none;}nav{display:flex;gap:8px;flex-wrap:wrap;}nav a{padding:12px 16px;min-height:44px;border-radius:8px;color:var(--muted);}nav a:hover{background:var(--hover);}nav a:active{opacity:.8;}nav a[aria-current]{color:var(--on-accent);background:var(--accent);}.theme-nav{padding-block:20px;}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px;}figcaption{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding-bottom:12px;align-items:center;}figcaption h2{font-size:19px;font-weight:600;}figcaption p{grid-row:2;font-size:14px;color:var(--muted);}figcaption a{grid-column:2;grid-row:1/3;padding:12px 0;}img{display:block;width:100%;height:auto;}figure{min-width:0;}.preview-visual{display:block;outline:1px solid var(--line);}.single-heading{display:flex;align-items:center;gap:20px;margin-bottom:12px;}.single-heading h2{font-size:20px;}.single-heading p{color:var(--muted);flex:1;font-size:14px;}iframe{display:block;width:100%;height:calc(100dvh - 260px);min-height:580px;border:1px solid var(--line);background:var(--surface);}.review-note{padding:24px 0 28px;}[hidden]{display:none!important;}:where(a,button,summary,input,select,[tabindex]):focus-visible{outline:3px solid var(--focus);outline-offset:3px;}@media(max-width:700px){header,main{width:calc(100% - 32px);}header{align-items:flex-start;gap:16px;}h1{font-size:20px;}.comparison{grid-template-columns:minmax(0,1fr);}.single-heading{flex-wrap:wrap;}.single-heading p{flex-basis:100%;}nav a{padding:12px;} }@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;}}
`);
await writeFile(join(out,'README.md'),'# 同频风格审核\n\n打开index.html或运行environment/scripts/preview-designs.ps1。A霁蓝、B暖砂、C石墨、D暮紫，支持聊天/登录四图对照和单套可操作预览。素材为真实客户端DOM/逻辑副本与合成演示数据，所有API由本机内存适配器处理；未接入正式服务或DSH，刷新会丢弃演示输入。\n\n构建：node environment/scripts/build-design-review.mjs。验证截图：environment/venv/Scripts/python.exe environment/scripts/verify-design-review.py。产品client保持已发布版本，确认方向后再实施。\n');
console.log('Built '+out);
