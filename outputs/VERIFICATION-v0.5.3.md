# 同频TeamPlay v0.5.3验收

2026-11-23。先记录MODEL-QWEN-v0.5.3再实现。用户文字指定Qwen4 Max与High，覆盖历史DeepSeek/max及截图XHigh。本轮为真实中文业务验证，未把零网络配置、模拟协议或历史验收当作新模型结果。

## 三个真实任务

授权同频聊天经真实Qwen4/High只读Router选择不同Worker，再由原生Agent执行；三项均原生完成、只回一条原结果与完整TXT，成员认证下载的字节/SHA/内容与原结果一致。

| 执行器 | 原生可查记录 | 实际中文结果 | 完成用量 |
| --- | --- | --- | --- |
| DSH | 检查切片求和漏算末项（B000006） | 解释切片漏掉末项，建议sum(xs)，给出42及边界回归例子 | 约140秒，5步/5模型生成，5工具尝试 |
| Pi | 同频 · B000004 | 总额350，120出现2次，重复值参与总额 | 原ID接续约24秒，4模型、3工具 |
| Hermes | 同频 · B000007 | 3项待办、责任人/期限/原文行号，未明确字段待确认 | 约94秒，原生会话API计数5、6工具 |

三者实际型号qwen4-max、High。DSH原生稳定request/header覆盖5个step，不能冒称5条header；最终turn completed，实际Desktop打开显示qwen4-max · High及中文结果。Pi new/resume RPC精确选型号/High，4个请求观察证明enable_thinking=true、reasoning_effort=high、max_completion_tokens262144、无thinking_budget；原JSONL与Desktop列表唯一原ID核对通过。Hermes原生custom provider采用实际已有endpoint，ACP精确设置并读回High，原生builder零网络证明请求思考字段；本轮成功任务使用document-to-action-items Skill、native end_turn及viewer exit0，原生Desktop完整列表/详情与原生store单独核对。

DSH桌面正常重开后新会话才显示；首次列表未刷新观察保留，没有伪造索引。原生打开追加session/end-seed，其原prompt/result/title/header和终态hash均未变。Pi在“项目”搜索“同频”；Hermes在Ctrl+K或“会话→全部”搜索目标标题，tool来源未伪装成人工会话。

DSH原报告明确工具执行受Windows沙箱SetNamedSecurityInfoW/Win325阻止，结论按Python确定语义说明；本报告不将该命令称实际执行通过。项目完整回归是协调者独立执行，不能与上述代码检查混为同一次测试。

## 原失败与处理边界

DSH第一次Router因headless未登记目标provider在模型前失败；补用户级引用后，接口400拒绝developer角色，按原生compat切system角色并保留原提示内容，随后路由/任务完成。Pi旧key与Hermes旧key均真实401；备份后使用本机同endpoint已验证有效凭据，分别通过Pi原生auth和Hermes原生credential lifecycle更新。凭据值、ref及原生账号不进入源码/包。

Pi保留401，明确IM继续控制后原nativeID完成。Hermes旧B000005原生精确admission为terminal/failed，ACP未给原prompt终态；仅在核对精确session/admission和自有PID/creation后结束自有viewer，未结束共享gateway，正常停监听后用原StateStore锁依据只读原生证据消除旧调用uncertain，保留paused/failure/原session/attempt，不伪造完成。原ID再load遇原生Windows版本查询subprocess/pipe等待，发生在业务prompt前；零模型诊断保留，未修改安装、戳或原生源码。最终明确取消旧测试，再从IM创建独立B000007正常测试；新任务不冒充原ID接续。此原生failed-session恢复缺陷未在本轮修复。

QA只更新可信模型/High与原生输出容量，原插件材料、system/user和原报告处理不改。本轮没有新增QA日志分析；v0.5.1整包DeepSeek/max真实验收保留历史属性。没有重新添加分析、模型、工具、阅读或总时长额度。

## 项目与Windows验证

相关DSH56/56、Pi9/9、Hermes10/10。完整verify首轮旧business-config Pi夹具缺provider/model失败，修夹具后单文件2/2；最终完整verify单次26 Python、9桌面、490桥接、16模拟启动及语法全部通过（无跳过），原失败日志保留。Node24前置子PATH；另检查显式回归脚本语法。

Windows0.5.3真实构建：ASAR16条目/12源文件逐字节，PE x64/产品名/版本、ZIP74 CRC/全hash通过；隔离原生Electron8项含托盘/任务栏/未读/单实例/报告点击保存通过，0渲染错误。包162325625字节，SHA256 a090b86c31662c14e1fd1855018834ca05272a662eb0a5e4c1aee2bc1ceb74c9。EXE在outputs/desktop-v0.5.3/TeamRelay-win32-x64；保留整个目录，包不含后台、三Agent、账号或日志。

私有证据：environment/verification/v053、v053-pi、desktop-artifacts-v0.5.3、desktop-native-v0.5.3；常规原始日志environment/logs/verify-v0.5.3{,-final}.log。源/包Git与Release最终回执见最新HANDOFF/state及远端实查，提交前不预称已上传。
