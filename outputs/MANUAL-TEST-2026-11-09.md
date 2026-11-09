# 本机人工测试入口

2026-11-09，服务端v0.2.0，兼容桌面界面v0.1.2。本轮只准备人工验收环境，尚未获得用户本轮测试结果。

## 打开与登录

1. 本机服务地址：`http://127.0.0.1:18200`，仅供这台电脑访问。
2. 打开项目根下`outputs/TeamRelay-win32-x64/TeamRelay.exe`。必须保留整个便携目录；转移时完整解压`outputs/TeamRelay-v0.1.2-win32-x64.zip`，不能只复制一个EXE。
3. 本机测试账号/随机密码在`environment/verification/manual-test-20261109/测试入口与账号.txt`，原始结构在`environment/config/demo-accounts.json`；两者不上传Git。
4. 建议EXE登录admin，浏览器登录alice，使用已有“产品协作组”。admin也可在设置中创建新成员。

## 建议人工检查

- 两端在群里发消息，观察实时显示；切换会话、重新登录后查看历史。
- 联系人发起私聊、新建群聊。
- 上传/查看图片，播放音频和视频，下载普通文件；每个文件严格小于100,000,000字节。
- 检查附件入口、消息时间、失败提示，以及缩小窗口后的操作。

发现问题时记录操作步骤、账号名、预期/实际现象，可附截图；不分享密码或助手连接码。

## 本轮已核验

- 既有start脚本实际启动；健康接口返回ok/v0.2.0；单服务监听127.0.0.1:18200。
- admin/alice实际HTTP登录、读取自身和测试群成功；验证用会话均已退出。
- 原生EXE正常打开，Windows窗口树显示登录表单和正确默认地址。未自动完成客户端登录后的人工流程。
- 独立只读核验app.asar九个允许条目、五个客户端文件和desktop/main.cjs与源码逐字节相同；生产package.json为构建脚本精简字段。
- ZIP为158,123,939字节，SHA256：`9aa04e679a3ffa7445e260e32483a4d76dfaeeecfc619612fa0d57e0b022eae4`，与发布校验文件一致。

## 服务与后续

退出EXE不会停止服务。需要时在项目根PowerShell运行`environment/scripts/stop.ps1`；再次启动用`environment/scripts/start.ps1`。启动前先查已有监听，不能重复启动或删除测试数据。进程身份在忽略文件`environment/config/server-process.json`。运行状态是当日观察，不保证电脑重启后继续存在。

真实DSH群绑定/自动编码监听尚未启动。助手账号存在不代表已经接通；后续使用`workspace/bridge/connect-installed.ps1`绑定授权会话和独立Git副本。腾讯服务器未部署。
