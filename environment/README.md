# 本机环境

## v0.2.1 同步启动

已绑定后，`scripts/start.ps1`默认同时启动/复用IM服务和DSH监听；两者就绪才返回成功。首次创建账号/绑定前显式用`-ServerOnly`，然后按`../workspace/README.md`运行`connect-installed.ps1 -EnableStartup`。IM助手连接码的DPAPI密文只保存在本项目忽略的config JSON中，需同一Windows用户解密，DSH认证继续使用其自身stored配置。

`scripts/stop.ps1`先请求监听停止，等当前事件和回传完成，再停IM；超时不杀worker、不停服务器。异常任务/锁需按桥接恢复规则处理，不自动删旧锁。进程记录为config/server-process.json和dsh-process.json，实例就绪/停止请求在data/startup；日志每实例保留在logs/dsh-startup。所有运行状态均需实查。规格见`../workspace/docs/STARTUP-v0.2.1.md`。

## 2026-11-08 干净检出恢复

本目录下的 venv、工具、数据和私有配置不会随 Git 下载。以下历史记录不代表这台电脑已存在对应服务、账号、成品或授权。当前验收见 `state.json` 的 `current_checkout` 与 `../outputs/VERIFICATION-handoff-2026-11-08.md`。

需要 PowerShell、Git、uv 和 Node。项目根执行 `environment/scripts/setup.ps1`，再执行 `environment/scripts/verify.ps1`。uv 不在 PATH 时通过 `-UvCommand` 指定；`-SkipDesktop` 跳过 Electron 依赖下载，仍可运行常规验收。新 venv 使用 uv managed Python 3.12，并将解释器保存在 `tools/python`，不依赖旧机器目录。常规验收使用临时数据、不会调用真实模型。

v0.1.2 的完整界面验收入口是 `environment/venv/Scripts/python.exe environment/scripts/verify-ui-v0.1.2.py`，需要系统 Chrome。它自动创建随机测试账号、临时数据库与端口，在当前 Python 进程内管理测试服务，退出时关闭并清理；报告/截图在 `environment/verification/ui-v0.1.2/`。可用 `--fixture-only` 单独检查服务生命周期，不依赖旧演示账号或常驻服务。

首次使用需要自行创建管理员（见 `../workspace/README.md`）再启动。Git 不含演示密码或聊天数据；成品需要下载现有 Release 或运行 `npm run build`。真实 DSH 另按 `workspace/bridge/README.md` 准备，未因常规测试通过而自动恢复。

## 2026-11-07 原开发机记录（历史）

源码位于 `../workspace`；仅本项目的 venv、数据、日志和临时验证文件放在本目录。默认端口 `127.0.0.1:18200`，不修改同级服务。

本机 Python 3.12.16 独立 venv；完整依赖锁为 config/requirements.lock.txt，服务器容器锁为workspace/requirements.lock.txt。Node22.14用于客户端开发/常规桥接测试，官方DSH Desktop路线使用其自带Node24。

项目根运行：

```powershell
.\environment\scripts\setup.ps1
.\environment\scripts\start.ps1
.\environment\scripts\stop.ps1
.\environment\scripts\verify.ps1
```

启动脚本记录实际监听进程的PID/路径/创建时间，停止时核验身份。访问 http://127.0.0.1:18200；本机演示随机账号在忽略文件config/demo-accounts.json，数据库在data/chat.sqlite3，附件在data/attachments。不要将这些私有文件上传。

真实UI验证脚本scripts/verify-ui.py使用系统Chrome、隔离浏览器profile、真实本机演示服务，会创建测试会话和助手；截图/报告在verification。常规verify包含26项Python和12项桥接测试，不自动调用模型。

正式Windows包在outputs/TeamRelay-win32-x64，ZIP和SHA256同在outputs。本机Docker镜像team-relay:0.1.1已构建，18201的临时验证容器已清理，不作为常驻服务。

官方DSH发行包/SDK/独立home在tools/dsh，部署与握手入口为workspace/bridge/setup-desktop.ps1和run-desktop.ps1；真正本地模型测试必须显式运行run-local-model-smoke.ps1，详见bridge/LOCAL-MODEL-TEST.md。不要混用其他项目或用户新装Desktop的profile/凭据。

GitHub CLI在tools/gh/bin/gh.exe，已经用户设备授权。版本发布入口scripts/publish-iteration.ps1。生产部署资料在workspace/deploy；所有实际验证和限制以state.json、HANDOFF与outputs脱敏报告为准。
