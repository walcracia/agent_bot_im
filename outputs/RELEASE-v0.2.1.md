# v0.2.1 · DSH随服务启动

Windows本机启动入口现在同时启动/复用IM服务和已绑定DSH监听，两者实际就绪才返回成功。首次选择群、派任务成员和独立Git副本后，用`connect-installed.ps1 -EnableStartup`保存当前Windows用户DPAPI加密的IM助手连接码；以后不用重输。原来的临时前台绑定保留。

停止时先让监听完成当前事件、回复并释放锁，再停IM。超时保留worker与服务器，不自动重试不确定任务、不清空游标、不删除旧锁。新实例仍默认跳过旧聊天。启动包含零模型的CLI版本检查，不会为了启动额外发起模型任务。

桌面界面没有变化，继续使用[Windows v0.1.2便携包](https://github.com/walcracia/agent_bot_im/releases/download/v0.1.2/TeamRelay-v0.1.2-win32-x64.zip)。完整解压后打开TeamRelay.exe，不要只复制EXE。

恢复与验收见`RESTORE.md`、`workspace/docs/STARTUP-v0.2.1.md`、`outputs/VERIFICATION-v0.2.1.md`。Windows加密码、真实配置、运行进程和工作副本不会随Git恢复；换电脑或Windows用户需重新绑定。此版本没有系统开机自启、崩溃无限拉起或腾讯远程部署。
