# v0.1.0 验证记录

日期：2026-11-07（Asia/Shanghai）。范围为小团队内测版，未做容量压力测试。

| 边界 | 实际结果 |
| --- | --- |
| Python服务/权限/备份 | 26项通过；真实100MB边界、WS票据/过滤、幂等、Range、错误清理、快照恢复 |
| 客户端 | 真实双用户Chrome：UI→HTTP/WS→持久化→第二用户；媒体实际播放，下载SHA一致，重连恢复，通过；无pageerror |
| Windows | Electron45.2.3便携包构建；asar内容白名单通过；正常启动原生窗口截图确认登录界面 |
| Docker | Linux镜像team-relay:0.1.0构建通过，隔离容器health=healthy |
| DSH | 官方签名Desktop0.2.2-rc.1的真实SDK初始化/工作目录/跨进程恢复/关闭通过；零模型请求 |
| 桥接可靠性 | 12项通过；真实IM服务链路使用明确测试执行器；并发锁、预置文件链接回归通过 |
| 版本上传 | 设计版本已推送walcracia/agent_bot_im；实现版本随本报告提交/tag推送 |

尚未执行：腾讯实机与域名TLS；真实模型任务；多机网络长期运行；完整容量测试。Windows包未代码签名。

验证原始日志、截图和隔离数据在environment/verification与logs，敏感材料不上传。首次测试中的路径/选择器/CSP测试写法及备份句柄问题均记录在workspace/docs/PROCESS.md。自动审批拒绝调试端口启动（blocked by policy），已停止该方式，改正常启动原生界面验证。
