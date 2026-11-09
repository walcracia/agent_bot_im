# v0.2.1 · 服务与 DSH 同步启动

v0.2.2补充：`DSH-RECOVERY-v0.2.2.md`覆盖旧异常任务阻断就绪的规则。auto/installed连接可listening、任务状态paused，等待同群授权的继续/取消；不会自动重做，原锁和会话验证不变。

2026-11-09。用户要求“DSH监听需要随着启动同步绑定”。本轮增加本机Windows启动编排，保持桌面界面v0.1.2和v0.2.0自动识别/执行协议。先冻结以下设计与验收，再实现。

## 启动契约

- `environment/scripts/start.ps1`默认同时准备IM服务和已绑定DSH监听，两者就绪后才返回成功。显式`-ServerOnly`仅供首次创建账号/绑定或单独排障。缺少绑定不冒称整套就绪，并给出首次绑定入口。
- 已经运行、健康且与`server-process.json`的PID/可执行路径/创建时间相符的本项目服务可以复用；其他进程占用端口必须拒绝。只启动一个SQLite/WAL worker，不重启当前人工测试中的客户端。
- 默认读取`environment/config/bridge-installed.local.json`；可选`-DshConfigPath`必须在本项目忽略配置目录。配置中`startup.enabled=true`，`startup.credentialPath`指向同目录的加密凭据JSON，服务baseUrl必须匹配本次本机端口。
- `connect-installed.ps1 -EnableStartup`在原先群/成员/独立Git副本校验之后保存Windows当前用户DPAPI保护的IM助手连接码。也接受进程变量`TEAM_RELAY_BOT_TOKEN`用于已授权本机准备，避免把码放参数/日志。旧的无此开关模式继续只用当前进程，不自动持久化。
- 凭据JSON格式`{version:1,kind:"windows-dpapi-current-user",protectedToken:"..."}`，仅本机当前Windows账号可解密。辅助`workspace/bridge/startup-credential.ps1`提供`Get-ImStartupToken -ConfigPath <绝对配置>`给启动编排使用，返回字符串须赋值接收且不能打印；保存辅助由绑定入口使用。DSH自己的认证仍由其stored插件解析，不复制API key。
- 启动脚本直接启动Node桥接，短暂给子进程继承IM token后恢复父进程环境；token不出现在命令参数、进程记录、配置明文或模型环境。日志使用本次实例独立文件，不覆盖历史记录。

## 就绪、重复启动和停止

- managed入口增加`bridge.mjs --runtime-file <绝对路径> --instance-id <GUID>`；运行状态写在忽略的`environment/data/startup/<GUID>.json`，停止请求为同一路径加`.stop`，正文`{instanceId:"<GUID>"}`。状态至少包含`instanceId,pid,configPath,status`，状态取starting/listening/stopping/stopped/failed。就绪内容可含授权数量，不含码/聊天正文。
- 就绪必须发生在：本机CLI零模型版本探测成功、bot身份匹配、配置群仍含bot、成员白名单有效、状态锁/游标准备和未完成任务恢复检查完成之后。失败状态保留脱敏错误，不能只凭进程存在认为已监听。
- `environment/config/dsh-process.json`记录Node PID、可执行路径、创建ticks、config_path、runtime_file和instance_id。启动复用已运行实例时同时核验这些字段、命令行与runtime的listening状态，不能复用别的Node或陈旧ready文件。启动失败返回错误，保留服务器/进程记录供检查，不自动杀可能已执行代码的worker。
- `stop.ps1`先验证监听身份，再原子写入带正确instanceId的停止请求。桥接不再开始下一条事件，当前识别/任务/回复完成后退出，释放自己的锁。超时（默认30秒）或身份不明则报错并保留服务器；不强制杀编码worker，不自动删除旧锁。监听退出后再安全停止已核验的本项目服务器。未配置监听时兼容仅服务器的停止。
- 对失败、不确定、started事件和既有锁继续沿用v0.2.0人工恢复边界；不因自动启动而自动重试、清空游标或重放旧消息。此轮不增加系统登录自启、服务注册或崩溃无限拉起。

## 本机实际绑定范围

当前项目已显式创建的人工测试demo提供一个群和三个人类测试账号，助手已在群内。本轮可为这个测试群绑定已有助手、当前项目的独立Git worktree以及这些测试成员；不读取其他项目或个人团队凭据，不扩大到未来新群或成员。后续首次接入真实团队仍明确选择授权群与成员。

## 验收

1. 隔离环境验证DPAPI保存/解密、不在Git或参数明文保存token；原只用进程的绑定方式保持兼容。
2. 默认未绑定拒绝成功；ServerOnly可bootstrap；已运行服务复用；重复start只保留一个监听；端口/进程/nonce/创建时间错配拒绝。
3. managed bridge只有完成实际IM身份和授权/游标检查后listening；错误token/无权限群/未完成异常任务不ready，第一次自动监听跳过旧消息。
4. 正常停止不留下状态锁；任务进行时只请求停止，超时不杀worker/不关服务器。停止后再启动复用原绑定，不需输入连接码、不自动重做已完成任务。
5. 常规Python、桥接与语法检查通过；本机真实安装CLI版本探测与测试群常驻监听就绪，执行一次停止/启动并确认无重复监听。常规测试不调用模型；此前真实改代码证据仍见v0.2.0报告，本轮不重复付费编码验收。
6. 文档、脱敏验证、commit、新annotated tag与远端查询完成。运行数据、凭据、聊天与原始日志不提交。

编排补充：start/stop共享`environment/config/runtime-controller-lock.json`上的FileStream独占句柄，避免并发操作覆盖有效进程记录。退出/异常由OS释放句柄，文件保留；它与不自动删除的桥接状态/工作目录锁不同。服务器与DSH每次新实例使用独立GUID日志文件，失败不覆盖旧诊断。
