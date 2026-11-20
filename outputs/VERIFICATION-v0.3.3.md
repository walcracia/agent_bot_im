# 同频TeamPlay v0.3.3：托盘实现与QA Trigger/Route设计

日期2026-11-20，Windows，基线0529feb（安全ff同步后）。本文件为提交前快照，最终远端branch/tag/Release按最新HANDOFF与查询确认。

## 实际交付范围

- Windows实现：最小化保留任务栏，关窗隐藏到托盘；点击/双击恢复、右键打开/退出，单用户目录单实例；后台未读托盘900ms交替标记与flashFrame请求；回到前台停止闪烁，未读以服务器为准，后台当前会话也不自动标读。
- sandbox/contextIsolation保持；新增preload只暴露未读数量与前台回调，严格sender/main frame/本地URL和输入校验，不传令牌/消息正文，不开放通用IPC。退出登录清除提醒；客户端退出不操作独立服务器/DSH。
- QA日志部分仅设计：定位本机截图插件，核对用户提供skill与QA MCP，记录统一Source→持久Trigger→只读Router→typed LogTriage Worker→输入revision门禁→Outbox→绑定聊天。Thread/订阅、基线/迟到附件/重分析/权限与预算/恢复/证据/验收已写清，未实现该运行通路。
- 没有修改原DSH安装、读取真实缺陷或业务日志、调用真实模型或开启正式QA监听。内网实际地址、真实项目/群/缺陷/凭据与业务内容不进Git。

## 已执行与证据等级

| 验证 | 结果与边界 |
| --- | --- |
| 完整verify.ps1 | Python26通过、桥接Node256通过、桌面生命周期/IPC9通过、模拟Windows启动编排16通过；五个客户端/桌面入口语法通过。Python3.12.16、项目Node24.19.0，1条原有Starlette/httpx弃用警告保留。 |
| verify-desktop-tray-ui.py | 真实临时HTTP/WebSocket/SQLite与Chrome、合成双用户，桌面桥模拟，9项通过/0页面异常。覆盖初始历史、自发/重复、后台当前会话未读、断线补收、返回只读当前会话、读失败保留计数/恢复、焦点故障注入、退出清空及服务清理。焦点注入不是实际OS失焦证据。 |
| verify-desktop-native.py/.mjs | 真实打包Electron45.2.3，临时IM/合成账号/独立TEAMRELAY_PROFILE，7项通过/0页面异常。捕获并透传真正Tray.setImage与BrowserWindow.flashFrame调用；验证隐藏后WS仍达/服务器仍未读、原生click恢复+读取、最小化窗口style/Iconic、其他会话未读、第二真实进程退出并恢复原窗口、退出登录及应用退出。原生事件由Playwright程序驱动，不冒称人工在Windows隐藏图标区点击。 |
| 视觉批次 | 1280×860、960×680窗口各登录/聊天，共4张实际EXE截图；主代理批量查看，无布局修正。截图像素随WindowsDPI缩放，窗口尺寸是逻辑尺寸。 |
| Impeccable | context成功，按狭窄Operate增强；最终app.js机械detect输出[]。石墨CSS/令牌/现有图形保留；本地图标由现有SVG生成。 |
| 包与来源 | 最终ASAR16条目白名单、12个client/桌面/图标文件与源码逐字节相同，manifest0.3.3；PE ProductVersion0.3.3、名称正确。ZIP74文件，CRC及逐文件SHA256完全一致。 |
| QA来源与设计 | 本机插件0.1.0、内嵌skill1.2.0、MCP1.0.5；站点skill1.3.2、registry1.0.6只读核对。未运行parser/模型；Desktop内部UI路由不可当公开后台API，QA增量分页/正文/时钟语义仍待专项验证。 |

最终ZIP：162,325,631字节；SHA256 `135e0a477329513c18a183926301e4c5a463005709465530821449a0ed2ffe35`。完整文件夹outputs/desktop-v0.3.3/TeamRelay-win32-x64，包outputs/TeamRelay-portable.zip，校验SHA256SUMS-v0.3.3-portable.txt。测试/图标生成器/QA插件/DSH/账号/日志不在ASAR。

## 测试夹具问题与修正

- 新浏览器夹具初版wait_for_function触发严格CSP中的eval拒绝；改为自动化端有界轮询+evaluate，没有添加unsafe-eval或更改产品CSP。一次driver初始化连接关闭另行保留，后续独立driver_ready探针通过，未确证该次瞬时原因。
- headless新页bring_to_front未使旧页document.hasFocus变false，故其预期不是可靠的真实失焦证据。改成明确标注的焦点故障注入验证两重门禁；真实窗口焦点/隐藏/恢复由原生测试独立覆盖。各失败JSON和日志保留，不改写为首轮通过。
- 原生夹具误以为最小化时Electron.isVisible必为true。实际返回false但isMinimized为true；未发现产品hide调用。改用只读user32窗口样式确认WS_VISIBLE、Iconic、无owner且非toolWindow，随后全部原生用例通过，没有放宽产品行为。
- ASAR校验初版用正斜杠读取多层assets路径，Windows库查找失败；白名单列表和原生图标加载此前已通过。使用平台join规范化路径后12文件字节比对通过，未修改产物掩盖错误。

原始本机证据在忽略的environment/logs与environment/verification/{desktop-tray-ui,desktop-native-v0.3.3,desktop-artifacts-v0.3.3}，不提交原始日志/截图或凭据。旧0.3.2 ZIP先hash核对后保留为独立本地历史包；没有覆盖既有Release/tag。

## 未执行项与剩余边界

QA真实读取/下载/解析/模型/聊天回传整链未执行，自动监听与typed日志运行模块尚未实现；未更新或安装用户DSH/skill。没有正式IM/DSH/Watchdog启动、腾讯部署、安全隔离实现或已知A1/A2修复。旧13项浏览器全流程未在本轮重跑，不混入本轮通过统计。Windows托盘具体位置和系统闪烁展示受OS设置影响；未做人工系统托盘点选或多显示器/休眠长期运行验收。

所有临时服务/隔离客户端按夹具清理，结束后本项目0.3.3测试EXE与18200/18202监听未见存活。正常用户已有程序不被终止。
