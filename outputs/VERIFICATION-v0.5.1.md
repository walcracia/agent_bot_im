# 同频TeamPlay v0.5.1 验收

2026-11-23。本轮设计先冻结于DELIVERY-v0.5.1：每轮打包、恢复QA测试、Pi/Hermes原生记录可见、DSH统一max。Git及Release最终回执以HANDOFF/state与远端实查为准。

## 真实日志正向

公司QA TCP恢复后，首次读取因SSO过期超时；用户完成标准Microsoft授权后，真实缺陷及附件授权读取通过。沿原231问题检查点扫描，4项更新/关闭/附件变化入账，没有重建或伪造基线，也没有重跑全部旧问题。授权聊天只发送一次已选问题重分析。

新输入版本真实完成：同一附件完整解析，79份日志、44证据片段、60关键块、744条真实行；system/user与原插件参考逐字相同。单provider请求使用deepseek-flash/max，receipt记录原配方6000和原生模型目录256000容量，原生完成/exit0。耗时85.4秒，输入63475、输出15929 tokens；不是重新引入调用或阅读额度。

Worker机械提取原【结论】，只回一条消息和完整TXT。成员认证下载10825字节，内容与保存报告、SHA256一致，原报告正文及用量完整保留；没有第二个模型改写结果。原生请求/报告及QA正文只在忽略目录，不发布客户数据。旧四工具终态不作为本次流程等价证据，也不预设参考截图的责任方必须成为答案。

## 原生会话历史

Pi旧测试位于独立任务session-dir，桌面只扫描共享home/sessions，故未列出；按官方scanner可接受的目录链接登记4个原会话，并原生命名。运行中的Pi Desktop同一列表接口实际返回4个原ID；可在“项目”搜索“同频”。保留原文件和恢复映射，标题之外历史hash及原生token/API统计不变。

Hermes的5个原会话均存在。默认聊天侧栏排除tool/acp，保留真实来源，通过原生/title零模型命令命名；Ctrl+K搜索“同频”或“会话→全部”查看。“自动化”只列tool来源，并非全部ACP记录。官方完整会话/消息读取均返回原ID；消息hash、source/created_source及模型/API/token计数不变，控制操作end_turn/exit0。不复制历史、不额外调用模型制造记录。

## Windows交付

- EXE：`outputs/desktop-v0.5.1/TeamRelay-win32-x64/TeamRelay.exe`
- ZIP：`outputs/TeamRelay-v0.5.1-windows-x64.zip`，162325628字节。
- SHA256：`d79bed49480a8ab7ce083cbd981f9ebbaa7f53793c72e892472acd7e49b31118`。
- ASAR16条目/12源文件及图标逐字节匹配，PE x64/名称/版本0.5.1，ZIP74文件CRC/清单/每文件hash通过。
- 实际打包Electron8项通过：隔离profile、托盘隐藏及恢复、任务栏最小化、真实WebSocket未读、单实例、结论+TXT实际点击保存/hash、退出与0renderer错误。程序驱动原生事件，未冒称人工点击系统托盘。
- 两尺寸4张实际窗口截图集中查看，无界面修改。测试实例正常退出，不关闭用户已有App。

统一打包入口`environment/scripts/deliver-windows.ps1`，旧build-portable兼容转发；版本目录/ZIP已存在时拒绝覆盖，`-VerifyOnly`可复核。仅包含客户端；服务器和三原生Agent另行运行，真实凭据/日志/聊天/运行库不入包。以后每轮都打包，不能仅说旧版兼容。

## 常规与实际运行

完整verify通过26 Python、9桌面、485桥接、16模拟启动和入口语法。随后DSH基础入口补max，相关31/31通过；最终桥接486项中479通过、7项因本次测试命令未将Node24前置子进程PATH而失败，均集中启动凭据夹具。纠正测试环境后该文件16/16通过，失败日志保留；没有为消除环境失败改产品代码。最终源的486项已由完整运行与相应复验覆盖通过，不冒称失败运行本身全绿。mock与上方真实集成证据分开。

基础max覆盖旧Router/代码Worker/Watchdog，但未启用这些功能；wrapper原顺序保持，QA提示/直接调用未变，不重复模型追逐参考结论。正常stop/start、重复start及最终补丁后重启均确认服务0.5.1与原绑定监听ready，QA检查点231/ready、完成版本/attempt及三业务任务保留，没有模型重放。未部署腾讯。

私有证据：environment/verification/v051、v051-session-visibility、desktop-artifacts-v0.5.1、desktop-native-v0.5.1。旧失败如实保留；无法由本轮证明的旧代码A1/A2、任意项目自动发布、OpenCode及OS沙箱仍属边界。

## 最终远端回执

产品源码bc156a89647ff8ac8ebaca66e8fa65628cef51f7及annotated v0.5.1对象e505d8abe4b5b11433382e046e4c8506286675c5/peel远端一致。Release已正式发布（isDraft=false），两资产state=uploaded，ZIP及SHA清单size/digest与本地逐一一致。下载https://github.com/walcracia/agent_bot_im/releases/tag/v0.5.1；本回执提交另用handoff标签，产品tag不移动。
