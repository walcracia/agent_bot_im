# Hallmark 审核记录

**Hallmark · v2.0.0**

- **Screen**：聊天、紧凑登录；真实客户端DOM/JS固定清单副本，genre modern-minimal，scope app，深度restyle。
- **Theme**：A霁蓝为现有品牌对照；B暖砂取Furrow纸面/利落边界；C石墨取Console深灰/琥珀/紧凑密度；D暮紫取Dusk石板/雾紫/柔和圆角。用户明确要求批量方案，因此一次deal的三方向都进入独立审核，不替用户提前定稿。
- **Chrome**：保留图标导航、会话侧栏、聊天头部、单附件入口、输入和发送；审核工具只在独立gallery。
- **Signature**：同一组五条演示消息，在四套视觉系统中对比。变化包括导航明暗、选中形式、行距、圆角和消息表面，不只换主色。
- **Material**：真实：同频现有界面、字段、图标、功能与蓝色设计；合成：四成员和演示消息；pictures：实际浏览器渲染截图；absent：真实团队聊天、凭据、用户照片、评价、宣传指标。
- **Files**：新建outputs/design-review-2026-11-10及构建/验收/预览脚本；产品workspace/client和桌面包零修改；删除产品文件零个。
- **Sweep**：sloplint app scope渲染，最终0 FAIL、0 REFLEX、0 WARN；两项Reflex在stamp有guard和理由，三项多主题静态颜色警告由实际浏览器对比度核验后记录DISMISSED。

## Pre-flight

| 依据 | 保留 | 引入 |
| --- | --- | --- |
| workspace/client/tokens.css:3 | Segoe UI / Microsoft YaHei系统中文字体 | 四套语义令牌，分开primary-ink和surface |
| workspace/client/index.html:17 | 紧凑登录字段、可折叠地址 | 同屏审核登录 |
| workspace/client/index.html:29 | 图标导航、会话/消息/附件/成员/设置 | URL选择主题与界面 |
| workspace/docs/UI-v0.1.3.md:1 | 现有蓝色作为对照 | 供用户选择的暖色、暗色方向 |

deal：prompt-0083·2eb3fb4f·2026-11-10·r0，Console/Furrow/Dusk三张参考图均已查看。app scope使用主题的色彩/表面/圆角，不使用营销布局、风景照片、Hero或技术装饰。

## 判定与边界

- 39b：会话选择按钮是含姓名、预览、时间的两行列表，不按工具栏按钮高度压缩；搜索真实输入有44px父级点击区域。
- 72：会话摘要使用单行ellipsis。Range包含被裁掉的文本，误把它计到按钮边缘；实际可见行保留16px水平内边距。
- 40/41：静态分析合并多个主题变量会产生不在某个实际主题中的组合；实测四套正文、次要文字、按钮、自身气泡、边界、焦点及rail键盘焦点。导航仅为图标，阈值3:1，文字为4.5:1。
- 修正：新版浅色rail曾继承旧深色rail的白焦点环；已在预览用更具体的focus-visible规则改为主题焦点色。Dusk缩减消息留白，避免960×680日期被顶边截掉。审核说明明确“当前Codex对话”，避免把选择输入内存演示聊天。
- 独立finish review首词fix，两项视觉/文案意见已纳入集中修正。首轮与确认轮的真实结果见outputs/VERIFICATION-design-review-2026-11-10.md；不把预览动作等同真实网络发送或后台端到端验收。

素材齐全，无照片占位槽。用户下一步只需在Codex对话选A/B/C/D；选定后再将方向落地到产品并做完整回归/Windows打包。

用户现已选择C；本目录client副本在v0.3.1同步规则齿轮与石墨产品代码。原四套截图仍是4c35066初始审核证据，当前单套C可操作预览显示新图标；正式产品验收见VERIFICATION-v0.3.1.md。
