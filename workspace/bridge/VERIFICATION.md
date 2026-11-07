# DSH 桥接验证记录

日期：2026-11-07（Asia/Shanghai）。执行环境 Windows x64，系统 Node22.14 仅运行桥接逻辑测试/解析依赖；真实 DSH 运行在官方 Desktop 的 Electron Node24.21。上游版本固定 `0.2.2-rc.1`。

## 已通过

- 官方下载签名验证 Valid，固定 SHA-256 校验；NSIS与app-64.7z原始 payload 解压，无系统安装。
- 官方源码 commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 已检出；官方CLI `--version` 为 `0.2.2-rc.1`。
- `setup-desktop.ps1 -CheckoutSource` 成功：校验/复用隔离部署，并调用真实握手。
- 真实 `HarnessClient.initialize` → `getWorkingDirectory` → shutdown → 新进程 initialize → `resumeSession` → 工作目录一致 → shutdown。实际 peer `deepseek-harness-sdk-runtime`、wire version `0.0.1`，目录为本项目 `environment/tools/dsh/tasks`。零 prompt、零模型请求。
- `node --test workspace/bridge/test/*.test.mjs`：12项全部通过。覆盖授权过滤、机器人回路排除、已提交但丢响应的幂等重发、游标/状态恢复、执行中断不自动重跑、配置撤销、并发锁、Unicode回复分片、附件限制/校验、预置硬链接和目录链接不覆盖工作区外文件。
- HTTP联调项实际启动独立临时 FastAPI+SQLite进程，通过真实 HTTP 创建账号/会话、上传附件、发送消息、bot读取事件、桥接取附件、提交回复；丢失已提交回复的响应后从状态恢复，服务端只有一条bot结果，事件流不回收bot消息。执行器特意是 `TEST_EXECUTOR_ONLY`，不是模型结果。
- SDK npm 完整精确依赖解析成功，生成 package-lock。安装阶段上报系统Node22不满足上游Node>=24.9；没有用该Node运行DSH。Windows已验证的Desktop路线无需另装这套依赖树。

## 发现并修复

- Windows `--import` 需要file URL，不能直接传盘符路径；启动脚本已转换。
- 标准module resolver hook内的require.resolve会重入；增加重入guard后成功，未修改任何上游JS。
- 固定握手session名在第二次启动会与持久记录冲突；改为唯一ID，并进一步验证跨进程resume。初次失败保留于忽略日志，不能把该失败当通过。
- 独立审查复现 stale 锁“读取旧PID→检查退出→unlink”会误删并发新锁。已取消所有自动 stale 清理：任何既有锁均拒绝启动，仅允许操作者确认相关进程全部退出后精确删除锁文件，保留状态/游标。新增12路并发的新锁竞争与旧锁竞争测试；前者只有一个持有者，后者全部拒绝且锁文件原样保留。
- 独立审查复现可预置 incoming/event/.part 硬链接覆盖 cwd 外文件。已改为解析 cwd 后直接 mkdtemp 随机私有目录、wx创建payload、真实路径包含关系检查、不做覆盖式rename。新增外部sentinel硬链接与incoming目录junction测试，二者均不改变cwd外文件。此措施不声称抵御同OS用户恶意并发进程，真正执行隔离仍需专用账户或容器。

## 未验证/边界

- 没有本机从官方源码重新编译整个Desktop；部署的是官方编译、签名发行包。
- 没有使用付费模型凭据，真实模型任务、工具实际执行与结果回传仍需操作者的模型配置。不能把握手或测试执行器视为真实模型任务通过。
- 本桥接逐任务执行，尚无文章中的全局Router/并发Worker/主动语义观察/Watchdog；另一台真实DSH主机与腾讯云生产服务尚待联调。

发生中断的模型任务采用uncertain状态，必须人工判断后显式retry/skip；分布式工具副作用不提供exactly-once承诺。持久输出+IM幂等ID保证的是结果回复不重复。
