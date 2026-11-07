# 本机环境

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
