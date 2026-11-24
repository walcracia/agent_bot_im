# 同频TeamPlay v0.5.4验收

2026-11-24。用户明确QA日志业务为每轮软件迭代必过MVP；先冻结QA-MVP-v0.5.4、写AGENTS，再实现、测试、真实验收和打包。通用Agent连接/单测/历史成功/paused或partial均不能替代本轮主流程。

## 失败诊断与修复

旧失败没有保存底层cause，留下完整ZIP但未生成第二个附件，不能据此断言失败就在PNG或认定授权过期。实际重新授权读取成功，ZIP/PNG当前GET均200且大小/MD5正确。源码与隔离HTTP服务复现显示：即使文件字节和哈希完整，旧逻辑仍依赖服务端结束HTTP流，可能挂到传输超时。

仅在可信元数据有精确size和合法MD5、全部字节完整写入且MD5相等时，结束下载并取消剩余响应流；同块超量/错MD5拒绝，缺任一条件仍按EOF。每attempt私有downloads.json/failure.json保留附件阶段、字节、HTTP状态及脱敏cause；超时类型不再丢失。聊天用固定普通说明和继续动作，不输出URL、凭据、宿主栈或泛化“请管理员检查”。这是已复现并修复的缺陷，历史那次具体网络cause因原记录缺失仍不可确证。

## 本轮真实主流程

在授权聊天明确重新分析同一缺陷，Trigger/Router关联原任务的新输入版本4/attempt6。两真实附件共17,551,596字节，均以metadata-size-md5完成；95个解出文件。沿固定Skill1.3.2/原DSH插件完整配方解析，PNG按原插件保留但不做OCR。原安装插件三档模板/五核心文件已核对；本轮system/user逐字与原配方匹配，未自动注入整段QA描述或自加故障因果要求。

实际Qwen4 Max/High请求1次、工具0（原插件直接prepareCall流程），native completed/exit0/launcherExited证据齐全。约123秒，解析1次、104次确定性证据回读/759行；原生用量输入85891、输出10875、合计96766 tokens。原结论一条加完整报告.txt回到原聊天；成员登录取ticket下载16685字节，与原完整报告及既定用量逐字、大小、SHA相符：813b5d40801ed187e08be1d7d88f63d01b55dd6edad4bba1d57fa6343ca8a528。旧失败与其他取消/unknown任务未自动重跑，不改历史为成功。

当前关键运行源摘要84675b019eda111f5e1a22c55045547b052eb57a6f74b61d467959c0d4df82c1；完整私有收据environment/verification/v054/qa-live/qa-live-receipt.json，摘要见QA-MVP-ACCEPTANCE-v0.5.4.json。业务正文、凭据、日志和native IDs只在忽略目录。

## 逐轮交付门禁

verify-qa-live.mjs必须显式--live --send，持久clientId去重；--live --check不重做模型。独立核当前版本/关键源指纹、真实CIM listener身份及加载时间、授权QA读取、当前Trigger/Router/revision、附件实际hash、原配方提示、原生完成/型号High、唯一结论TXT和认证下载。deliver-windows.ps1必需-QaReceipt，并重读原生证据和文件hash；旧版本、源改动、缺阶段或伪完成均拒绝。verify.ps1仍只做离线回归，不偷偷调用模型。

验收工具首次真实接线还发现并修正：native目录应为classifier-*；进程存在不代表身份匹配，改复用启动CIM；现代账本须取superAgent.statePath而非legacy顶层statePath；QA先按准确no读取再核project/id，避免本后端id搜索语义不同造成null被误称授权失败。这些均在触发消息前或检查期修复，未因此重复真实模型。6项gate合同/发现/身份反例及语法检查通过，首次与修正日志完整保留。

## Windows和最终检查

相关worker/super-triage70/70；完整回归及最终计数另见TESTING/最终回执（本轮原日志都保留）。Windows0.5.4已通过真实QA gate后构建：ASAR16项/12源字节一致，PE x64/产品0.5.4，ZIP74文件CRC/manifest/每文件hash正确，隔离真实Electron8项含托盘/隐藏/未读/单实例/报告点击保存通过，0renderer错误；两尺寸四图一批查看正常。

ZIP162325626字节，SHA256 a8d51324abab401713a485823a4432e5e1e3484323d0cf851dc18035f9be8146；SHA文本99字节，自身digest 0ede0f3121fafb3c7794458a1e5f90c94edc8d35f0c3bc251c54cdc9598daa4b。EXE在outputs/desktop-v0.5.4/TeamRelay-win32-x64，保留整个目录；包不含后台、Agent、凭据或业务资料。源/新tag及Release资产实际远端回执见最新HANDOFF/state，不从提交前记录预称上传。

最终冻结源完整verify单次26 Python/9桌面/503桥接/16模拟启动及语法全通过，0跳过；更早500和501通过记录以及最终gate6/6相关复验均保留，不将中途未覆盖的新版测试冒称已通过。打包前后本轮QA receipt重验均passed，源指纹未漂移。
