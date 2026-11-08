# 同频 · Team Relay

小团队文字与文件沟通工具，Windows 客户端，Linux 私有服务器，支持图片、音频、视频和普通文件（每个文件严格小于 100 MB），可连接 DeepSeek Harness 工作助手。

v0.2.0 可在授权项目群中识别普通讨论里的代码任务，由本机已安装 DSH 在独立工作副本中修改、测试并回传。首次绑定见 [本机自动编码接入](workspace/bridge/README.md)；现有 v0.1.2 Windows 客户端继续兼容。

- [使用与开发入口](workspace/README.md)
- [设计和接口](workspace/docs/DESIGN.md)
- [腾讯服务器部署](workspace/deploy/README.md)
- [DSH 接入](workspace/bridge/README.md)
- [恢复与接续](RESTORE.md)
- [多 agent 接续 skill](.agents/skills/proj_multihandoff/SKILL.md)（首次传 Git 地址，后续检查并 pull）
- [自包含目录约定](references/PROJECT-LAYOUT.md)
- [v0.1.2 新版界面预览](outputs/design-preview-v0.1.2/index.html)（真实验收截图，可切换页面与尺寸）

源码在 workspace，交付在 outputs，本机配置与数据在 environment（敏感内容不进 Git）。每个已验证迭代均提交和打 tag，见本仓库 Releases/Tags。
