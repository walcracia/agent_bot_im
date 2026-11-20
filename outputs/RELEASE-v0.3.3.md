# 同频TeamPlay v0.3.3

- 最小化留在任务栏；关闭窗口收进托盘继续收消息，点击图标恢复，右键可打开或退出。
- 后台新消息有托盘未读闪烁和Windows任务栏提醒；返回窗口停止闪烁，其他聊天未读保留。修正后台当前聊天被自动标读的问题。
- 增加隔离preload、托盘生命周期/权限测试和真实Windows包验证，保留石墨界面与已有用户资料。
- 完成QA新Bug的Super-agent Trigger→Router→只读日志Worker→Outbox流程设计，支持规划中的新增缺陷及群贴编号重分析。本轮尚未实现/启用QA自动分析，没有调用真实模型或改动DSH插件。

完整解压TeamRelay-portable.zip，运行TeamRelay-win32-x64/TeamRelay.exe；保留全部文件，账号连接原有服务。客户端退出不停止独立服务器或DSH，未进行代码签名。

验证：26 Python、256桥接、9桌面、16模拟启动检查；9项隔离浏览器未读、7项真实打包Electron/Tray/IPC检查通过。ASAR16条目/12源码文件、PE及完整ZIP校验通过。详见VERIFICATION-v0.3.3.md，模拟、程序驱动原生与未执行项分别记录。

ZIP 162,325,631字节；SHA256 `135e0a477329513c18a183926301e4c5a463005709465530821449a0ed2ffe35`。
