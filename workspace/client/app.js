'use strict';

// All user-controlled strings are assigned with textContent, never parsed as HTML.
const $ = (id) => document.getElementById(id);
const paths = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 8"/><circle cx="9" cy="7" r="4"/>',
  user: '<path d="M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2"/><circle cx="12" cy="6" r="4"/>',
  settings: '<path d="m9 3-.7 2.3-2.4 1-2.1-1.1-2 3.4 1.8 1.7-.1 2.7-1.7 1.6 2 3.5 2.3-.5 2 1.2.9 2.2h4l.8-2.3 2.3-1.1 2.2.8 2-3.4-1.6-1.9v-2.5L22 9l-2-3.5-2.4.6-2.2-1.3L15 3z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 18 17"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16m3-11h.01m-.01 4h.01"/>',
  paperclip: '<path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7l-10 10a2 2 0 0 1-2.8-2.8l9.2-9.2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  play: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m-14-8 5-5 5 5m-5-5v13"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8m-8 4h5"/>',
  spark: '<path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8z"/>',
  shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11zM8 12l3 3 5-6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  'arrow-right': '<path d="M5 12h14m-6-6 6 6-6 6"/>'
};
function icon(name) {
  const n = document.createElement('span');
  // Only static application-owned SVG path literals are interpolated here.
  n.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  return n.firstElementChild;
}
document.querySelectorAll('[data-icon]').forEach((n) => n.append(icon(n.dataset.icon)));
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function button(text, cls, action, iconName) { const n = el('button', cls, text); n.type = 'button'; if (iconName) n.append(icon(iconName)); if (action) n.addEventListener('click', action); return n; }
function iconButton(name, title, action) { const n = button('', 'icon-button', action, name); n.title = title; n.setAttribute('aria-label', title); return n; }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function readPreference(key) { try { return localStorage.getItem(key); } catch { return ''; } }
function savePreference(key, value) { try { localStorage.setItem(key, value); } catch { /* Preferences are optional. */ } }
const S = { base: '', token: null, me: null, conversations: [], users: [], selected: null, messages: [], pending: new Map(), uploads: new Map(), socket: null, reconnect: null, ping: null, refresh: null, retry: 0, epoch: 0, details: false, hasMore: false, historyBusy: false, loadingConversation: null, historyRequest: 0, scrollIntent: 0, composing: false, requests: new Set() };
let toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4300); }
function normalizeBase(value) {
  let u; try { u = new URL(value); } catch { throw new Error('团队地址不正确，请检查后重试。'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('请填写完整的团队地址，例如 https://im.example.com。');
  return u.origin;
}
function friendlyDetail(detail, status) {
  if (status === 413) return '文件太大，请选择小于 100 MB 的文件。';
  if (status === 429) return '尝试次数过多，请一分钟后重试。';
  if (status >= 500) return '暂时无法完成，请稍后重试或联系管理员。';
  const copy = {
    '用户名或密码错误': '账号或密码不正确，请重新输入。',
    '用户名已存在': '这个账号已被使用，请换一个。',
    'client_id 已用于不同消息': '这条消息未能发送，请重新发送。',
    '长期令牌只用于机器人账号': '请选择一个助手账号。',
    '没有此会话的访问权限': '你无法查看这个聊天，请联系管理员。',
    '消息不属于此会话': '消息未找到，请重新打开聊天。',
    '附件不属于此用户或会话': '文件未能发送，请重新选择。'
  };
  if (copy[detail]) return copy[detail];
  if (typeof detail === 'string' && !/[A-Za-z_]{3,}|字节|令牌|机器人|multipart/.test(detail)) return detail;
  return status === 401 ? '请重新登录。' : status === 403 ? '无法完成这个操作，请联系管理员。' : status === 404 ? '内容未找到，请刷新后重试。' : '未能完成，请检查后重试。';
}
function errorText(error) { if (error instanceof TypeError || /fetch|NetworkError|Failed to fetch/i.test(error?.message || '')) return '连接失败，请检查网络和团队地址。'; return error?.message || '未能完成，请稍后重试。'; }
async function api(path, options = {}) {
  const token = S.token;
  const headers = { ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const controller = new AbortController(); S.requests.add(controller);
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(S.base + path, { ...options, headers, signal: controller.signal, cache: 'no-store', credentials: 'omit' });
    let data; try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      if (response.status === 401 && token && S.token === token) { logoutLocal(); toast('登录已失效，请重新登录。'); }
      throw new Error(friendlyDetail(data?.detail, response.status));
    }
    return data;
  } catch (error) { if (error.name === 'AbortError') throw new Error('请求超时或已取消，请检查连接后重试。'); throw error; }
  finally { clearTimeout(timer); S.requests.delete(controller); }
}
function post(path, value = {}) { return api(path, { method: 'POST', body: JSON.stringify(value) }); }
function nameFor(user) { return user?.display_name || user?.username || ''; }
function avatar(user, group = false) { const n = el('div', 'avatar'); if (group) { n.classList.add('avatar-group'); n.append(icon('users')); } else if (user?.is_bot) { n.classList.add('avatar-bot'); n.append(icon('spark')); } else { n.textContent = (user?.display_name || user?.username || '同').slice(0, 1); let sum = 0; for (const c of String(user?.id || '')) sum += c.charCodeAt(0); n.classList.add(`avatar-color-${sum % 5}`); } return n; }
function current() { return S.conversations.find((c) => c.id === S.selected); }
function peer(c) { return c.members.find((u) => u.id !== S.me.id) || S.me; }
function titleFor(c) { return c.is_direct ? nameFor(peer(c)) : c.title; }
function summary(m) { if (!m) return '还没有消息'; const content = m.text || (m.attachment ? `[${{ image: '图片', audio: '音频', video: '视频', file: '文件' }[m.attachment.kind] || '文件'}] ${m.attachment.name}` : ''); return `${m.sender.id === S.me.id ? '你' : nameFor(m.sender)}：${content}`; }
function timeShort(value) { const d = new Date(value); if (Number.isNaN(d.getTime())) return ''; const today = new Date(); return d.toDateString() === today.toDateString() ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : `${d.getMonth() + 1}/${d.getDate()}`; }
function dayLabel(value) { const d = new Date(value); if (Number.isNaN(d.getTime())) return ''; if (d.toDateString() === new Date().toDateString()) return '今天'; return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }); }
function bytes(size) { if (size < 1000) return `${size} B`; if (size < 1000000) return `${(size / 1000).toFixed(1)} KB`; return `${(size / 1000000).toFixed(1)} MB`; }
function renderConversations() {
  const list = $('conversation-list'); list.replaceChildren();
  const query = $('conversation-search').value.trim().toLocaleLowerCase();
  const conversations = [...S.conversations].sort((a, b) => (b.last_message?.id || 0) - (a.last_message?.id || 0) || new Date(b.updated_at) - new Date(a.updated_at));
  $('conversation-count').textContent = S.conversations.length;
  for (const c of conversations) {
    if (query && !titleFor(c).toLocaleLowerCase().includes(query)) continue;
    const n = button('', `conversation${c.id === S.selected ? ' selected' : ''}`, () => selectConversation(c.id)); n.dataset.conversationId = c.id; n.setAttribute('role', 'listitem');
    n.append(avatar(c.is_direct ? peer(c) : null, !c.is_direct));
    const copy = el('div', 'conversation-copy'), top = el('div', 'conversation-top'), sub = el('div', 'conversation-summary');
    top.append(el('span', 'conversation-name', titleFor(c)), el('span', 'conversation-time', timeShort(c.last_message?.created_at || c.updated_at)));
    sub.append(el('p', '', summary(c.last_message))); if (c.unread_count > 0) sub.append(el('span', 'unread', c.unread_count > 99 ? '99+' : c.unread_count)); copy.append(top, sub); n.append(copy); list.append(n);
  }
  if (!list.children.length) list.append(el('p', 'list-empty', query ? '没有找到聊天' : '还没有聊天'));
}
async function refreshConversations() { const epoch = S.epoch; const cs = await api('/api/conversations'); if (S.epoch !== epoch) return; S.conversations = cs; renderConversations(); if (S.selected) renderChatHeading(); }
function renderChatHeading() {
  const c = current(); if (!c) return;
  $('chat-title').textContent = titleFor(c); $('chat-subtitle').textContent = c.is_direct ? (peer(c).is_bot ? '' : peer(c).username) : `${c.members.length} 人`;
  $('chat-avatar').replaceWith(Object.assign(avatar(c.is_direct ? peer(c) : null, !c.is_direct), { id: 'chat-avatar' }));
  $('mention-assistant').hidden = !c.members.some((u) => u.is_bot); renderDetails();
}
async function selectConversation(id) {
  S.selected = id; S.messages = []; S.hasMore = false; $('message-items').replaceChildren(); $('empty-chat').hidden = true; $('active-chat').hidden = false; $('message-input').value = ''; updateCounter(); renderConversations(); renderChatHeading(); renderUploads();
  try { await loadMessages(false); } catch (e) { toast(errorText(e)); }
  $('message-input').focus();
}
async function loadMessages(older = false) {
  const id = S.selected; if (!id || (S.historyBusy && S.loadingConversation === id)) return;
  const request = ++S.historyRequest;
  S.loadingConversation = id; S.historyBusy = true; $('load-history').disabled = true;
  const before = older && S.messages.length ? Math.min(...S.messages.map((m) => m.id)) : null;
  const oldHeight = $('messages').scrollHeight, oldTop = $('messages').scrollTop;
  try {
    const data = await api(`/api/conversations/${encodeURIComponent(id)}/messages?limit=50${before ? `&before=${before}` : ''}`);
    if (S.selected !== id) return;
    const byId = new Map((older ? S.messages : []).map((m) => [m.id, m])); data.forEach((m) => { byId.set(m.id, m); S.pending.delete(m.client_id); }); S.messages = [...byId.values()].sort((a, b) => a.id - b.id); S.hasMore = data.length === 50;
    renderMessages(); if (older) $('messages').scrollTop = oldTop + $('messages').scrollHeight - oldHeight; else scrollBottom();
    markRead();
  } finally { if (request === S.historyRequest) { S.historyBusy = false; S.loadingConversation = null; $('load-history').disabled = false; } }
}
function scrollBottom() { $('messages').scrollTop = $('messages').scrollHeight; requestAnimationFrame(() => { $('messages').scrollTop = $('messages').scrollHeight; }); }
async function markRead() { const id = S.selected; const last = S.messages.at(-1); if (!id || !last) return; const c = current(); if (c) { c.unread_count = 0; renderConversations(); } try { await post(`/api/conversations/${encodeURIComponent(id)}/read`, { message_id: last.id }); } catch { /* Recovered on next refresh. */ } }
function renderMessages() {
  $('load-history').hidden = !S.hasMore;
  const box = $('message-items'), existing = new Map([...box.querySelectorAll(':scope > [data-key]')].map((n) => [n.dataset.key, n]));
  const all = [...S.messages, ...[...S.pending.values()].filter((m) => m.conversation_id === S.selected && !S.messages.some((x) => x.client_id === m.client_id))];
  const fragment = document.createDocumentFragment(); let day = '';
  for (const m of all) {
    const nextDay = dayLabel(m.created_at); if (nextDay !== day) { fragment.append(el('div', 'day-divider', nextDay)); day = nextDay; }
    const key = String(m.id || m.client_id); let n = existing.get(key);
    if (!n || m.pending) n = renderMessage(m); n.dataset.key = key; fragment.append(n);
  }
  if (!all.length) { const n = el('div', 'list-empty', '还没有消息'); fragment.append(n); }
  box.replaceChildren(fragment); renderDetails();
}
function renderMessage(m) {
  const n = el('article', `message${m.sender.id === S.me.id ? ' own' : ''}${m.pending ? ' pending' : ''}`); n.dataset.messageId = m.id || ''; n.dataset.clientId = m.client_id;
  n.append(avatar(m.sender)); const content = el('div', 'message-content'), meta = el('div', 'message-meta');
  meta.append(el('span', '', m.sender.id === S.me.id ? '我' : nameFor(m.sender))); meta.append(el('time', 'message-time', timeShort(m.created_at))); content.append(meta);
  const bubble = el('div', 'bubble'); if (m.text) bubble.append(el('div', 'message-text', m.text)); if (m.attachment) bubble.append(renderAttachment(m.attachment)); content.append(bubble);
  if (m.pending) { const status = el('div', 'message-error', m.error || '发送中…'); if (m.error) status.append(button('重试', '', () => sendPending(m))); content.append(status); }
  n.append(content); return n;
}
async function attachmentURL(a, download = false) { const data = await post(`/api/attachments/${encodeURIComponent(a.id)}/ticket`); const url = new URL(data.url, `${S.base}/`); if (url.origin !== new URL(S.base).origin || !url.pathname.startsWith('/api/attachments/')) throw new Error('文件暂时无法打开，请重试。'); if (download) url.searchParams.set('download', '1'); return url.href; }
async function downloadAttachment(a) {
  try {
    const url = await attachmentURL(a, true); const response = await fetch(url, { credentials: 'omit', cache: 'no-store' }); if (!response.ok) throw new Error('文件下载失败，请重新登录或重试。');
    const objectURL = URL.createObjectURL(await response.blob()), link = el('a'); link.href = objectURL; link.download = a.name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
  } catch (e) { toast(errorText(e)); }
}
function renderAttachment(a) {
  if (!['image', 'audio', 'video'].includes(a.kind)) { const card = el('div', 'file-card'); const symbol = el('div', 'file-symbol'); symbol.append(icon('file')); const info = el('div', 'file-info'); info.append(el('span', 'file-name', a.name), el('span', 'file-size', bytes(a.size))); card.append(symbol, info, iconButton('download', `下载 ${a.name}`, () => downloadAttachment(a))); return card; }
  const conversation = S.selected, scrollIntent = S.scrollIntent;
  const pinAfterLoad = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 150;
  const card = el('div', `media-card media-${a.kind}`), title = el('div', 'media-title'); title.append(el('span', 'media-name', a.name), iconButton('download', `下载 ${a.name}`, () => downloadAttachment(a))); card.append(title);
  const media = el(a.kind === 'image' ? 'img' : a.kind, a.kind === 'image' ? 'image-attachment' : '');
  if (a.kind === 'image') { media.alt = a.name; media.loading = 'lazy'; media.addEventListener('click', async () => { try { $('preview-image').src = await attachmentURL(a); $('preview-image').alt = a.name; $('image-modal').showModal(); } catch (e) { toast(errorText(e)); } }); }
  else { media.controls = true; media.preload = 'metadata'; }
  card.append(media);
  const fallback = el('div', 'media-fallback'); fallback.hidden = true; fallback.append(el('span', '', '预览暂不可用。'), button('重新加载', '', () => setSource()), button('下载文件', '', () => downloadAttachment(a))); card.append(fallback);
  media.addEventListener('error', () => { fallback.hidden = false; });
  const preserveBottom = () => { if (pinAfterLoad && conversation === S.selected && scrollIntent === S.scrollIntent && card.isConnected) scrollBottom(); };
  media.addEventListener('load', preserveBottom); media.addEventListener('loadedmetadata', preserveBottom);
  async function setSource() { try { fallback.hidden = true; media.src = await attachmentURL(a); if (a.kind !== 'image') media.load(); } catch { fallback.hidden = false; } }
  setSource(); return card;
}
function renderDetails() {
  const panel = $('details-panel'), c = current(); panel.hidden = !S.details || !c; if (!c) return;
  const heading = el('div', 'details-heading', '聊天详情'); heading.append(iconButton('close', '收起详情', () => { S.details = false; renderDetails(); })); panel.replaceChildren(heading);
  const group = el('div', 'details-group'), label = el('div', 'details-label', '成员'); label.append(el('span', '', `${c.members.length}`)); group.append(label);
  for (const u of c.members) { const row = el('div', 'member-row'); row.append(avatar(u), el('span', 'member-row-name', nameFor(u) + (u.id === S.me.id ? '（我）' : '')), el('span', 'member-role', u.is_admin ? '管理员' : '')); group.append(row); } panel.append(group);
  const files = el('div', 'details-group'); files.append(el('div', 'details-label', '最近共享'));
  const attachments = [...S.messages].reverse().filter((m) => m.attachment).slice(0, 5);
  for (const m of attachments) { const a = m.attachment, b = button('', 'shared-file', () => downloadAttachment(a)), symbol = el('span', 'file-symbol'), info = el('span', 'file-info'); symbol.append(icon(a.kind === 'image' ? 'image' : a.kind === 'file' ? 'file' : 'play')); info.append(el('span', 'file-name', a.name), el('span', 'file-size', bytes(a.size))); b.append(symbol, info); files.append(b); } if (!attachments.length) files.append(el('p', 'details-empty', '共享的文件会出现在这里')); panel.append(files);
}
function updateCounter() { const count = $('message-input').value.length; $('composer-counter').textContent = count >= 8000 ? `${count} / 10000` : ''; }
async function sendText() { const text = $('message-input').value.trim(); if (!text || !S.selected) return; const m = { client_id: uuid(), conversation_id: S.selected, sender: S.me, text, attachment: null, created_at: new Date().toISOString(), pending: true }; S.pending.set(m.client_id, m); $('message-input').value = ''; updateCounter(); renderMessages(); scrollBottom(); await sendPending(m); }
async function sendPending(m) {
  if (m.sending) return; m.sending = true; m.error = null; if (S.selected === m.conversation_id) renderMessages();
  try { const result = await post(`/api/conversations/${encodeURIComponent(m.conversation_id)}/messages`, { text: m.text, attachment_id: m.attachment?.id || null, client_id: m.client_id }); S.pending.delete(m.client_id); if (S.selected === m.conversation_id) { mergeMessage(result); markRead(); } await refreshConversations(); }
  catch (e) { m.error = errorText(e); if (S.selected === m.conversation_id) renderMessages(); }
  finally { m.sending = false; }
}
function mergeMessage(m) { const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 150; S.pending.delete(m.client_id); if (!S.messages.some((x) => x.id === m.id)) S.messages.push(m); S.messages.sort((a, b) => a.id - b.id); renderMessages(); if (nearBottom || m.sender.id === S.me.id) scrollBottom(); }
async function queueFiles(files) {
  if (!S.selected) { toast('请先选择一个会话。'); return; }
  const id = S.selected, epoch = S.epoch;
  for (const file of files) { if (S.epoch !== epoch) break; if (file.size >= 100000000) { toast(`${file.name} 必须小于 100 MB。`); continue; } const item = { id: uuid(), conversation: id, file, progress: 0, error: null, busy: false, attachment: null, client_id: uuid() }; S.uploads.set(item.id, item); renderUploads(); await uploadItem(item); }
}
function renderUploads() {
  const list = $('upload-list'); list.replaceChildren();
  for (const item of S.uploads.values()) { if (item.conversation !== S.selected) continue; const n = el('div', `upload-item${item.error ? ' failed' : ''}`); n.append(el('span', 'upload-item-name', `${item.file.name} · ${item.error || `${item.progress}%`}`)); if (item.error) { n.append(button('重试', '', () => uploadItem(item)), button('取消', '', () => { S.uploads.delete(item.id); renderUploads(); })); } else { const p = el('progress'); p.max = 100; p.value = item.progress; n.append(p); } list.append(n); }
}
async function uploadItem(item) {
  if (item.busy) return; item.busy = true; item.error = null; renderUploads(); const epoch = S.epoch;
  try {
    if (!item.attachment) item.attachment = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', `${S.base}/api/conversations/${encodeURIComponent(item.conversation)}/attachments`); xhr.setRequestHeader('Authorization', `Bearer ${S.token}`); xhr.timeout = 300000; item.xhr = xhr;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.progress = Math.round(e.loaded / e.total * 100); renderUploads(); } };
      xhr.onerror = () => reject(new Error('上传失败，请检查网络后重试。')); xhr.ontimeout = () => reject(new Error('上传超时，请重试。')); xhr.onabort = () => reject(new Error('上传已取消。'));
      xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { reject(new Error('上传未完成，请重新上传。')); return; } if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(friendlyDetail(data.detail, xhr.status))); };
      const form = new FormData(); form.append('file', item.file); xhr.send(form);
    });
    if (S.epoch !== epoch) return;
    const result = await post(`/api/conversations/${encodeURIComponent(item.conversation)}/messages`, { text: '', attachment_id: item.attachment.id, client_id: item.client_id });
    S.uploads.delete(item.id); if (S.selected === item.conversation) { mergeMessage(result); scrollBottom(); markRead(); } await refreshConversations();
  } catch (e) { if (S.epoch === epoch) { item.error = errorText(e); toast(`${item.file.name}：${item.error}`); } }
  finally { item.busy = false; item.xhr = null; renderUploads(); }
}
function connection(state) { const label = state === 'online' ? '已连接' : state === 'offline' ? '正在重连' : '正在连接'; $('connection-dot').classList.toggle('offline', state !== 'online'); $('connection-dot').title = label; $('connection-dot').setAttribute('aria-label', label); $('connection-text').textContent = label; $('connection-text').hidden = state === 'online'; }
async function connectSocket() {
  if (!S.token) return; clearTimeout(S.reconnect); const epoch = S.epoch;
  if (S.socket) { S.socket.onclose = null; S.socket.close(); S.socket = null; } clearInterval(S.ping); connection('connecting');
  try {
    const { ticket } = await post('/api/ws-ticket'); if (epoch !== S.epoch) return;
    const url = new URL(`${S.base}/api/ws`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('ticket', ticket);
    const socket = new WebSocket(url); S.socket = socket;
    socket.onopen = async () => { if (epoch !== S.epoch) return; S.retry = 0; connection('online'); S.ping = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 25000); try { await refreshConversations(); if (S.selected && !S.historyBusy) await loadMessages(false); } catch (e) { toast(errorText(e)); } };
    socket.onmessage = async (event) => { if (epoch !== S.epoch) return; let data; try { data = JSON.parse(event.data); } catch { return; } if (data.type === 'message' && data.message) { const m = data.message; if (m.conversation_id === S.selected) { mergeMessage(m); markRead(); } refreshConversations().catch(() => {}); } else if (data.type === 'conversation') refreshConversations().catch(() => {}); };
    socket.onclose = () => { if (epoch === S.epoch) scheduleReconnect(); }; socket.onerror = () => socket.close();
  } catch { if (epoch === S.epoch && S.token) scheduleReconnect(); }
}
function scheduleReconnect() { clearInterval(S.ping); connection('offline'); clearTimeout(S.reconnect); const delay = Math.min(30000, 1000 * (2 ** S.retry++)); S.reconnect = setTimeout(connectSocket, delay); }
function logoutLocal() {
  S.epoch++; S.token = null; S.me = null; S.details = false; clearTimeout(S.reconnect); clearInterval(S.ping); clearInterval(S.refresh);
  if (S.socket) { S.socket.onclose = null; S.socket.close(); S.socket = null; } S.requests.forEach((c) => c.abort()); S.uploads.forEach((i) => i.xhr?.abort()); S.conversations = []; S.users = []; S.messages = []; S.pending.clear(); S.uploads.clear(); S.selected = null; S.historyBusy = false;
  $('app-view').hidden = true; $('login-view').hidden = false; $('active-chat').hidden = true; $('empty-chat').hidden = false; $('details-panel').hidden = true; $('message-items').replaceChildren(); $('upload-list').replaceChildren(); $('password').value = ''; $('modal').close(); $('image-modal').close(); $('conversation-search').value = '';
}
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('login-error').hidden = true; $('login-submit').disabled = true;
  try {
    S.base = normalizeBase($('server-url').value.trim()); const result = await post('/api/login', { username: $('username').value.trim(), password: $('password').value }); S.epoch++; S.token = result.token; S.me = result.user; S.retry = 0;
    savePreference('teamrelay.server', S.base); savePreference('teamrelay.username', $('username').value.trim()); $('password').value = '';
    [S.conversations, S.users] = await Promise.all([api('/api/conversations'), api('/api/users')]); $('my-avatar').textContent = (S.me.display_name || S.me.username).slice(0, 1); $('my-avatar').title = S.me.display_name;
    $('login-view').hidden = true; $('app-view').hidden = false; renderConversations(); connectSocket();
    S.refresh = setInterval(() => { if (S.token && !document.hidden) refreshConversations().catch(() => {}); }, 30000);
  } catch (error) { if (S.token) logoutLocal(); if (/地址/.test(errorText(error))) $('connection-settings').open = true; $('login-error').textContent = errorText(error); $('login-error').hidden = false; }
  finally { $('login-submit').disabled = false; }
});

function openModal(title) { const content = $('modal-content'), header = el('div', 'modal-header'), body = el('div', 'modal-body'), footer = el('div', 'modal-footer'); header.append(el('h2', '', title), iconButton('close', '关闭', () => $('modal').close())); content.replaceChildren(header, body, footer); if (!$('modal').open) $('modal').showModal(); return { body, footer }; }
function modalError(body) { const error = el('div', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert'); body.append(error); return (e) => { error.textContent = errorText(e); error.hidden = false; }; }
function field(body, label, type = 'text', id, placeholder = '') { const wrap = el('div', 'field'), text = el('label', '', label), input = el('input'); input.type = type; input.id = id; input.placeholder = placeholder; text.htmlFor = id; wrap.append(text, input); body.append(wrap); return input; }
async function openNewConversation(preselected) {
  try { S.users = await api('/api/users'); } catch (e) { toast(errorText(e)); return; }
  const { body, footer } = openModal('新聊天'), tabs = el('div', 'choice-tabs'); let direct = true, selected = new Set(preselected ? [preselected] : []);
  const directButton = button('私聊', 'selected', () => { direct = true; if (selected.size > 1) selected = new Set([...selected].slice(0, 1)); update(); }), groupButton = button('群聊', '', () => { direct = false; update(); }); tabs.append(directButton, groupButton); body.append(tabs);
  const title = field(body, '群聊名称', 'text', 'new-conversation-title', '例如：产品与研发'); title.maxLength = 80; const titleWrap = title.parentElement;
  const label = el('p', 'field-label', '选择成员'), options = el('div', 'user-options'); body.append(label, options);
  const showError = modalError(body), submit = button('开始聊天', 'primary', async () => {
    if (!selected.size) { showError(new Error('请至少选择一位团队成员。')); return; } if (!direct && !title.value.trim()) { showError(new Error('请填写群聊名称。')); return; }
    submit.disabled = true;
    try { const c = await post('/api/conversations', { title: direct ? '' : title.value.trim(), member_ids: [...selected], is_direct: direct }); await refreshConversations(); $('modal').close(); selectConversation(c.id); } catch (e) { showError(e); } finally { submit.disabled = false; }
  }); footer.append(button('取消', 'secondary', () => $('modal').close()), submit);
  function update() { directButton.classList.toggle('selected', direct); groupButton.classList.toggle('selected', !direct); titleWrap.hidden = direct; options.replaceChildren();
    for (const u of S.users.filter((u) => u.id !== S.me.id)) { const row = button('', `user-option${selected.has(u.id) ? ' selected' : ''}`, () => { if (selected.has(u.id)) selected.delete(u.id); else { if (direct) selected.clear(); selected.add(u.id); } update(); }); row.dataset.userId = u.id; const copy = el('span', 'user-option-copy', nameFor(u)); copy.append(el('small', '', u.is_bot ? '助手' : u.username)); const mark = el('span', 'selection-mark'); if (selected.has(u.id)) mark.append(icon('check')); row.append(avatar(u), copy, mark); options.append(row); } if (!options.children.length) options.append(el('p', 'list-empty', '还没有其他成员，请联系管理员添加。')); }
  update();
}
async function openMembers() {
  try { S.users = await api('/api/users'); } catch (e) { toast(errorText(e)); return; }
  const { body, footer } = openModal('成员'); const list = el('div', 'member-directory');
  for (const u of S.users) { const row = el('div', 'directory-item'), copy = el('div', 'directory-item-copy'); copy.append(el('strong', '', `${nameFor(u)}${u.id === S.me.id ? '（我）' : ''}`), el('small', '', u.is_bot ? '助手' : u.username)); row.append(avatar(u), copy); if (u.id !== S.me.id) row.append(iconButton('chat', `与${nameFor(u)}聊天`, () => openNewConversation(u.id))); list.append(row); } body.append(list); if (S.me.is_admin) footer.append(button('添加成员', 'primary', openCreateUser, 'plus')); else footer.append(button('关闭', 'secondary', () => $('modal').close()));
}
function openSettings() {
  const { body, footer } = openModal('设置');
  for (const [label, value] of [['账号', S.me.username], ['团队地址', S.base]]) { const row = el('div', 'settings-row'); row.append(el('span', '', label), el('span', '', value)); body.append(row); }
  const actions = el('div', 'settings-actions'); if (S.me.is_admin) { actions.append(button('添加成员', 'settings-action', openCreateUser, 'users'), button('连接助手', 'settings-action', openBotToken, 'spark')); } actions.append(button('重新连接', 'settings-action', () => { connectSocket(); $('modal').close(); toast('正在重新连接。'); }, 'refresh')); body.append(actions); footer.append(button('完成', 'primary', () => $('modal').close()));
}
function openCreateUser(asAssistant = false) {
  const { body, footer } = openModal('添加成员');
  const username = field(body, '账号', 'text', 'new-user-username', '英文、数字、下划线或短横线'), name = field(body, '昵称', 'text', 'new-user-name', '聊天中显示的名字'), password = field(body, '密码', 'password', 'new-user-password', '10–200 个字符'); password.autocomplete = 'new-password'; password.minLength = 10; password.maxLength = 200;
  const row = el('label', 'checkbox-row'), bot = el('input'); bot.type = 'checkbox'; bot.id = 'new-user-bot'; bot.checked = asAssistant === true; row.append(bot, document.createTextNode('助手账号')); body.append(row); const showError = modalError(body);
  const submit = button('创建账号', 'primary', async () => { if (password.value.length < 10 || password.value.length > 200) { showError(new Error('密码长度需要为 10–200 个字符。')); return; } submit.disabled = true; try { const u = await post('/api/admin/users', { username: username.value.trim(), display_name: name.value.trim(), password: password.value, is_bot: bot.checked }); password.value = ''; S.users = await api('/api/users'); toast(`已创建 ${u.display_name}`); openMembers(); } catch (e) { showError(e); } finally { submit.disabled = false; } }); footer.append(button('取消', 'secondary', () => $('modal').close()), submit);
}
async function openBotToken() {
  try { S.users = await api('/api/users'); } catch (e) { toast(errorText(e)); return; }
  const { body, footer } = openModal('连接助手');
  const bots = S.users.filter((u) => u.is_bot); if (!bots.length) { body.append(el('p', 'modal-description', '请先添加一个助手账号。')); footer.append(button('添加助手', 'primary', () => openCreateUser(true))); return; }
  const wrap = el('div', 'field'), label = el('label', '', '选择助手'), select = el('select'); select.id = 'bot-token-user'; label.htmlFor = select.id; bots.forEach((u) => { const option = el('option', '', nameFor(u)); option.value = u.id; select.append(option); }); wrap.append(label, select); body.append(wrap, el('p', 'modal-description', '连接后，助手可查看所在聊天的消息和文件。')); const showError = modalError(body);
  const generate = button('生成连接码', 'primary', async () => { generate.disabled = true; try { const { token } = await post(`/api/admin/users/${encodeURIComponent(select.value)}/token`); body.replaceChildren(el('p', 'token-warning', '连接码仅显示一次，90 天内有效。请妥善保存，不要分享。')); const output = el('textarea', 'token-display'); output.value = token; output.readOnly = true; output.setAttribute('aria-label', '连接码'); body.append(output); footer.replaceChildren(button('复制', 'secondary', async () => { try { await navigator.clipboard.writeText(token); toast('已复制。'); } catch { output.focus(); output.select(); toast('请按 Ctrl+C 复制。'); } }), button('完成', 'primary', () => $('modal').close())); } catch (e) { showError(e); generate.disabled = false; } }); footer.append(button('取消', 'secondary', () => $('modal').close()), generate);
}

$('new-chat').addEventListener('click', () => openNewConversation()); $('empty-new-chat').addEventListener('click', () => openNewConversation()); $('nav-members').addEventListener('click', openMembers); $('nav-settings').addEventListener('click', openSettings); $('nav-chats').addEventListener('click', () => $('modal').close());
$('nav-logout').addEventListener('click', async () => { try { await post('/api/logout'); } catch { /* Always discard local credentials. */ } logoutLocal(); });
$('conversation-search').addEventListener('input', renderConversations); $('toggle-details').addEventListener('click', () => { S.details = !S.details; renderDetails(); }); $('load-history').addEventListener('click', () => loadMessages(true).catch((e) => toast(errorText(e))));
for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) $('messages').addEventListener(event, () => { S.scrollIntent++; }, { passive: true });
$('composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(); }); $('message-input').addEventListener('input', updateCounter); $('message-input').addEventListener('compositionstart', () => { S.composing = true; }); $('message-input').addEventListener('compositionend', () => { S.composing = false; }); $('message-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !S.composing && e.keyCode !== 229) { e.preventDefault(); sendText(); } });
$('mention-assistant').addEventListener('click', () => { const input = $('message-input'); const start = input.selectionStart, end = input.selectionEnd; input.setRangeText('@dsh ', start, end, 'end'); input.focus(); updateCounter(); });
function pickFiles(accept = '') { if (!S.selected) return; $('file-input').accept = accept; $('file-input').value = ''; $('file-input').click(); }
$('attach-file').addEventListener('click', () => pickFiles()); $('attach-image').addEventListener('click', () => pickFiles('image/*')); $('attach-media').addEventListener('click', () => pickFiles('audio/*,video/*')); $('file-input').addEventListener('change', (e) => queueFiles([...e.target.files]));
let dragDepth = 0;
$('chat-area').addEventListener('dragenter', (e) => { if (!e.dataTransfer.types.includes('Files')) return; e.preventDefault(); dragDepth++; if (S.selected) $('drop-overlay').hidden = false; }); $('chat-area').addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }); $('chat-area').addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } }); $('chat-area').addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; if (e.dataTransfer.files.length) queueFiles([...e.dataTransfer.files]); });
// Prevent file-drop navigation anywhere outside the chat area, too.
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }); window.addEventListener('drop', (e) => e.preventDefault());
$('close-image').addEventListener('click', () => $('image-modal').close()); $('image-modal').addEventListener('click', (e) => { if (e.target === $('image-modal')) $('image-modal').close(); }); $('image-modal').addEventListener('close', () => $('preview-image').removeAttribute('src')); $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').close(); }); $('modal').addEventListener('close', () => { if (!$('modal').open) $('modal-content').replaceChildren(); });
window.addEventListener('online', () => { if (S.token) connectSocket(); }); document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token) { refreshConversations().catch(() => {}); if (S.socket?.readyState !== WebSocket.OPEN) connectSocket(); } });
$('server-url').value = readPreference('teamrelay.server') || (['http:', 'https:'].includes(location.protocol) ? location.origin : 'http://127.0.0.1:18200'); $('username').value = readPreference('teamrelay.username');
$('connection-settings').open = !readPreference('teamrelay.server');
