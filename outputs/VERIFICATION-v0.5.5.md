# v0.5.5 自然 QA Trigger 验证

2026-11-25，所有业务正文、账号、附件和原生会话只留本机忽略目录。对应设计：`workspace/docs/TRIGGER-INTENT-v0.5.5.md`。

## 实际业务

- 截图中的原消息147曾因监听已退出而未消费。恢复后原消息只处理一次，真实分页读取绑定项目，回答近7天新增、当前未关闭数量及最近编号，时间范围和数据直接来自QA；具体业务数据仅留本机。没有将未知日期或访问失败说成零Bug。
- 另两条真实中文问句：口语近况经原生只读Qwen4Max/High分类，进度查询读本聊天账本；各一条回复，任务数量、输入版本和attempt均不变。原生request/header、中文提示、typed返回、turn/end completed与exit0已核实。分类的自动标题请求单列，不冒充分类请求；没有为查询启动日志分析。
- 当前源重新分析一个已有Bug：r5/attempt7，经IM消息153、原Typed Router、ZIP+PNG完整下载/hash、原插件Skill1.3.2准备、Qwen4Max/High完成，再一条原结论+完整TXT回原聊天。原system/user提示逐字核对，PNG不新增OCR，不改写Skill结论。
- 原生模型请求1次，约98.8秒，输入85891/output9850/总95741 tokens；报告成员认证下载14802B，SHA256 `5a48dd572dbde16ce79727cc7e8ba4756abc8509522cece6a2d01014906fd8b9`。真实QA收据SHA `2b3cb5bf9fef6db959837399f80b8134cf3b7cc00427359fb7e9cf8821e27dd1`，产品源指纹 `25cfac9447e137f65d90f0dc701735d0844ea2092307cede317be2127085e576`。

## 监听与回归

昨日Windows资源耗尽事件2004与监听clone OOM相邻，系统提交量约60.27/60.30GB。状态约6.7MB，隔离500次心跳未见GC后持续增长，不能断言账本泄漏。仅本项目降低空轮询/心跳复制开销和心跳排队；不删除旧任务，不修改WSL或其他服务。新监听已消费原游标后的消息，业务/报告完整保留，结束后无活动任务或待发消息。

保留真实失败：第一次并行桥接539项中538过、恢复CIM登记1失败；精确重跑通过，原恢复进程未保存具体注册错误，根因不能完全确证。第二次540项中525过，出现PowerShell OutOfMemoryException及多个子进程启动失败；当时并行回归、真实业务与打包叠加。停止叠加任务，改串行复验，不修改断言、产品权限或分析额度以回避失败。

最终验收：26 Python、9桌面生命周期/权限、540桥接（串行，0跳过）、16模拟Windows编排及全部语法检查通过。桥接串行约365秒；不改断言或超时，前两次整体失败记录继续保留。

## Windows 交付

v0.5.5实际构建并通过ASAR16项白名单/12源文件字节、PE x64和产品名版本、ZIP74文件CRC/逐文件hash及隔离实际Electron8项：登录、聊天、托盘、通知、报告下载。构建强制核对本版真实QA收据，打包后再核产品源未变。

ZIP 162325625B，SHA256 `c25853aa994f72fc30eeb9935265ad2ec28b874dd2ca4c191459fb4553abdca4`。本机`outputs/desktop-v0.5.5/TeamRelay-win32-x64/TeamRelay.exe`，必须保留整个便携目录；包不含后台、三Agent或任何账号。源码9b2aa31a484a4147feb014f3cde65942c66b6db8及新annotated v0.5.5远端已核对。正式Release ID457601539、draft=false，两资产uploaded，size和digest与本地逐一相符；下载https://github.com/walcracia/agent_bot_im/releases/tag/v0.5.5。最终重复start实查复用0.5.5服务和真实监听ready，无任务重放。

旧A1/A2编码任务、Hermes旧failed-session原生恢复等边界继续保留；本轮不自动重做旧取消/未知终态任务。最近N天查询与已有精确控制可用，未支持日历范围会追问天数；未启用绑定的项目不会扩权查询。
