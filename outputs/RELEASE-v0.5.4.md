# 同频TeamPlay v0.5.4

修复附件收齐但HTTP流未结束时可能一直等待的下载问题，保留大小和MD5完整性检查；失败原因有本机脱敏记录，聊天给出恢复动作。

QA日志主流程成为每轮迭代必过项。本版已真实完成Bug/双附件→原插件Skill→Qwen4 Max High→聊天原结论与完整TXT→成员认证下载。打包必须提供本版、当前运行源绑定的真实QA收据；单测、连接ping或旧成功记录不能替代。

完整解压TeamRelay-v0.5.4-windows-x64.zip，运行TeamRelay-win32-x64/TeamRelay.exe，保留整个目录。包只含客户端，后台仍使用environment/scripts/start.ps1。本机账号/模型凭据不在包内。

ZIP162325626字节，SHA256 a8d51324abab401713a485823a4432e5e1e3484323d0cf851dc18035f9be8146。完整验证与历史原因的不确定性见同版本VERIFICATION报告。
