# agent-IM 恢复与接续

项目根：`D:\Work\codexproj\agent-IM`。

1. 阅读根 `AGENTS.md`、`environment/state.json`、`workspace/docs/HANDOFF.md`。
2. 阅读 `workspace/docs/DESIGN.md`、`API.md`、`DECISIONS.md` 与 `PROCESS.md` 最新记录。
3. 查看 Git 状态和 tags，确认远端推送是否完成；保留已有修改。
4. 按 `environment/README.md` 恢复本机环境。数据库和密钥在忽略目录，不进 Git。
5. 执行 `environment/scripts/verify.ps1` 后再判断当前可用程度，正式报告写入 `environment/verification/`，可发布报告复制至 `outputs/`。

遵循同级项目的 workspace/references/outputs/environment 布局。安装、启动和验收应通过脚本完成，不能依赖聊天上下文。
