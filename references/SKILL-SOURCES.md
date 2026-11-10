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

## 2026-11-10 当前检出的安装复核

- 用户于11月9日要求更新代码并安装两个技能，11月10日明确用proj_multihandoff接续。当前检出已由3ff9870经47b30d5安全快进到a0e9de1deb0c6ec40bdd73c4302d26343ce6247d（v0.3.0）。上次未提交的本代理过程记录先保存在本地分支codex/skills-install-record-20261110的a733c44，再同步并将记录合回当前文档；没有stash/reset或丢弃修改。
- proj_multihandoff最初经系统skill-installer按47b30d5安装；新代码增加长任务参考后，先核对旧安装与旧Git对象一致、备份旧包，再经同一安装器按a0e9de1安装新版。4个文件与仓库源的Git blob逐一一致，随附同步脚本17项隔离测试通过。技能名保留下划线。
- hallmark仍固定官方407fa689f4a276f2fd389208d271d0fef08f5058、2.0.0版；187个文件与上游Git blob逐一一致，官方install.mjs --codex --dry-run通过引用/主题校验，没有真正执行其替换安装分支或添加Claude钩子。
- 两者本机均安装到C:/Users/water/.codex/skills/下。Hallmark上游dry-run提示该位置是其legacy位置，但没有在C:/Users/water/.agents/skills/再装重复副本；本次沿用Codex系统安装器的技能根。其他机器按自己的技能根安装，不复制此机器绝对路径。
- 本次仅安装与验证，没有调用Hallmark重设计、图片生成、付费API或生产DSH任务。Hallmark浏览器渲染仍有其可选Chrome/puppeteer-core前提，不把基础安装校验当作页面渲染验收。
