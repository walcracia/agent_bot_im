# 同频TeamPlay v0.5.0 验证记录

2026-11-21。范围：可信能力登记、通用只读AI分流、业务Worker、DSH/Hermes/Pi原生执行、真实IM正向及三Agent回归。QA日志由用户明确暂停等待公司VPN，不作为本轮已恢复能力；未部署腾讯，未重建Windows包，v0.3.3客户端兼容。

## 实际主流程

授权聊天中发送三条独立自然语言请求，真实AI返回已登记Worker/Agent选择，均第一次执行完成：

| 业务 | 实际选择 | 验证 |
| --- | --- | --- |
| 收款统计与重复核对 | 数据核对Worker → Pi | 总计与重复金额正确，原生settled/stop/idle、退出码核验。 |
| 会议纪要待办 | 文档Worker → Hermes | 原生已登记Skill真实加载；责任人/期限/未明确字段保留，prompt end_turn。 |
| 代码片段漏算检查 | 代码检查Worker → DSH | 返回正确结果与可核对建议，native completed/exit0。 |

三项各一条原结果+完整TXT，成员认证下载、内容、字节/SHA均通过。服务正常重启/重复启动后，原B任务仍completed/attempt1，重新读取三报告与下载通过，未重做模型。健康版本0.5.0，QA仍关闭。

另有三执行器各自真实文件冒烟；DSH实际调用原生Skill→MCP→写文件，输出随机工具receipt与实际MCP audit匹配；Hermes原生Skill冻结策略中核对到技能ID及加载正文哈希。Pi原生MCP支持由后续真实回归工具调用证明，不以配置文件存在冒充接通。

## 三原生Agent回归与协调修正

每Agent独立源快照和会话，经固定stdio MCP执行指定Node测试，并写审查报告。核对原生工具事件、随机nonce、测试stdout SHA、源码清单SHA和源未改动；普通mock协议测试与这些真实会话分开。

| Agent | 最后冻结版指定套件 | 实际测试结果 |
| --- | --- | --- |
| DSH | 能力登记、业务Router、业务Worker | 15/15，原生MCP调用1次，报告/源哈希通过。 |
| Pi | 三执行器协议 | 17/17，原生MCP调用1次，报告/源哈希通过。 |
| Hermes | 运行配置、协调器、生命周期 | 41/41，原生MCP调用1次，报告/源哈希通过。 |

首轮失败保留：Pi默认MCP曝光为codemode，而精简扩展加载未向模型声明工具，缺少原生MCP证明，不能算通过。已默认direct并明确拒绝尚不支持的deferred/codemode，再有目的重验通过。Hermes首轮固定MCP测试40/41，原因是gateway子环境找不到PS7；根环境实际已装PS7。回归工具固定可信PowerShell/Node路径后41/41，不添加5.1回退、不弱化进程身份核验。

采纳并验证的源码修正还包括：大小写及尾部标点的裸B编号仅查状态、不额外派任务；进程身份查询保留底层cause；Watchdog识别协调器实际preparing/delivering状态。后两项不表示旧编码A1/A2均已修复。

审查意见经协调者裁决：资源“丢失”与实际对象spread、原生Skill主流程不符；模型调用前尚无Agent进程不需要伪造停止证明，调用前已设置admitted标识；未知停止时保留MCP/锁属于原恢复规则，未采纳自动删除建议。Hermes另提出初始密钥写入、recovery guard、停止异常清理等未动态复现的维护边界，保留记录，不称已修复。DSH一次试图修改审查快照，操作失败；最终清单未变，正式源码未受影响。审查Agent报告不是未经核实的事实。

## 常规检查与范围

完整verify通过26 Python、9 desktop、480桥接测试（479通过、1跳过）、16模拟Windows启动及入口语法；最后修正后完整桥接481/481通过，无跳过；相关34/34通过。另修正原技能夹具的cwd定位后，在标准workspace工作目录5/5真实CLI/原提示测试通过，不再因相对路径错误跳过。锁文件只更新应用版本，依赖未升级。

可复验的原生Agent脚本已提交源目录environment/scripts/verify-agent-reviews.mjs及agent-review-mcp.mjs：从可信本机配置读取三执行器必要路径，固定Node24/PS7和工具代次，prepare不调模型，run-agent必须显式live。新可移植脚本语法、零模型准备及未显式live拒绝已验证，未以其零模型准备冒充上述真实原生回归；原始真实证据代次原样保留。

本轮实现可登记Worker及三执行器、Skill/MCP资源映射，处理给定消息和同条附件；不把通用代码检查当作任意项目自动修改/PR/发布，不宣称未登记业务系统、OpenCode、OS沙箱或插件市场已经完成。旧项目代码Worker与QA专用流程保持各自边界。

原日志、聊天、账号、认证和原生事件只在忽略的environment/verification/v050与运行目录。此处仅提交脱敏方法与结果；重启先读AGENTS/RESTORE/state/HANDOFF及WORKER-ROUTING设计。Git分支/tag上传以实际查询回执为准。
