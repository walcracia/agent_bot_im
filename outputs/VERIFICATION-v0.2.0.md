# v0.2.0 自动编码验收 · 2026-11-08

## 已落实

用户确认当前agent-bot-im项目、普通讨论也自动识别。新增本机DSH headless执行器、只读语义识别、同群有界上下文、首次跳过旧聊天、独立代码副本、任务/会话恢复与本机交互绑定入口。旧mention/SDK仍兼容，v0.1.2桌面客户端可继续连接。

## 真实编码闭环

使用当前仓库的独立detached worktree，基线为fecf6c8；在其中创建明确标注的微型Python验收夹具，故意将活跃成员统计写成减一。它不是生产缺陷，不进入主分支。通过真实FastAPI/SQLite服务中的合成群聊发出无@消息；本机已安装DSH 0.2.2-rc.1使用存储认证识别并工作，没有下载模型或第二套Desktop。

- 1次只读分类会话识别为code_task，1个真实headless worker修改文件并运行指定测试。
- 实际差异只有从`return sum(...) - 1`改为`return sum(...)`；测试文件保持原样，独立pytest实跑从失败变为`1 passed`、退出码0。
- IM读到一条最终结果；模拟“服务器已收回复、客户端丢确认”后，重建executor并重载状态，只重发缓存结果，没有再次分类或修改；最终回复仍一条。
- 工作副本HEAD未变，无tracked或staged生产文件修改，未跟踪内容仅两份验收夹具文件；没有提交或推送夹具。
- 另作1次真实只读识别：上下文已有修复结果，当前消息为“已解决、先不要再改”，实际返回ignore，worker为0，代码hash不变。

这里的“会话/worker次数”是桥接调用次数，不推测底层模型HTTP请求数或费用。原始JSONL、会话映射、模型输出及临时消息只留忽略目录；没有公开认证或推理日志。隔离IM服务已关闭，测试数据库已删除，代码夹具副本留本机供核对。

## 自动化与审查

| 检查 | 实测 |
| --- | --- |
| `environment/scripts/verify.ps1` | 26 Python、53 bridge测试、客户端/桌面JS语法全部通过 |
| 自动路由/状态 | 授权边界、跨群/未来上下文过滤、预算、严格决策格式、复合ack、@/私聊取消、分类失败、初始化游标、结果重发通过 |
| 本机CLI协议 | JSONL完整性、原生session映射与恢复、read-only分类、连接码环境隔离、Unicode/shell字面任务、超时owned进程树清理通过 |
| 工作副本互斥 | 同cwd不同state/map/runs、Windows大小写、跨进程互斥；不同cwd可并行；故障释放及旧锁/替换锁保留通过 |
| 首次绑定入口 | 9项本地mock API/临时Git副本检查通过，包含按编号选择、授权校验、token不落盘/恢复、活跃root拒绝、不同配置namespace隔离 |
| PowerShell入口 | connect-installed/run-installed/installed-runner解析通过 |
| 原生版本探测 | installed-headless handshake实际返回0.2.2-rc.1，modelRequests=0 |
| 独立集成复核 | 首轮发现2项真实问题，修复后定向15项测试通过、无残留行动项 |

分类/执行测试中的假CLI均明确为协议测试，不冒充真实模型证据；上方单列的真实编码与取消识别才使用本机实际DSH。

## 本轮修正与限制

修正复合感谢未过滤、auto显式@/私聊绕过判断、不同监听实例可并发写同cwd、异步首调用预留竞争，以及runner完成后metadata仍显示running。新增严格工作目录锁与配置namespace，保留uncertain/routing_failed的手动恢复边界。锁/状态测试没有自动删除旧锁。

当前是单项目串行编码闭环，未实现文章完整并行Router/Worker、语义Watchdog、实时聊天接管、跨平台任务图或自动PR/合并。分类需要本机DSH模型可用；模型语义判断不能当成确定性规则。SDK旧路径的历史限制仍见桥接文档。现有Starlette/httpx弃用提示保留，依赖未升级。

正式团队的服务地址、助手连接码、项目群与成员需要在本机绑定，未随Git分发，也未声称本轮已常驻监听真实团队聊天。首次运行connect-installed，已绑定配置用run-installed；不要清空DSH留下的差异来重启。

源码按新annotated tag v0.2.0交付。本文件是提交前快照；最终上传状态应核对远端main/peeled tag与Release。部署配置、验收worktree、原始日志和认证不进Git。
