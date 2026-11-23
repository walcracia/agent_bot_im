# 同频TeamPlay v0.5.1

- DSH统一max思考，日志复用原插件流程；真实分析、单条结论和完整报告下载已跑通。
- 修复Pi测试会话的桌面登记，Hermes会话保留真实来源并统一命名；Pi“项目”搜索“同频”，HermesCtrl+K搜索“同频”或“会话→全部”查看。
- 每次完成均生成Windows便携包，并验证实际启动、托盘、聊天及报告下载。

下载并完整解压Windows ZIP，运行`TeamRelay-win32-x64/TeamRelay.exe`。不要只复制EXE。本机服务入口为仓库`environment/scripts/start.ps1`，需PowerShell7及已配置的项目环境；客户端包不包含服务器、DSH/Pi/Hermes或账号。

完整设计、业务流程和本轮验证见仓库README及`outputs/VERIFICATION-v0.5.1.md`。校验清单随包提供。
