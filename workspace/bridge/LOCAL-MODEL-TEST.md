# 本地模型实测计划（先记录，再执行）

2026-11-07，Asia/Shanghai。主任务授权额外验证共享本机 Ollama：只读 GET `http://127.0.0.1:11435/api/tags`，使用已有模型；不改变服务/模型、不下载模型、不读其他项目凭据、不访问付费API。此测试仅改本项目隔离测试配置/数据。

## 假设与预定配置

- 共享 Ollama 仍在 11435，并已有可用 `qwen2.5:3b`；先读 tags 核实名称。
- 官方 DSH `@deepseek-ai/dsh-llm-pi-ai` [配置文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md) 声明支持 self-hosted OpenAI-compatible 服务，可自定义 route 的 `api: openai-completions`、`baseURL`、`models`。
- 使用 `sdk-minimal` 加 invocation patch，禁用原 deepseek route，新增 `local-ollama` 指向 `http://127.0.0.1:11435/v1`。本地服务若协议要求 key，使用明确非秘密占位字符串；不继承模型提供商凭据。
- 独立 home `environment/tools/dsh/local-model-home`，cwd `environment/tools/dsh/local-model-tasks`；不改现有 bridge SDK home 或任何其他项目/profile。
- 第一轮只发极小文字：`Reply exactly LOCAL_DSH_OK. Do not call tools.`，输出上限64 tokens；不要求写文件。预算单轮最长120秒，无provider重试。配置加载失败或模型失败后，记录边界并停止，不反复调参。
- 如果第一轮成功，再启动独立临时 FastAPI+SQLite 账户/数据，经 IM 消息→真实 SDK+本地模型→机器人回复，仍只要求短文字，不写UI演示数据。此阶段最多一条任务。

## 验收与停止条件

实际 `run()` 返回助手文本、正常turn结束，记录 provider/model和耗时；token统计只取实际trace，不推测。若 model无响应、路由或协议失败，原样记录脱敏错误，终止测试；握手不计模型成功。成功的IM联调需真实消息、真实模型结果和服务器读取到同一回复，测试数据结束后仅清理本次临时目录。

## 实际结果

1. 只读 `/api/tags` 返回4个现有模型：`wuling-qwen3-4b:latest`、`qwen3:4b`、`qwen2.5:3b`、`bge-m3:latest`。选已有3.1B Q4_K_M `qwen2.5:3b`，未修改模型或共享服务。
2. `local-ollama.patch.yml` 按官方协议配置成功，原DeepSeek route禁用，所有执行工具禁用；child环境仅必要系统变量，不继承模型API凭据。SDK使用官方Desktop内置Node24.21与原始SDK0.2.2-rc.1。
3. **纯SDK真实模型通过**：`local-model-smoke.mjs` 实际 `run()` 返回精确 `LOCAL_DSH_OK`，`finishReason=completed`，实测18647ms。此轮不是模拟模型。报告在忽略文件 `environment/tools/dsh/local-model-result.json`。未发工具调用或付费API请求。
4. **IM真实链路通过；严格文本验收失败**：`local-model-im-smoke.mjs` 启动独立临时FastAPI/SQLite，真实创建测试账户/会话，发送 `@dsh 这是本地模型测试。只回复 LOCAL_IM_DSH_OK，不调用任何工具。`，真实桥接调用官方Harness和本地模型，IM中读到单条bot回复 `@dsh LOCAL_IM_DSH_OK`；cursor已确认、current清空。模型多输出了 `@dsh ` 前缀，未通过“只回复token”的exact-match断言，脚本抛出失败。工具调用总耗时8.79秒，模型净耗时未单独记录。专用local-model-home的两份session日志均有 `turn/end: completed`。
5. 按预先停止条件，本次没有重试、换模型或调参。临时IM服务及临时账号/数据库已清理，主UI的18200服务/数据未改。完整真实模型工具写文件仍未测试。

首版IM测试脚本在断言前未写报告；失败输出已如实记录在本文件。随后仅修正脚本，使今后无论exact-match成功与否都先记录 `transportPassed`/`exactMatchPassed`；未为“变绿”重复推理。

## 明确复现入口（会真实使用已有本地模型CPU）

```powershell
& .\workspace\bridge\run-local-model-smoke.ps1 -Mode sdk
& .\workspace\bridge\run-local-model-smoke.ps1 -Mode im
```

这些测试必须显式运行，不加入默认verify或npm test；最长120秒，无自动重试。失败时入口传播非零退出码。Ollama版本/已有模型发生变化时结果也可能变化；不把此次小模型文本实验当作复杂任务/媒体理解或完整Super-agent能力验证。
