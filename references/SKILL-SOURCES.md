# Skill 来源与分发

## Hallmark

- 上游：https://github.com/nutlope/hallmark ，skill 子目录 `skills/hallmark`。
- 2026-11-08 安装时上游 main：`407fa689f4a276f2fd389208d271d0fef08f5058`，版本 2.0.0。
- 本机位置：`C:/Users/water/.codex/skills/hallmark`，通过 Codex `skill-installer` 的 `install-skill-from-github.py --repo nutlope/hallmark --path skills/hallmark --method git` 安装。
- 安装后执行上游 `scripts/install.mjs --codex --dry-run`，引用与主题校验通过；没有运行页面重设计。
- 其他 agent 可用 skill-installer 安装；上游安装入口为 `npx skills add nutlope/hallmark -g --agent codex`。需要精确复现时检出上述 commit，再运行上游安装脚本。不要把本机绝对路径当作其他机器的安装位置。

## proj_multihandoff

- 用户指定名称 `proj_multihandoff`，保留下划线。
- 仓库分发源：`.agents/skills/proj_multihandoff/`，pull 后可读；支持项目级 skill 的 agent 可直接发现。
- 本机安装：`C:/Users/water/.codex/skills/proj_multihandoff/`。
- 独立副本：`D:/Work/CodexProjects/skill/proj_multihandoff/`，供用户单独上传 Git；未擅自创建另一个远端仓库。
- 三份内容交付时按 SHA-256 核对；后续修改应先改仓库源，再同步已存在的本机/独立副本。
