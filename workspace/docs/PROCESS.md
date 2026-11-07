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
