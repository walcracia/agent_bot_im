'use strict';
const pages = {
  login: { title:'紧凑登录', note:'移除半屏标语，品牌与登录表单集中呈现。团队地址首次显示，登录记忆后可折叠。', label:'新版登录', sizes:[1280,960,375], file:'login', alt:'新版同频登录页，居中的品牌和登录表单' },
  chat: { title:'把空间留给聊天', note:'紧凑输入区只保留附件、助手和发送；连续消息成组，单条时间通过时钟入口查看。', label:'新版聊天', sizes:[1280,960], file:'chat', alt:'新版同频聊天页，连续消息减少重复头像和姓名，底部为紧凑输入区' },
  attachments: { title:'一个附件入口', note:'文件、图片、音频或视频收在同一个菜单内，保留原有上传类型。', label:'附件菜单展开', sizes:[1280], file:'attachment-menu', alt:'同频聊天页的附件菜单展开，显示文件、图片、音频或视频选项' },
  members: { title:'从成员直接开始聊天', note:'保留成员目录与聊天图标；点击同事的聊天按钮直接进入私聊，已有私聊复用。截图显示合成测试成员。', label:'成员目录', sizes:[1280], file:'members', alt:'同频成员目录，每位合成测试成员旁保留聊天按钮' },
  settings: { title:'低频操作留在设置', note:'账号、团队地址、添加成员与连接助手按需查看，不占据日常聊天区。截图不包含连接码或密码。', label:'设置', sizes:[1280], file:'settings', alt:'同频设置弹窗，显示测试账号和本机临时地址及设置操作' }
};
let active = 'login';
const image = document.getElementById('screen');
const size = document.getElementById('size');
const compare = document.getElementById('compare');
const heights = {1280:860,960:680,375:812};
function render() {
  const page = pages[active];
  if (!page.sizes.includes(Number(size.value))) size.value = String(page.sizes[0]);
  for (const option of size.options) option.disabled = !page.sizes.includes(Number(option.value));
  const width = Number(size.value), source = `images/${page.file}-${width}.png`;
  document.getElementById('page-title').textContent = page.title;
  document.getElementById('page-note').textContent = page.note;
  document.getElementById('screen-caption').textContent = `${page.label} ${width} × ${heights[width]}`;
  image.src = source; image.alt = page.alt; image.width = width; image.height = heights[width];
  document.getElementById('screen-link').href = source;
  const allowComparison = active === 'login' && width === 1280;
  compare.disabled = !allowComparison;
  if (!allowComparison) compare.checked = false;
  document.getElementById('before-figure').hidden = !compare.checked;
  document.getElementById('screens').classList.toggle('comparing', compare.checked);
  for (const button of document.querySelectorAll('nav button')) button.setAttribute('aria-pressed', String(button.dataset.page === active));
}
document.querySelectorAll('nav button').forEach(button => button.addEventListener('click',()=>{ if (!pages[button.dataset.page]) return; active = button.dataset.page; render(); }));
size.addEventListener('change',render);
compare.addEventListener('change',render);
render();
