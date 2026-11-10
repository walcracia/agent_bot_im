# Super-agent复审与Windows桌面包说明

审计日期：2026-11-10（Asia/Shanghai）。源码基线：`dad375d5b37023e45c6120fbc14da7841950b1c8`，产品/桌面版本0.3.1。后续审计记录提交不改变此源码基线。

**结论：已有Router/并行Worker/语义监督/GitHub交付的核心结构，但不能称为完整符合原文，也不能把历史模块验收表述成全链路自主运行验收。** 本次还复现了交付期新要求未消费、可修改的可信测试入口等具体缺陷。本报告覆盖此前“全部补齐”的过宽判断；历史通过结果仍保留其原范围。

本次仅审计、复现与文档交付，没有修改产品源码或正式配置、启停正式服务、调用真实DSH模型、写入远端测试PR或开始Tauri迁移。10项合成探针包含发布恢复的两次独立交叉复核；“问题复现成功”不等于产品功能通过。

## 1. 当前EXE与后台启动关系

现在是 **Electron 45.2.3**，不是Tauri。`workspace/package.json`固定Electron和packager；`workspace/desktop/main.cjs`创建BrowserWindow并载入本地HTML，没有启动PowerShell、Python、控制器或DSH的代码。

| 启动方式 | 实际作用 |
| --- | --- |
| 双击`TeamRelay.exe` | 自动执行包内`desktop/main.cjs`和前端JS，打开聊天界面，连接已有IM服务器 |
| 运行`environment/scripts/start.ps1` | 启动或复用并核验IM与已绑定DSH；Super模式另核验独立Watchdog。首次未绑定机器另用ServerOnly建立账号 |
| 关闭聊天窗口 | 退出桌面客户端，独立后台任务不随窗口退出 |

**EXE不会自动执行`start.ps1`。** v0.2.1实现的是脚本统一启动，不是桌面EXE统一启动。当前服务在线来自此前单独执行启动脚本。`desktop/build.cjs`只复制client、desktop/main.cjs和最小package.json，服务器/DSH/启动脚本不在客户端包内。这是用户所问“双击App同步绑定后台”的实际缺口，不应再用“默认start联动”掩盖。

2026-11-10 17:39本次实查：18200健康接口返回ok/0.3.1；控制器PID33452身份存活、listening/super-agent/ready；独立Watchdog PID28048身份存活。本机配置为local、最多2任务、worker两小时、分类两分钟、一个授权群/三名授权成员，自动合并策略verified-tests。当前Super账本0任务/0活动；这是观察快照，重启或换机器必须重新核验，不是后台随EXE启动的证据。

## 2. 压缩包为什么大、文件分别做什么

实测当前v0.3.1：ZIP **162,326,214字节（162.3 MB）**；程序目录73文件合计 **374,112,472字节（374.1 MB，约356.8 MiB）**，ZIP另含一个说明文件。`TeamRelay.exe`本身249,831,936字节；真正的应用代码资源`resources/app.asar`只有88,232字节。主要体积来自随Electron分发的浏览器/JS运行环境，而非聊天记录或DSH模型。

| 文件/目录 | 用途 |
| --- | --- |
| `TeamRelay.exe` | 同频的桌面入口，包含Electron、Chromium与Node运行支持 |
| `resources/app.asar` | 同频应用本身：HTML、CSS、前端JS、窗口入口及版本信息 |
| `locales/`、`icudtl.dat` | Chromium语言包及Unicode/国际化数据 |
| `resources.pak`、`chrome_100_percent.pak`、`chrome_200_percent.pak` | 浏览器内部资源与不同显示缩放的资源 |
| `ffmpeg.dll` | 音视频解码支持 |
| `d3dcompiler_47.dll`、`dxcompiler.dll` | Windows图形渲染所需的着色器编译支持 |
| `vulkan-1.dll`、`vk_swiftshader.dll`、`vk_swiftshader_icd.json` | Vulkan及软件图形渲染/兼容回退 |
| `snapshot_blob.bin`、`v8_context_snapshot.bin` | JS引擎启动快照；不是用户聊天备份 |
| `electron_wer.dll` | Windows错误报告/崩溃支持 |
| `LICENSE`、`LICENSES.chromium.html`、`version` | 运行时与第三方许可、运行时版本 |

应完整解压便携目录后运行，不能只复制EXE。用户截图位于ZIP浏览视图中；“全部解压缩”即为完整解压入口。文件角色与Electron官方[应用分发说明](https://www.electronjs.org/docs/latest/tutorial/application-distribution)一致。

## 3. Tauri可行性与范围

**可以迁移，而且当前客户端适合优先替换桌面外壳、复用既有HTML/CSS/JS。** 服务器、消息协议、DSH协调层不需要因更换窗口外壳全部重写。需要实现或复验文件保存/下载、窗口权限、媒体播放、跨源请求与WebSocket、CSP、用户配置保存等差异。

按[Tauri架构](https://v2.tauri.app/concept/architecture/)，Windows使用系统WebView2，可避免每个客户端包重复携带整套Chromium，因此有明显瘦身空间。但[Tauri Windows打包说明](https://v2.tauri.app/distribute/windows-installer/)有不同WebView2分发模式：借助已安装运行时或在线引导器较省包体，捆绑离线/固定运行时会增加体积。尚未做Tauri构建，不能承诺具体MB，也不能把体积减少等同CPU/内存已验证减少。

“换Tauri”和“自动启动后台”是两项独立工作。建议后续区分普通成员客户端与本机主机模式：成员只连接共享服务；主机模式核验并复用本项目服务器/绑定控制器/监督者，避免每名成员重复拉起worker。关闭界面不能无条件中断正在编码的任务。这只是建议设计，当前尚未实现。

## 4. 对照原文的能力矩阵

依据用户指定的[《Super-agent设计探索：迈向更自主的Agent系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)。本次通过本机HTTP取得完整js_content，全文仅保留忽略目录，不提交转载。官方[研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)自述并不等同文章内部系统，不能把原型特定UI/门槛变成本项目必需要求。

| 原文主题 | 当前结论 | 证据与限制 |
| --- | --- | --- |
| §2/3.1轻量Router、规则过滤再语义判断 | 基础实现 | 群/成员/机器人关系授权，持久准入，分类与编码分离、批处理；Router可由多Session或程序组成，逐次新分类Session本身不判失败 |
| §2多Worker并发与任务连续性 | 基础实现 | 独立worktree/分支/native session、并行预算；历史真实双任务及原会话接续证据存在 |
| §3.2 Thread多对多订阅、事件直通 | 部分 | 已绑定PR能fan-out到关联任务，明确#T直接路由；IM仍以整群为Thread，订阅按Trigger记录，没有Worker自主订阅/退订/交回Router接口，新普通IM仍经Router；未实现通用Issue/新PR任务入口 |
| §3.3 Inline/Spill与Router/Worker链式召回 | 部分 | Worker具备鉴权读取及正文/链接续页；IM图缺少Thread/Trigger到Task的回边，内置Router没有图召回工具，分类任务列表固定最后80项 |
| §3.4主动静默核查 | 正常路径实现，恢复有缺陷 | 具体未交办缺陷可先静默核查，无变更/失败不公开；但中途重启会向群发送尚无有效交付的投机任务通知 |
| §4.1全双工、异步ReAct长工具 | 部分 | 外层收消息不等待worker，运行中steer有实际消费回执；交付期有新输入遗漏。远端MCP exec仍等待命令完整退出，不是立即Started再异步回传，未见本机runner显式启用原生异步长工具preset |
| §4.2短IM反馈、结构化交付 | 部分 | 持久Outbox、任务详情/PR/Release链接已实现；结果默认截到1000字符，并未执行文章示例的很短输出限制。文章给出的字数是示例，不当作硬性协议 |
| §5.1存算分离与可替换计算实例 | 固定控制机基础 | 状态/原生会话持久在本机目录，可重启；尚无独立持久会话服务支撑任意计算实例替换。用户明确选择本机，所以未上云不列违约；本机休眠/关机仍停止运行 |
| §5.2无状态执行daemon、多设备及离线环境 | 部分 | 已有鉴权daemon/MCP与固定远端执行；当前单固定URL/项目，无多设备注册、动态环境选择。执行daemon还保留作业/命令账本；离线准备可退避，未知在途副作用保守暂停，不是任意断续在线都自动续跑 |
| §6外部语义Watchdog及自然语言运维 | 部分 | 独立进程、语义判断、预算/冷却/代次校验、安全恢复已实现；本项目自定为只读+有限动作，与文章具有完整工具、可自然语言调查并在线修改策略的Watchdog存在差别 |
| GitHub代码/评审/CI/交付 | 基础闭环存在，有门禁缺陷 | 绑定PR、head校验、有限反馈修复、exact-head合并、版本/Release/资产hash已实现；见下文测试来源、构建HEAD和发布恢复问题 |

原文§8的Router横向分片、跨月长记忆、人机接管、A2A与完善的隐私边界属于开放研究问题，不机械列为本次未完成清单。上述80项历史截断的问题是缺少已有信息的续读入口，不等同要求解决跨月长期记忆。

## 5. 本次具体发现与优先顺序

### A1 · P1：交付期间补充被确认，却可能不被执行

位置：`workspace/bridge/super-coordinator.mjs:276`、`:289`、`:300`、`:540`。

完成worker时只在开始交付前检查未消费输入；进入delivering后，新补充仍回复“补充已加入”，但交付guard只检查停止，交付完成直接写ready/merged，补偿循环只处理running任务。隔离PoC：挂起交付，送入明确#T补充，再释放交付；只启动一次worker，新输入未消费，任务直接merged，也没有后续排队任务。GitHub为假交付对象，不代表真的合并了错误PR。

修复验收应覆盖交付前/提交前/合并前的输入版本核验：合并前有新增要求就停止旧交付并原会话续做；若不可撤销的合并已发生，必须建立可追踪后续任务，不丢消息或冒称处理完成。

### A2 · P1：“可信测试”入口与测试文件可先被worker修改

位置：`workspace/bridge/super-github.mjs:339`、`:350`、`:356`、`:359`；`environment/scripts/verify-task.ps1:47`、`:51`、`:59`。

argv来自可信配置，但脚本和测试内容来自worker可写的任务checkout。前后hash仅防止**验收运行期间**变更，无法防止worker在验收前把测试改弱。生产配置的verify-task脚本也是此类型。

PoC使用真实临时Git/Node、模拟全部gh：基线测试要求value=1，模拟worker把源改999、check改exit0；GitDelivery仍判通过、提交并调用假exact-head合并，原始独立断言真实失败。这不代表现有v0.3.1实际删改过测试或已被攻击；证明自动合并门禁无法保证用户指定的可信测试门槛。应将最低可信runner/断言固定在worker不能改写的基线或独立受控环境，新增/修改的任务测试可另跑，不能自行取代最低门槛。这里审计的是测试来源，不要求把同用户worktree宣称为完整OS隔离。

### A3 · P2：构建后没重新核验固定merge的HEAD

位置：`workspace/bridge/super-release.mjs:110`、`:132`、`:133`。

构建前校验HEAD=merge，构建后只检查相对当前HEAD的未提交diff。受控build命令修改源码并自行commit后，diff为空，ReleasePipeline仍以旧merge为声明发布产物；实际产物包含新HEAD。所有远端行为为mock。当前常规build-portable不会主动commit，故不是本次发布包来源不实的证据；这是固定merge保证的缺口。构建后须重新验证HEAD/索引/树和必要源码指纹仍与固定merge一致，不能只查未提交diff。

### A4 · P2：发布失败后软件缺少显式核验再恢复入口

位置：`workspace/bridge/super-coordinator.mjs:39`、`:448`、`:458`、`:464`。

发布异常存needs_attention，queueRelease拒绝重入；普通“继续修正 #T”仅提示merged任务需描述新需求，重启也不恢复needs_attention。两个独立PoC分别直接guard、完整worker→merged→发布失败→聊天继续→复制账本重启，均未再次进入发布。安全停住合理，但需要让用户显式请求核验既有tag/draft/资产并从原发布账本继续，不能简单自动重试未知副作用。历史v0.3.1由操作者单独调用原pipeline核验draft后续传，是人工补位，不等于现有软件控制面完整。

### A5 · P2：远端取消确认之后，在途write仍可能落盘

位置：`workspace/bridge/super-daemon.mjs:152`、`:170`、`:183`、`:187`。

停止检查只在请求入口；排队中的write不再检查，cancel也不排空写队列。实际HTTP/真实文件系统＋合成pool的慢IO注入：文件hash读取延迟后先取消，返回processTreeStopped:true时文件仍original；放行旧write后HTTP200、内容改变。不是生产事故，影响远端工具模式，本机当前local路线未调用此远端写入。停止必须取消/等待该attempt在途写入并在落盘前核验代次；确认停止后旧attempt不得继续改文件。

### A6 · P2：IM上下文图与Router的续读入口未闭合

位置：`workspace/bridge/super-coordinator.mjs:64`、`:77`、`:80`、`:110`；`workspace/bridge/super-router.mjs:36`、`:73`；`workspace/bridge/super-agent.mjs:131`。

已有Task→Thread，但IM Thread只链接Trigger，Trigger只回Thread。PoC创建两个任务，从IM Thread逐跳可达Task数为0。另以81任务场景确认，最旧T000001不在分类输入/允许返回的ID集合，内置Router无图读取工具。明确#T仍可直达，不能扩大为所有历史任务都丢失；自然语言寻旧任务以及Thread→Worker→其他Thread召回尚缺。

### A7 · P2：静默核查重启后出现无效通知

位置：`workspace/bridge/super-coordinator.mjs:43`。无有效PR的speculative任务，重启前Outbox=0，账本重载initialize后出现一条群中断通知；此路径未保留正常失败路径的静默条件。恢复提示应延续静默门槛，或留给管理员诊断。

此外，IM话题级自主订阅、内部异步长工具、完整工具Watchdog、多设备选择等是矩阵中明确列出的能力差距，不能用上述七项代码修复来代表已全部补全。

## 6. 本次验证与证据边界

三位审计子Agent独立分工，根协调复核源码、脚本、结果，并把脱敏复现脚本纳入Git：

```powershell
# 仓库根目录；Node 24.19.0、Git。仅针对本报告固定源码复现“已知问题”。
node environment/scripts/audit-super-v0.3.1/coordinator-audit.mjs
node environment/scripts/audit-super-v0.3.1/delivery-probes.mjs
node environment/scripts/audit-super-v0.3.1/runtime-probes.mjs
```

这些不是通过标准：脚本成功意味着旧问题被复现，修复后应改为正式回归断言，不能把“问题复现失败”的探针当产品失败。输出只写入忽略的`environment/verification/super-audit-2026-11-10/`；delivery临时Git保留供本机核查，runtime临时夹具精确清理。脚本不发送聊天、不运行DSH、不写外部GitHub，不得在正式任务目录运行另行拼出的实验。

| 本次检查 | 实际结果/级别 |
| --- | --- |
| 原文/设计/实现静态比对 | 完成；原文139段，原始HTML/正文仅本机忽略目录 |
| 协调器原有相关测试 | 35/35通过；仍未覆盖本次新窗口 |
| 协调器纯内存探针 | 5项已知缺口均复现 |
| 交付真实临时Git/Node，模拟gh | 3项均复现；发布恢复与协调探针交叉复核 |
| daemon/MCP实际HTTP探针 | 2项：长工具等待最终结果、取消后在途write落盘 |
| 本机运行/包体检查 | 健康/控制器/独立监督身份实查及包大小/文件作用核对 |
| GitHub只读核验 | PR #2 merged=95a76e0a99690d8cc4d6e1d72d76b8e24cbd0907；v0.3.1非draft，ZIP远端digest与本机一致 |
| 本轮真实模型/真实端到端业务任务 | **未运行** |

历史v0.3.0的3个原生worker会话/4次调用证明微型并行编码、原会话steer与remote-tools接缝；Router/Watchdog各类模型实验有各自预算。历史PR #1/#2及Release确实在GitHub完成，但任务源代码由Codex开发，交付由操作者独立控制脚本推进；不能合并宣称已经验证“软件中普通讨论→在线Router→真实DSH修改本项目业务代码→独立可信验收→自动合并→发布→原群回传”的整链业务场景。当前在线Super账本为空也不能单独推出其他机器从未使用。

历史26 Python/256 Node/16启动检查、UI/EXE验证仍见`VERIFICATION-v0.3.1.md`；本次未重跑整套，也不以其历史绿灯推翻新发现。先修A1/A2，再覆盖发布/停止恢复及跨阶段边界，最后制定受预算控制的完整真实链路验收，才可提高符合性结论。

## 7. 交付与后续

本轮仅提交本报告、三份合成复现脚本和恢复/过程/状态说明；产品版本/EXE/既有Release及正式配置保持原状。以新的annotated维护tag `v0.3.1-audit.1` 交付，不重发产品Release、不移动已发布tag。提交/远端是否完成以Git实查为准。

下一位Agent先读本报告，再按明确新增范围制定修复/验收设计。Tauri和EXE后台联动待单独实施；不要因用户询问可行性就宣称已迁移。自动合并当前仍为用户授权的原策略，本次没有擅自关闭开关；其可信测试来源缺口必须明确保留。
