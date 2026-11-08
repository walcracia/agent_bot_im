# 过程记录（Asia/Shanghai）

## 2026-11-07 · 设计阶段

- 读取用户需求、父目录环境布局、同级项目恢复结构；当前工作目录原为空。
- 确认 Node 22.14、Python、Docker 可用，计划独立 Python 3.12 环境，使用现有共享缓存。
- 微信 URL web 打开失败，已并行研究文章与 DSH 官方仓库。
- 设计冻结：见 DESIGN/API/DECISIONS；源码实施必须在此之后。
- GitHub 用户 waternie 已查证；当前工具不支持建仓且本机无凭据，用户已收到异步补充信息请求。

后续阶段继续追加实际结果，不能改写历史失败为通过。

## 2026-11-07 · v0.1.0 实施与验证

- 设计冻结后并行实现 FastAPI/SQLite 服务、Electron 原生渲染客户端、官方 SDK 桥接。
- 独立 Python3.12 venv；依赖锁定；服务器仅监听127.0.0.1:18200。生成随机隔离演示账号到忽略目录。
- 后端与备份26项测试通过，包含99,999,999字节接受/100,000,000拒绝、HTTP Range、WS隔离、磁盘失败清理、分块JSON64KiB限制、验证错误不回显输入。
- 备份首次发现 sqlite context manager 不自动关闭连接导致Windows文件占用，改用closing；空附件恢复目录已补；真实运行数据库备份/恢复通过。
- 启停测试发现Windows venv launcher的子进程持有端口，改记录真实listener PID+exe+creation ticks；停止/重启/健康检查通过。
- 双用户真实Chrome UI验证通过群聊创建/实时消息/XSS字面量/关闭WS并离线后补读/PNG+WAV+WebM+TXT上传/媒体实际播放/下载字节SHA与Range206/960×680编辑器/退出；测试脚本两次失败为选择器与CSP的测试写法，修正测试后通过，未放宽产品CSP。
- 客户端Electron45.2.3/packager20.3.0构建便携目录；下载超时后镜像取得官方SHA校验包，native解压依赖中断按lock重装；asar白名单不包含server/bridge/tools。
- 自动审批拒绝带远程调试参数启动命令（只给blocked by policy），未重试此方式；改正常启动，原生窗口截图确认正式EXE渲染登录页。未通过CDP操纵正式EXE。
- DSH官方签名Desktop0.2.2-rc.1已隔离部署，官方SDK真实stdio初始化/跨进程会话恢复/关闭通过，零prompt/零模型请求。桥接真实IM HTTP+SQLite链路用明确测试执行器验证，不能视为真实模型工作。
- 独立审查实际复现stale锁竞争及预置链接覆盖文件两问题：取消自动删锁、随机新目录+wx，12项桥接测试通过，含并发与hardlink/junction回归。
- Docker镜像构建并在隔离127.0.0.1:18201容器健康通过。未在腾讯实机/TLS部署。
- 用户指定walcracia/agent_bot_im；CLI已授权walcracia。Git直连超时，采用用户原已启用的系统代理仅为本仓库Git配置，设计main/tag已真实push。没有使用/保存用户曾发出的密码。

## 2026-11-07 · 下一迭代 v0.1.1 范围

用户要求使用Impeccable精简UI，给出红框截图。删除四处非操作性说明（登录副标题、左侧介绍段、凭据说明、底部部署说明）；检查其余页面，以常用词和图标替代普通界面的技术描述。保留必要操作标签/悬停名称。先读技能和更新设计再编辑、重构建、有限批次验证。

## 2026-11-07 · v0.1.1 结果

- 官方Impeccable4.8.0通过skill-installer安装。context引擎下载失败，按技能要求在下一工具前明确告知，采用既有设计+distill/clarify/operate/craft-floor备用流程；先写UI-v0.1.1再改源码。
- 用户红框四块直接删除，无替代说明。英文眉题、版本页脚、宣传插画卡/技术说明卡删除；账号/团队地址/助手/连接码采用常用词。图标操作保留可访问名称，默认详情关闭，真实@dsh快捷插入未改底层协议。
- 先批量查看1280×860与960×680登录/聊天，集中修正对比度与无助手添加入口；一次最终确认含设置/添加成员/新聊天。主按钮4.95、placeholder4.90、次要文本>=5.17、媒体文字在绿气泡5.30对比度。普通添加成员不默认勾助手。
- 最终双用户真实UI流程再次通过，扩展真实管理员UI创建助手；音视频实际播放，下载hash与Range206，断线补读，icon语义/默认详情关闭/退出通过，无pageerror。Windows正式v0.1.1正常启动并通过原生截图/AX确认新登录页。
- 最终Python26项、桥接12项全部通过。锁定runtime依赖的Docker1.1构建通过，Compose配置通过；容器账号/会话/消息写入及重启持久通过。首次新容器验证未等待启动导致ResponseEnded，验证脚本增加先健康检查后认证，非应用运行错误。
- 原版本上传因OAuth缺workflow scope被拒；将workflow改为可选模板并修正尚未上传的本代理提交，main与v0.1.0成功推送，没有扩大访问权限或force push。
- DSH真实本地模型：官方SDK+既有qwen2.5:3b精确LOCAL_DSH_OK通过；独立临时IM→Harness→模型→回复传输通过，实际答复多@dsh前缀，exact-match断言失败。按预先停止条件总共两次调用，无重复调参、付费调用、模型下载或共享服务修改；临时数据已清理。详见bridge/LOCAL-MODEL-TEST.md。
- 正式Windows便携包已生成ZIP与SHA256；v0.1.1源码已推送main（aa08ed5），随后按该迭代建立tag与Release附件。发布状态应以远端实际查询和environment/state.json为准。

## 2026-11-07 · 发布回执与收尾

- v0.1.1 annotated tag已推送，远端解引用commit=66756083b033db6490155c1aaebf52b395104e65，与本机一致。
- Windows ZIP经代理上传速度较慢，读取约43MB后改用已验证可用的uploads.github.com直连；中止仅本次gh上传进程，未修改系统代理/安全设置。直连重新上传成功。
- Release已公开（isDraft=false），ZIP 162,322,601字节，远端digest与本机SHA256一致：099760bae6e55877cb53b823d2057d818f9f06387645c3d76115ed7e322f5358；校验文件亦上传。链接：https://github.com/walcracia/agent_bot_im/releases/tag/v0.1.1 。
- 临时Docker验证容器/匿名测试卷已清理，镜像留存。本机18200与新版客户端保留运行供用户体验。
- 用户追加要求新起子代理说明DSH/IM/代码项目/团队如何协作；已派生独立说明代理，只写TEAM-WORKFLOW.md，不改代码或原项目。说明必须区分当前串行单cwd实现与推荐的分支/审查工作方式。

## 2026-11-08 · Git 接续与技能分发

- 用户范围：安装 nutlope/hallmark、克隆 walcracia/agent_bot_im、保持项目布局、将本轮修改上传 Git，并将开发/交接原则固化为 `proj_multihandoff`，另留父目录可独立托管的副本。
- 先读安装/创建技能规范；并行只读检查相邻项目与干净 clone 的恢复条件。父目录缺少旧 ENVIRONMENT-LAYOUT.txt；保留本仓库已有四层结构，将规则纳入仓库，不搬动邻居项目。
- 从 main 的 3ff9870 克隆。Git 直连超时，使用系统已配置代理的单次 Git 参数成功，不改全局配置。Hallmark 经 skill-installer 安装，上游自带引用/主题校验通过。
- 恢复时首次 uv 误选 LibreOffice 嵌入式 Python，创建失败；第二次原脚本只检查 exe 存在，随后 pip 无法运行。保留本轮失败 venv 到忽略的 build 目录，改用项目 tools 内 managed Python，增加 uv 路径参数、Python 可运行检查与按需跳过桌面依赖；锁文件未升级。
- 验收范围：原有服务器/备份/桥接与语法检查、安装脚本可重复执行、PowerShell 解析、同步脚本隔离 Git 回归、skill 三副本内容核对与远端 SHA 确认。产品 UI/模型/生产部署没有本轮改动，不重复调用对应外部服务。
- 修正可选 Linux CI 模板的桥接测试 Python 路径。历史状态和本机恢复状态分开记录；未验证部分明确保留。
- 独立 skill 包先在父目录 skill/proj_multihandoff 编写并测试，再集成到仓库 .agents/skills 与本机技能目录。用户指定下划线名称优先，标准 hyphen-case 校验对此命名例外需单独说明；其余结构和内容照常验证。
- 最终实测及限制见 outputs/VERIFICATION-handoff-2026-11-08.md；本轮只推送当前项目仓库。独立副本无新远端地址，由用户另行托管。
- 集成后发现 skill 测试将临时仓库建在技能目录内，落入真实项目 Git 时被嵌套仓库保护正确拒绝。测试夹具改用系统临时目录，项目 cwd 下完整17项复验通过；未放宽同步脚本的仓库保护。失败产物保留在忽略的 verification 目录。
- 发布脚本改为必须传入明确 Files 列表、拒绝已有暂存内容、只推指定 tag，并去除修改全局 Git 凭证的命令，使脚本与交接原则一致。独立临时仓库实测通过；另实际复现旧脚本在 topic 提交打标签却只推旧 main 的问题，增加 main 前置限制后，topic/detached 拒绝且保留全部状态的复验通过。

## 2026-11-08 · v0.1.2 开始

用户要求将 Hallmark 审查的五项全部落实。实现前冻结 `UI-v0.1.2.md` 的范围、文件与验收；保留已有品牌与功能。分工：主代理负责 HTML/交互，样式代理只负责 styles/tokens，验收代理负责独立浏览器验收脚本；集成后统一审查、有限批次视觉验收并上传 Git。

## 2026-11-08 · v0.1.2 结果

- 五项全部实现，沿用绿/暖白与应用shell。原字段/按钮ID和文件类型保留；时间使用每条可键盘操作的details/summary，分组只减少视觉重复，错误/重试仍可见。字体/颜色集中到tokens，边框和focus增强。
- 独立交互审查复现并修正时间控件刷新丢焦点；真实UI验收复现附件菜单focusout抢先关闭并修正。IME/媒体定位/Windows原字节拖放的测试夹具问题也分别记录，没有改成假通过。
- 原26项Python/12项桥接与语法检查通过；新临时服务fixture通过；13项真实浏览器流程、8张批次截图、0页面异常。完整范围和修正见outputs/VERIFICATION-v0.1.2.md。
- Hallmark实际render+kept为0 FAIL/0 REFLEX/0 WARN，已记录用户授权移除的标语；独立无继承上下文finish review结论ship、0视觉问题。原CSS大量颜色literal与非标间距规则已统一，不将机械检查项数量当作用户操作缺陷数量。
- 用户中途明确要求新开subagent展示设计，已派design_preview并提供真实截图画廊，页面切换/尺寸/登录前后对照经实测，纳入outputs随Git交接。
- Windows0.1.2便携包已构建并核对asar白名单和五个客户端文件字节一致。首次Node下载未使用系统代理而超时，通过进程级环境代理机制成功；无全局配置变更。记录完成review stamp后重新构建候选包，校验文件对应最终候选。
- 不操纵原生EXE窗口，不新增模型调用或生产部署。按用户已授权的Git交付范围提交新v0.1.2标签、推送源码及对应Windows发布材料，远端确认后才称完成。
