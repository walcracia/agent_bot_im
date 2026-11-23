# 大模型与Agent能力调查

查询日期：2026-11-23。范围：主流通用模型、DSH/Pi/Hermes，以及Claude Code、Codex、OpenCode。证据来自模型提供方、原始模型卡、Agent官方仓库/文档和评测组织自己的榜单。以下区分公开测量、官方能力说明、工程判断与本机已验证能力；没有重新调用收费模型做横评。

主要结论是：模型、运行器、业务流程分别影响结果。模型提供推理和生成能力，Agent运行器组织工具与会话，Skill/MCP及材料组织决定它能看到什么、执行什么。没有证据支持长期把DSH限定为代码、Pi限定为算数、Hermes限定为文档。

## 公开模型快照

下表采用Artificial Analysis同一Intelligence Index v5.0.1模型页面的查询时快照，保留其思考档。指数越高越好，不是百分比。[方法说明](https://artificialanalysis.ai/methodology/intelligence-benchmarking)指出：它主要是英文/文字评测，综合知识工作、编码、科学与常识；中文、视觉和音频能力还有单独评测；主指数的部分题也会向支持图像的模型提供图像。因此它不能直接代表中文汽车OTA日志根因准确率。

成本是该评测组合的加权平均模型费用，时间是基于输出量和速度的加权平均估算；都不是同频一次任务的报价或完整墙钟耗时，不含本业务下载、解包、解析等步骤。套餐权益、API单价、评测每任务成本是三种口径，不能混用。

| 模型与评测配置 | 综合指数 | 评测美元/任务 | 评测估算分钟/任务 | 原始测量 |
| --- | ---: | ---: | ---: | --- |
| Claude Fable 5.2，max / Default Fallback | 65 | 26.54 | 41.5 | [模型测量页](https://artificialanalysis.ai/models/claude-fable-5-2) |
| GPT-6.2 Astra，max | 62 | 4.00 | 14.1 | [模型测量页](https://artificialanalysis.ai/models/gpt-6-2-astra) |
| Gemini 4 Neon，xhigh | 61 | 6.44 | 23.6 | [模型测量页](https://artificialanalysis.ai/models/gemini-4-neon) |
| GPT-6.2 Sol，max | 57 | 1.01 | 10.0 | [模型测量页](https://artificialanalysis.ai/models/gpt-6-2-sol) |
| Kimi K3.1 Pro，榜单当前配置 | 46 | 3.68 | 37.0 | [模型测量页](https://artificialanalysis.ai/models/kimi-k3-1-pro) |
| Qwen4 Max，榜单当前配置 | 43 | 3.27 | 27.4 | [模型测量页](https://artificialanalysis.ai/models/qwen4-max) |
| DeepSeek V4.1 Flash 1017，max | 33 | 0.60 | 14.0 | [模型测量页](https://artificialanalysis.ai/models/deepseek-v4-1-flash-1017) |
| GLM-5.3，max | 32 | 5.01 | 29.8 | [模型测量页](https://artificialanalysis.ai/models/glm-5-3) |
| MiniMax M3.1 Flash，榜单当前配置 | 29 | 0.49 | 17.6 | [模型测量页](https://artificialanalysis.ai/models/minimax-m3-1-flash) |

Fable行保留榜单的Default Fallback标签；不要把不同思考档、回退设置、评测版本和不同日期的指数混排。小分差也不是某个具体业务上稳定胜出的证明。上表为本次所选候选，不是所有模型的完整排名。

## 模型的可证优势与主要代价

| 模型/系列 | 有依据的强项或候选用途 | 代价与边界 |
| --- | --- | --- |
| GPT-6.2 Astra / Sol | 官方分别定位困难专业项目与日常高效率工作；适合复杂推理、编码和专业交付的不同档位。 | Astra模型单价更高；本次AA里Sol的费用/时间更低。官方API均为文字/图像输入、文字输出，音视频需另接通道。[官方发布](https://openai.com/index/introducing-gpt-6-2-astra-sol/)、[Astra规格](https://developers.openai.com/api/docs/models/gpt-6.2-astra)、[Sol规格](https://developers.openai.com/api/docs/models/gpt-6.2-sol) |
| Claude Fable / Opus / Sonnet / Haiku | 官方建议多数任务先Opus5.5；困难推理/长程任务升级Fable5.2；Sonnet5.5兼顾速度，Haiku5.5面向分类、提取及路由。 | 不能把最高综合档当所有任务的默认选择。当前通用模型都是图文输入、文字输出。[官方模型总览](https://platform.claude.com/docs/en/models/overview) |
| Gemini 4 Neon / Hydrogen | 官方API直接接文字、图像、视频、音频和PDF；对录像/录音混合材料有明确的输入通道优势。Hydrogen偏效率，Neon兼顾更复杂任务。 | 输入支持不等于每类题准确率都第一。视频默认采样1FPS，瞬时故障可能漏；统一1M上下文包含输入和输出。[Neon](https://aistudio.google.com/docs/models/gemini-4-neon)、[Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen)、[视频说明](https://aistudio.google.com/docs/video-understanding) |
| DeepSeek V4.1 Flash 1017 | 图文、工具调用、思考档及开放权重，适合纳入成本敏感执行候选；本项目已有日志流程兼容依据。 | 本次综合指数与前三名存在差距；并不能据此直接断言日志skill效果差。公开API别名升级不证明订阅通道恰好同一服务版本。[官方更新](https://api-docs.deepseek.com/updates/)、[官方模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017) |
| Qwen4 Max | 当前旗舰服务强调视觉、长任务和工具工作，可列为国内综合业务/多模态候选。 | 本次只核到旗舰服务入口，不能借其他Qwen型号的许可宣称其权重已开放。[官方发布](https://qwen.ai/blog?id=qwen4-max) |
| GLM-5.3 | 官方重点涉及工程与长程工具任务，可列为代码/业务执行候选。 | 旗舰是文字模型；GLM-5.3-Flash才是原生图文型号。二者能力、许可证和价格不同，不能混为一行。[旗舰模型卡](https://huggingface.co/zai-org/GLM-5.3)、[Flash模型卡](https://huggingface.co/zai-org/GLM-5.3-Flash) |
| Kimi K3.1 Pro | 图文、长上下文、研究与办公任务；在本次列出的国产候选中AA综合分最高。 | 模型体量大，开放权重与自定义许可不代表轻量机器可运行；本次AA耗时、费用也不低。[官方模型卡](https://huggingface.co/moonshotai/Kimi-K3.1-Pro) |
| MiniMax M3.1 Flash | 图文/视频、工具和编码方向，低API单价，适合批量任务候选。 | 思考常开，可调深度；本次综合指数低于前述旗舰。输入视频不代表能生成视频。[官方模型卡](https://huggingface.co/MiniMaxAI/MiniMax-M3.1-Flash) |

这些用途是结合规格与公开测量形成的选型假设，仍需业务实测。没有找到足够同条件、覆盖以上当前型号的中文OTA业务评测，不能给出“中文最强”“日志最强”的确定排名。

长上下文只说明容量。OpenAI当前Astra/Sol的统一上下文约105万，Claude当前模型约100万，Gemini约105万；输入上限、最大输出及长解码规则各异。不能把“1M”理解为能无遗漏阅读任意百万tokens日志。原始上下文、OCR/转写、检索、时间窗口和报告契约都应计入同频的能力登记。

开放权重也需区分许可：DeepSeek该型号为MIT；GLM-5.3为自定义许可、GLM-5.3-Flash为MIT；Kimi和MiniMax使用各自许可。大型权重本地推理需要相应计算资源，同频服务器部署与模型自部署是两项不同工程。

## Agent运行器比较

下表强弱是基于官方功能的工程判断。运行器自己的模型、工具、权限和提示都能改变，不能将它们当固定认知模型排名。

| 运行器 | 相对强项 | 主要限制与同频接入意义 |
| --- | --- | --- |
| DSH | Cordis插件化覆盖模型适配、工具、会话与循环；headless/SDK/ACP等入口。 | 灵活但插件组合与升级维护成本存在；官方仍为开发预览。现有日志插件可完整复用，是本项目选择它的明确依据。[架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[预览与控制边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) |
| Pi | 精简、可扩展，JSONL RPC/SDK适合嵌入自有调度；技能、模型与工具可配置。 | 默认不包办子Agent/规划模式，上层需补编排；自身不提供OS沙箱。适合通用执行器，不应限定算数。[官方说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)、[RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、[安全政策](https://github.com/earendil-works/pi/blob/main/SECURITY.md) |
| Hermes | 跨会话记忆、技能积累、gateway、定时和子Agent，适合长期重复业务。 | 持久组件较多，部署与排障更复杂；所谓成长是记忆/技能机制，不是模型权重自己增强。[架构](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)、[功能](https://hermes-agent.nousresearch.com/docs)、[技能](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| Claude Code | 代码库、命令、Git/PR、MCP/Skills及开发工具集成完善。 | 主要围绕Claude生态，团队模式仍列有实验性与恢复限制；可列专业研发候选，不能由品牌推断所有自动化可靠。[概览](https://code.claude.com/docs/en/overview)、[Agent Teams限制](https://code.claude.com/docs/en/agent-teams) |
| Codex | App Server有持久thread、事件、steer/interrupt/恢复和批准流程，适合需要持续控制的执行接入。 | 需核对自定义provider协议，当前文档以Responses为准；不能把任意Chat Completions兼容端点当可直接接入。本项目尚未适配。[App Server](https://learn.chatgpt.com/docs/app-server)、[provider配置](https://learn.chatgpt.com/docs/config-file/config-reference)、[Windows沙箱](https://learn.chatgpt.com/docs/windows/windows-sandbox) |
| OpenCode | 多供应商、Skills/MCP、Agent配置及共享服务，适合可替换模型的自建集成。 | 当前已进入V2，接口/包名迁移需核对；本项目尚未适配，权限配置也不等于OS沙箱。[概览](https://opencode.ai/docs/)、[供应商](https://opencode.ai/docs/providers)、[Agent配置](https://opencode.ai/docs/agents) |

Pi当前官方支持MCP的stdio/streamable HTTP及direct/deferred/codemode等曝光；“Pi没有MCP”的旧概括不适用。[官方MCP文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) 同频现适配仅实装并验收direct，不能把所有上游能力算成本项目能力。

版本同样要分开。此次本机零模型`--version`实查为DSH0.2.2-rc.3、Pi1.5.2、Hermes0.23.2；官方发布页当前分别列DSH0.2.3-alpha.2、Pi1.6.0、Hermes0.23.3。上游文档可能描述新版本，不能直接套到已装版本。来源：[DSH](https://github.com/deepseek-ai/deepseek-harness/releases)、[Pi](https://github.com/earendil-works/pi/releases)、[Hermes](https://github.com/NousResearch/hermes-agent/releases)。此次未升级本机。

## 执行成绩为什么要看组合

[Terminal-Bench当前官方榜](https://www.tbench.ai/)为4.1，明确同时列MODEL和AGENT。查询时Claude Code+Opus5.5为65.8%±3.1%，Codex+GPT6.2Astra为62.1%±2.3%，Claude Code+GLM5.3为41.2%±3.3%，Claude Code+DeepSeekV4.1Flash1017为38.5%±3.8%。这是不同模型/运行器组合的测试；部分区间重叠，不能直接据此宣布运行器谁更强。AA v5.0.1综合指数的组件仍使用Terminal-Bench4.0，上述官网独立榜为4.1；这里没有将两个版本的数值拼接。

[SWE-bench官方说明](https://www.swebench.com/)的默认Verified bash-only视图将模型放在同一个mini-SWE-agent环境，有助于控制运行器变量。不同SWE子集、不同harness或Terminal-Bench版本的数字不能拼接。软件任务分数也不自动代表本团队文档、数字核对或日志业务成绩。

项目v0.5.0中DSH15/Pi17/Hermes41项是不同套件，三条IM任务又是不同业务；它们证明接通、终态、工具、文件和回传有效，不能用通过数量评强弱。具体本机账号/供应通道映射仅留忽略配置，订阅别名与公开榜单版本也不强行等同。

## 对同频路由的建议

先识别业务与输入，再按所需Skill/MCP、工具和许可筛选执行器，最后在可用模型/思考档组合中参考真实业务质量、耗时和费用选择。账本应记录完整组合版本及材料配方，而不是仅存Agent品牌。

| 任务条件 | 调研支持的候选选择 | 尚需验证 |
| --- | --- | --- |
| 原DSH日志插件业务 | 沿用已验收的DSH与原Skill/材料流程、用户指定max。 | 同材料、同skill比较其他模型，不能只依据综合榜改主要结论。 |
| 明确的代码、数字、文档任务 | 先选择需要的工具/技能；DSH/Pi/Hermes均可作为兼容执行候选。数字核对优先用计算工具核验。 | 取消“业务类别天生只能用一个Agent”的假设，以业务验收决定可选组合。 |
| 简单分类、提取与调度 | Haiku等经济档可列候选；重点看字段正确、误派率、延迟。 | 中文消息、取消/补充、模糊意图、实际套餐和接入兼容性。 |
| 复杂研发、长程判断及复核 | Astra/Opus/Fable等高能力档可列候选；Sol/Sonnet/Hydrogen作为效率档。 | 必须在同一业务验收条件比较，不按最高档一律处理所有任务。 |
| 图片、录像、录音、扫描件 | 优先筛查模型输入支持以及Agent的OCR/转写/视频读取工具；Gemini原生音视频是可验证候选优势。 | 同频能传文件不等于当前Worker已能理解所有媒体，瞬时故障还要验证采样。 |

可执行的后续横测应控制变量：固定Agent/Skill比较模型，固定模型/Skill比较Agent，最后固定两者比较材料与Skill流程。使用同一组中文业务样本、可复核答案和相同权限；首要指标为正确完成率、证据/产物质量，然后看耗时与实际消耗。该建议不新增调用额度或停止条件，也不构成本轮已执行横测的声明。

本轮是调查，未修改当前路由：现有code-check仍只允许DSH、data-check只允许Pi、document-actions只允许Hermes；放开为多候选属于后续设计建议。

这份调查作为能力登记的先验依据。应让模型、Skill、MCP和运行证据共同决定选择；没有依据将现有固定品牌分工作为长期能力结论。
