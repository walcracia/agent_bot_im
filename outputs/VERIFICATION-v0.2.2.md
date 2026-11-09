# v0.2.2 · 两小时与聊天内接续验收

2026-11-09，Windows，Python3.12.15、Node24.19.0、PowerShell7。规格见workspace/docs/DSH-RECOVERY-v0.2.2.md。本轮修改运行时与恢复机制，蓝色主题文件保留在独立副本，未混入此功能提交。

## 最终自动验证

`environment/scripts/verify.ps1`最终退出0：26项Python、122项Node、客户端/桌面语法检查、16项Windows启动编排测试通过。测试均使用隔离数据库、动态端口和fake CLI，不调用模型、不等待实际两小时。

- worker默认7200000ms，分类默认独立120000ms，版本探测最多30000ms；fake短超时验证结构化timeout/cancel、终止子树证明与新bridge-supervision.json。未证实停止时保留租约，不能再次执行。
- 核心恢复23项覆盖明确控制、原会话、同群/成员/机器人过滤、接纳前权限再验、控制游标持久去重、同批最新决定、两次失败后旧继续不能重做、ACK丢失、缺失映射/终止未确认时拒绝、准备阶段失败清理和SDK兼容。
- 9项实际Node+HTTP+fakeCLI恢复流程：留下真实partial文件后超时、在线暂停、授权继续原session、取消保留文件并可接新任务、旧uncertain和预发继续迁移、lost ACK只重发、routing_failed明确重识别、非关键状态发布EIO、started账本写入EIO后第二条新继续不锁死。
- managed状态原子替换4项故障注入：EPERM有限重试、EIO不污染后续队列、重试时owner变化禁止覆盖、持续失败有限退出。StateStore和原生会话映射共用有限替换重试；StateStore写入/释放时核验自己的锁。

## 发现与修正

初次恢复进程验证有1次在worker开始前暂停，旧诊断未记底层原因，现场保留。补充安全错误诊断后，后续真实进程测试明确捕获Windows EPERM rename（状态文件）；增加有界退避、每次owner重验、失败队列恢复，非关键显示状态发布失败不再中断已持久任务。

首轮完整回归另有1/116失败，诊断明确为任务账本rename EPERM：已取得prepared lease但尚未调用worker。修正账本/映射原子替换的有限重试，并增加abortPreparation，只清理确定未执行的准备资源和本次新增logical reservation，绝不删除旧native映射；真正run后仍uncertain。确定性EIO回归与最终122/122通过。失败日志、临时现场均保留，没有增加测试超时或把未确证的首个异常冒称已定位。

## 本机真实恢复

- 现有绑定已改worker两小时、分类两分钟，不重新生成连接码或清空任务状态。旧任务的五个主题文件复制到忽略目录备份。
- 独立副本在原有修改保留的条件下fast-forward到本轮运行时代码，五个文件hash前后一致；无stash/reset。旧退出监听记录归档，核验本项目server身份后重启，健康接口返回v0.2.2；启动仍使用当前用户加密的IM助手码。
- 新监听成功处理软件中此前已发送的“继续修正”。实际记录确认：同一原事件、原logical/native会话、原CLI opening ID均匹配；新worker预算7200000ms，未额外调用分类器重新派发这条继续指令。
- 在14:26的观察中，transport为listening、任务为running/started，原任务继续执行中，尚无本次verified result；这证明实际会话接续已开始，不是原主题任务完成或发布证明。任务最终结果由群内回传，之后仍需按真实diff/测试审查，不自动合并或替换现有EXE。

本机私有证据在environment/verification/recovery-v0.2.2：regression-first-failed.log、regression-final.log、preserved-theme、activation-*及live-recovery.json；其他定向失败日志/现场留在原verification/Temp目录。运行状态/连接码/聊天/模型原始日志不上传Git。

## 用户操作与交付

以后超时或中断，助手保持在线并提示。在原群由授权成员发送“继续修正”接续，或“取消任务”结束等待并保留文件。无需重发整段任务；之前重复的继续消息不能自动授权下一次失败后的新尝试。原会话或进程/锁无法验证时仍会提示本机核对，不能换会话掩盖失败。

本轮没有执行中实时取消、自动合并、系统级自启或腾讯部署。版本v0.2.2使用新annotated tag；报告是提交前快照，上传以远端main/tag/Release查询为准。
