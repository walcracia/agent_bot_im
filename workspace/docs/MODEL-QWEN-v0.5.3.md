# v0.5.3：统一Qwen4 Max与High思考

2026-11-23，实施前设计。用户明确要求Hermes、Pi、DSH都使用Qwen4 Max、thinking-high，覆盖此前DSH/DeepSeek/max。附图显示XHigh，但用户文字指定High，本轮采用High，不默默升档。

## 配置及执行

先读取三执行器本机模型目录/协议，核实Qwen4 Max真实provider/model标识、已有认证和High原生映射；显示名、订阅供应商标签不能直接当模型ID。模型和思考参数来自可信本机配置，不让聊天生成端点、命令或凭据。

同频的三业务执行器、DSH业务Router、QA模型调用、旧headless基础路径及显式原生回归入口采用同一目标模型和High。新会话及原会话接续都应明确选择并核对实际生效。移除旧max-only门禁/措辞及隐式默认档，不静默回退其他模型或努力档。不修改原生安装；如调整原生CLI/Desktop默认模型，先核对配置作用域并备份，只调整用户本次明确指定的模型字段，保留其他配置。

QA仍保留原插件完整解析、材料与system/user和原报告原文，只有用户授权的模型/思考控制改变；输出容量沿用目标模型原生能力，不新增次数、阅读或分析总时长额度。Skill/MCP、权限、工作目录、会话、取消与凭据隔离沿用已验证契约。旧已完成任务不因换模型自动重做。

## 验收及交付

三个执行器分别保存新调用的模型、provider、High实际生效证明及原生完成回执，覆盖各自不同的原生设置方式，不能只改UI标签。参数映射可先用原生零模型配置/adapter取证；随后通过授权IM完成三条独立可复核任务，原结果与TXT在原聊天可下载，旧任务/会话记录保留。缺少已有认证或平台不支持该型号/High时，明确询问实际缺项，不伪造完成。

实现后运行相关及项目必需回归，正常重载和复用服务，打包Windows0.5.3并校验实际EXE/托盘/报告下载。设计/过程/接续/脱敏报告、明确文件清单commit、新annotated tag、Git及Release资产远端确认齐全。配置备份、原生账号、原始请求及聊天材料只留忽略目录。

## 原生协议核对与配置实现

官方Qwen4 Max接口使用实际ID `qwen4-max`，Chat Completions指定 `reasoning_effort:high`，可用档为low/high/xhigh；不同时发送thinking_budget。模型总窗口1,000,000，思考和正文总输出上限262,144；max_completion_tokens用于总输出。依据：[Qwen官方型号](https://docs.qwencloud.com/developer-guides/getting-started/latest-model?date=2026-11-16)、[思考参数](https://docs.qwencloud.com/developer-guides/text-generation/thinking)。

DSH现有自定义provider已包含Qwen4，但旧目录缺少reasoningEfforts。只在已备份的用户配置中补官方目录字段，默认High；原生PiAiAdapter零网络截获确认High与max_completion_tokens262144，未伪造请求。headless、Router与原QA直接调用沿同一部署选择。

Pi旧目录更新后仍无Qwen4，因此通过原生models.json追加真实模型定义，保留已有endpoint和认证引用；thinkingLevelMap显式登记High，compat使用qwen和max_completion_tokens。每次新建/恢复先set_model、读取可用思考档、设置High并get_state核对；任务自己的before_provider_request只观察模型/思考控制，不保留请求正文、密钥或请求头，不修改原请求。完成还需原生模型/档位与每次请求证据相符。

Hermes内置DashScopeProfile忽略reasoning_config，单改ACP显示不足以证明High。采用原生providers配置别名及现有key_env，native custom路由明确extra_body.enable_thinking=true/reasoning_effort=high；未修改安装。明确Qwen4模型目录与官方context，关闭该已声明provider无必要的/models自动探测。新建/恢复都由ACP选完整custom provider:model ID，读回model和High，原生构造请求零网络核对参数及原凭据复用。provider级extra_body仅供本次Qwen4配置，手工改用其他模型需重新核对支持档位。

所有用户配置改前保存在忽略的environment/verification/v053/config-before。未复制账号到仓库或包，也不把未发生的模型调用计为真实通过。

## 实测修正与原生可见性

DSH的desktop目录与headless路由隔离；后台必须在自己的用户patch登记同一Qwen provider和已有apiKeyEnv引用，不能仅改桌面。真实接口拒绝developer角色后，使用原生compat.supportsDeveloperRole=false，保留system原文字节。Pi与Hermes旧key在真实接口被401拒绝；备份后用本机已实证同endpoint的DSH有效credential，分别写入Pi原生auth及Hermes受支持save_env_value_secure，不输出/提交密钥。Pi沿原session完成，不抹去401历史。

DSH桌面进程保留旧会话列表；确认无活动任务/草稿后，通过原生应用菜单正常退出并重开同一安装，才实际显示新会话。没有手写索引、伪造消息或杀共享服务。Pi通过原生Desktop列表核唯一原ID及中文结果。Hermes来源仍tool/acp，不伪装成人工聊天。

Pi自定义Token Plan目录中cost=0是本地未定价占位，不能视为实际账单为零或宣称免费；验收仅核型号/思考/请求/工具及原生token口径。
