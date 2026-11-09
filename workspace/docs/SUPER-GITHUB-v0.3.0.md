# v0.3.0 · GitHub 来源与代码交付

2026-11-09，编码前设计。补齐同频任务与 GitHub PR 评审/CI 的连续协作。模块不监听任意仓库或任意 PR；部署配置固定仓库、base、remote、派任务人员、测试命令及合并策略，聊天不能改变这些设置。

## 接口

- `GitHubSource({repository, allowedActors, command?, now?}).poll(bindings, cursor)` 返回 `{events, cursor}`。`bindings` 为 `[{taskId, number, conversationId?}]`，只读取这些 PR。事件包含稳定 `id`、`source=github`、`threadId=github:owner/repo:pr:N`、`taskId`、`kind`、`text`、`actor`、`at` 和 `meta`。
- `kind` 为 `comment`（普通/逐行评论）、`review`、`ci`、`closed`。评论和评审仅允许名单中的人类作者，CI 与关闭是已绑定 PR 的环境事实。CI 完成/失败或重跑产生更新事件；已合并/关闭携带 `meta.merged`，协调层应结束对应任务，不能把关闭事件派成新编码工作。
- 游标是每个绑定对象的版本摘要快照；读取不修改传入游标。协调层先持久接纳事件再保存返回游标。接口报错整次拒绝，不把部分失败伪装成已读。编辑事件、CI 状态变化与重复轮询有稳定身份。
- `GitDelivery({repository, base, remote, testCommands, requiredChecks, autoMerge, reviewers, command?, worktreesPath?}).deliver(task)` / `sync(task)` 返回 `{number,url,branch,head,threadId,checks,merged}`。任务须有 `id/workspace/branch`，只能交付 `codex/` 任务分支，工作树 origin 必须匹配可信仓库。可选 worktreesPath 进一步限定实际目录。
- 协调器传入临时 `task.assertActive()`，每次 add、commit、push、PR 写入或合并前核对持久停止/终态。该函数不进任务账本；终态核对失败后不继续执行后续副作用。

## 交付顺序与恢复

1. 核对实际 Git 根、分支、remote 与工作目录归属；变更文件明确列出，遇到密码/数据库/日志等敏感路径停止，不盲目暂存全部文件。
2. 在实际副本运行可信配置的 argv 测试命令；失败不提交或推送，不把模型自述当作通过。测试自行改变待提交文件时停止，保留现场。
3. 显式文件清单暂存，提交后普通 push；无变更的重试复用已有提交。推送确认丢失时重新读取远端 ref，匹配才继续；不 force push。
4. 按固定 base/head 查找 PR，已有则更新；创建使用临时 body 文件，保留真正换行，确认丢失后再次查询而非立即创建第二个 PR。PR body 使用稳定任务标记及实际测试证据。不同任务或不匹配的 base/head 不复用。
5. 默认不自动合并，`mergePolicy`默认`review`。review保持原门禁：显式autoMerge、必需检查、可信审查者在此head批准且无要求修改。用户本轮另明确选择“可信测试通过后自动合并”，新增仅可信配置可开启的`mergePolicy: verified-tests`；此策略仍需autoMerge=true及非空可信测试命令，允许没有GitHub检查/独立reviewer。配置了requiredChecks时仍必须全部成功，不能忽略失败CI。两种策略都带`--match-head-commit`合并，不绕过分支保护。

2026-11-09新增验收：verified-tests使用真实测试成功证据、源码/索引/HEAD指纹及提交树核对，合并前再核对固定仓库/base/任务分支和已测试head、干净状态。GitHub新PR的mergeable未知时仅5次、间隔750ms只读查询，head/base变动立即拒绝；不重复测试、提交或推送。合并调用丢确认时只读核实实际merged状态，不盲目重复合并。聊天和PR正文不能切换策略。

verified-tests交付按实例串行，编码Worker仍可并行。此策略默认`syncBaseBeforeMerge=true`：初次测试并提交明确改动后fetch固定origin/base；若该base不在任务HEAD祖先链，在独立任务分支普通merge并重新运行同一可信测试与源码/索引/HEAD指纹核对，冲突保留不reset。返回`verifiedBase`；最终GitHub PR.base.sha若提供，必须与其一致，base在等待期间推进即拒绝本轮自动合并，不能只测试旧base就合并。review默认不增加自动合并base动作。

已关闭未合并的owned PR只有协调器因原群明确继续设置`task.resumeClosedPr=true`后才能reopen；先读取完整版确认仓库/分支/base/未merged，验证通过后执行一次reopen并只读确认open，才继续推送和交付。没有可信flag不复活；merged PR永不reopen，应由协调器派生独立后续任务并引用原任务。

自动发版版本戳仅由可信`versioning.enabled=true`启用：在最新base合入后用`super-version.stampVersion`修改配置列出的版本字段，基于当前base递增patch，保留明确更高版本。随后重新运行可信测试并核对源码/索引/HEAD，成功后仅暂存返回的固定版本文件、提交并更新final head。worker不负责自行选择版本，避免并行任务同版碰撞。普通新任务如有可信baseCommit，必须在版本戳之前证明实际base-to-current代码变更；无变更返回skipped，不以版本戳制造空PR。无baseCommit的legacy非spec任务保留兼容；spec基线缺失仍拒绝。

所有 Git/gh/测试使用参数数组，无 shell；错误不回显令牌或完整原始 CLI 输出。源码中的支持不等于本机已经做过真实 GitHub 写入。

需要Git HTTP代理的机器可在可信配置指定 `gitProxy`，或以 `proxyEnv` 指定保存代理根地址的环境变量名。仅本次Git调用增加 `-c http.proxy=...` 和子进程代理环境；gh API保持原连接方式，不修改全局Git或父进程环境。代理地址不接受凭据、额外路径或参数，示例不内置某台机器的端口。

## 验收

隔离临时 Git 仓库与裸远端验证真实差异、失败测试阻断、提交/重试/远端确认；假 gh 验证 PR 创建丢确认、评论编辑去重、review/CI/关闭后续、白名单、错误游标、自动合并检查和 head 防竞态。测试不调用模型、不接触真实团队 PR。

本轮模块验证：`node --test workspace/bridge/test/super-github.test.mjs` 最终通过14项（新增即使忽略规则移除也拒绝附件目录交付）。独立协调层集成验证 `super-integration.test.mjs` 通过6项，覆盖启动窗口的停止/补充、PR终态保留、成功CI和批准不启动新编码、旧head失败隔离与同head单次修复。早期集成曾复现批准后未触发交付的问题，协调层修正后复验通过；这不是实际云端/GitHub写入验收。

后续按用户明确选择增加verified-tests及版本戳的最终回归为30/30（2026-11-09）。新增测试覆盖无review API自动合并、mergeable有界等待、失败测试/脏源码/变动head/指定CI失败拒绝、最新base合入重测与冲突保留、串行交付、closed显式复活/merged不复活、普通无变更在stamp前结束，以及实际node测试读到0.3.0和stamp后0.3.1再提交最终PR head。首轮fresh-base夹具因Windows Git自动换行与LF断言不符失败，修正平台换行断言后完整复验通过；未进行线上merge。
