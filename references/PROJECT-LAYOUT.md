# 项目目录约定

项目作为 `CodexProjects` 的直接子目录，Git 根目录就是项目入口；不要在其下再 clone 一个同名仓库，也不要为模仿旧迁移项目而新建 junction。

本仓库沿用首次开发时确定的四层结构：

| 路径 | 内容 | Git 策略 |
| --- | --- | --- |
| `workspace/` | 服务、客户端、桌面、桥接、部署、测试、设计与交接文档 | 源码和依赖锁提交，安装依赖不提交 |
| `references/` | 来源、布局和工具安装信息 | 提交可分享资料 |
| `outputs/` | 脱敏验收报告、交付说明 | 报告提交；EXE/ZIP 使用 Release，二进制不进源码历史 |
| `environment/config/` | 依赖锁、配置示例；本机账号与配置 | 锁/示例提交，真实配置忽略 |
| `environment/scripts/` | 可复现的安装、启停、验证入口 | 提交 |
| `environment/logs/`、`verification/` | 原始日志、测试数据库、截图和报告 | 忽略；脱敏结论移到 outputs |
| `environment/venv/`、`tools/`、`data/`、`build/` | 本机解释器、工具、聊天数据、构建中间文件 | 忽略，不跨 agent 复制私有环境 |
| `.agents/skills/proj_multihandoff/` | 可随 Git 交接的通用 skill | 提交，与独立分发副本保持一致 |

根 `AGENTS.md` 定原则，`RESTORE.md` 定恢复入口，`environment/state.json` 记录结构化状态，`workspace/docs/HANDOFF.md` 记录下一位 agent 的入口和限制；设计/API/决策/过程/验收文档放 `workspace/docs/`。

2026-11-08 接续时确认：当前父目录中没有旧文档提到的 `ENVIRONMENT-LAYOUT.txt`，相邻项目包含多种既有源码布局。本约定将本仓库已有布局自包含保存，不移动相邻项目或强行统一其内部结构。
