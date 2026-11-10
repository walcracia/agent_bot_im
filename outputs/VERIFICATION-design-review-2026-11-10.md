# 四套风格审核预览验收

2026-11-10，项目D:/Work/CodexProjects/agent-bot-im，从远端main fd1238c安全快进后开发。用户调用Hallmark要求几套配色和设计风格供审核；本次只交付独立预览，产品版本仍0.3.0。

- 方案：A霁蓝、B暖砂、C石墨、D暮紫；同一真实客户端DOM/JS副本、同一组五条合成演示消息，提供聊天与紧凑登录、四图对照及单套可操作预览。固定清单复制，原client/desktop文件零改动。
- `node environment/scripts/build-design-review.mjs`可再生成HTML/JS/CSS；`environment/scripts/preview-designs.ps1`在127.0.0.1:18310提供仅审核目录的静态服务，不暴露仓库/环境目录，不启动IM/DSH或读真实聊天数据。
- `environment/venv/Scripts/python.exe environment/scripts/verify-design-review.py --round initial`：16截图、280检查全通过。一次批量视检/集中修正后`--round confirm`：16截图、288检查全通过，零页面异常、零外部请求。尺寸为1280×860、960×680。
- 实际最低文字对比度5.574:1，边界/通用焦点3.705:1，真实Tab进入导航栏的焦点环最低4.522:1；四套消息文本相同，消息时间键盘、单附件菜单、成员与设置可达。
- 审核页真实浏览器额外7项通过：4缩略图加载、4套可操作iframe切换、登录对照及回总览、关闭JavaScript后静态四图仍可见。输入只进入预览内存；不将演示发送视作真实网络发送。
- Hallmark2.0.0 `sloplint ... --scope app --genre modern-minimal --render --url http://127.0.0.1:18310/index.html`：最终0 FAIL、0 REFLEX、0 WARN，2 WAIVED、3 DISMISSED。两项Reflex为会话两行选择器高度、ellipsis全文Range误计边缘；静态合并主题颜色误报用实际对比度核验，stamp/HALLMARK.md记录具体理由。
- 独立fresh-context finish review首词fix，两项意见（暮紫日期顶边、选择回复位置）已解决。原始报告/失败在environment/verification/design-review-2026-11-10及忽略的.hallmark；可分享的16张截图和总览在审核目录images。

## 失败和修正

首次静态扫描的spacing token与现有尺寸冲突、离4px尺度的新增间距已改；渲染依赖起初缺失，随后在忽略目录安装puppeteer-core25.16.0，使用本机Chrome真实渲染。增加演示标记时一次PowerShell转义导致JS语法错误，被渲染扫描拦截并修正。后续扫描发现浅色导航沿用原深色rail的白色focus环，预览增加具体focus-visible覆盖并实测>=3:1。未更改/放宽原生产测试，不把早期未渲染或失败结果算通过。

## 交付边界

未应用某套主题到生产、未重建Windows EXE、未运行真实模型或后台任务。16截图使用真实前端逻辑和合成内存API，不能当作IM后端/真实上传/DSH端到端验收。待用户在当前Codex对话选择A/B/C/D后，再实施产品主题、完整回归和新App交付。

本次按新annotated审核tag v0.3.0-design-review.1提交并上传；是否上传以Git远端查询为准，不移动既有发布tag。
