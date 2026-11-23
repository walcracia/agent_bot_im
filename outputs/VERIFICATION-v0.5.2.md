# 同频TeamPlay v0.5.2 验收

2026-11-23。用户要求协调者与DSH、Pi、Hermes使用中文传递信息，设计先记录于AGENT-LANGUAGE-v0.5.2，长期接续规则写入AGENTS。

三原生回归任务模板、回归MCP工具说明及本地模型哨兵提示已改中文，summary/findings.detail等反馈明确中文。通用Router/Worker明确中文沟通和结果；QA只改宿主运输说明，固定原插件system/user、原报告处理、机器字段/枚举、命令、源码及引用不改。历史报告不翻译，不额外调用模型改写skill结论。

完整verify单次通过26 Python、9桌面、486桥接（0失败/0跳过）、16模拟启动及语法；另核对三处验证脚本语法。纯提示文案不新增镜像测试。本轮真实模型调用为0，三Agent及QA的历史真实验收仍见v0.5.0/v0.5.1，不能将本次语法检查称为新原生模型测试。

Windows0.5.2真实构建：ASAR16条目/12源文件逐字节，PE x64/产品名/版本、ZIP74文件CRC/全hash通过；实际隔离Electron8项含托盘/任务栏/未读/单实例/结论+TXT真实点击保存通过，0渲染错误，无验收进程残留。前端行为未改，四张两尺寸截图保留在忽略证据目录。

便携包`outputs/TeamRelay-v0.5.2-windows-x64.zip`为162325625字节，SHA256为`a1e46338510c12c899114c6f06149a69b695533706d34bc0ba19aad4393f3106`；校验清单99字节，自身SHA256为`32766af93eb4e3bc04763d88c781134e67a4ca41c0e4155f900d62d577e3d503`。EXE为`outputs/desktop-v0.5.2/TeamRelay-win32-x64/TeamRelay.exe`，保留整个目录。包仅含客户端，不含后台、三Agent、凭据或真实材料。

本机正常stop/start及重复start确认服务0.5.2和监听ready，旧QA/业务账本保留。私有完整证据见environment/verification/v052、desktop-artifacts-v0.5.2及desktop-native-v0.5.2。Git及Release最终回执以HANDOFF/state和远端实查为准。
