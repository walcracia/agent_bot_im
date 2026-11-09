# v0.3.0 自动交付版本

2026-11-09，实现前冻结。自动合并后的版本由可信交付层在同步并确认最新base后统一处理；worker一般不改版本，用户明确要求较高版本时可写入该意图。

`stampVersion({cwd,baseRef,versionFile,jsonVersionFiles,pythonVersionFiles})`只接受可信配置中的相对路径，返回`{version,files}`，files仅为实际修改的正斜杠相对路径。不commit/push、不运行模型、脚本或版本命令。

- 用参数数组将baseRef解析为完整Git commit，从该Git对象读取主manifest的版本；不以开发者主检出HEAD替代已确认base。
- 当前工作树主版本严格高于base时，视为显式较高版本意图保留；同号或落后按base的patch递增。接受严格SemVer（可带prerelease），不猜测`v`前缀、范围或其它项目格式。预发布基线的自动提升只去掉预发标记成为同号正式版；无预发基线按patch+1。
- 固定JSON清单只替换顶层`.version`及存在`packages`时的`packages[''].version`；Python只替换恰好一个顶层`VERSION = '...'`或双引号对应值。缺字段、重复/不支持的赋值、非法版本均拒绝。
- 全部文件及内容先验证，才开始写入；精确修改版本字符串，保留其它字段与格式。路径必须在canonical cwd内，不跟随符号链接或硬链接，不进入Git元目录。写入前再次核对原内容与路径，拒绝并发覆盖。
- GitDelivery须先证明存在真实功能变化，再stamp、跑可信测试、按明确文件清单commit。空任务不因版本递增产生PR。两个并行任务在实际合并顺序中分别读取最新base，因此不会都发布同一个patch tag。

验收使用真实临时Git：0.3.0→0.3.1；base0.3.1、当前落后/同号→0.3.2；显式0.4.0保留；JSON字段与依赖版本/格式保持；字段缺失、恶意路径、symlink逃逸及重复Python VERSION时全部文件不写。默认旧未启用versioning的流程保持。此模块无远端或模型调用。

验证结果：`node --test workspace/bridge/test/super-version.test.mjs`的11项全部通过，包含预发布语义、minified JSON、CRLF Python与非版本字节保持、同仓库可信base对象、JSON/Python缺失或重复字段、非法版本、路径穿越、junction/symlink与hardlink保护。文件实际变更清单与Git HEAD不变均已核对。GitDelivery集成另由对应模块验证：同步最新base后stamp，可信测试看到新版本，再明确commit版本文件；普通空变化先skip，不因版本字段单独发布。
