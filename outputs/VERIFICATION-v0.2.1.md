# v0.2.1 启动与监听验收

日期：2026-11-09。Windows本机；项目Python3.12.15、Node24.19.0、PowerShell7。本轮服务/桥接v0.2.1，兼容现有Windows客户端v0.1.2，未修改UI或重建桌面包。

## 自动检查

- `environment/scripts/verify.ps1`最终完整执行成功：26项Python、79项桥接/凭据/managed进程测试、16项Windows启动编排模拟测试，客户端/桌面JS语法通过。
- 实际绑定发现并修正PowerShell `return Invoke-RestMethod`把JSON数组作为单个管道对象返回的问题；改为先赋值再返回数组。补充动态HTTP服务的真实Invoke-RestMethod绑定回归后，`node --test workspace/bridge/test/*.test.mjs`最终80/80通过。生产代码仅此绑定读取修正在完整检查后改变；实际本机绑定也通过。
- 真实当前用户DPAPI保存/新PowerShell解密、无明文落地、配置越界/链接/ADS/格式拒绝、旧临时模式、环境优先与恢复均覆盖。没有切换其他Windows账号实测；跨用户不可解密为DPAPI机制约束。
- managed测试使用实际Node进程、临时HTTP和fake CLI，验证身份/群/成员/CLI失败不ready、跳过旧消息、旧锁保留、异常任务不自动重做、停止时完成当前分类/worker并回传、同批下一事件不执行、实例nonce隔离与锁释放。不是模型验收。
- 16项编排测试隔离模拟CIM/端口/HTTP/进程启动，覆盖重复start、ServerOnly、旧Node拒绝、PID创建时间和命令边界、未ready/failed、正常停止顺序、忙时超时保留服务、控制器互斥等；没有操作真实18200。

首轮完整检查曾有1项managed启动等待15秒超时（77/78），旧夹具未记录子进程提前退出且清理了临时目录，根因未确证。保留原失败日志，增强失败现场/退出诊断并新增确定性提前退出回归后，定向并行与最终完整检查通过。没有增加超时或将它称为已修复的产品缺陷；不能省略这次未复现失败。

## 本机实际联动

- 使用当前项目显式创建的人工测试数据，为已有助手绑定1个“产品协作组”和admin/alice/bob三个合成测试成员。普通讨论自动识别任务，不扩大到新群或未来成员。
- 工作副本为本项目忽略目录`environment/tools/dsh/worktrees/agent-bot-im`，独立分支`codex/dsh-agent-bot-im`，跟踪origin/main；保留原验收副本。实际监听启动前已同步本轮产品代码，没有清空已有修改。
- 连接码在本机通过管理员API生成，经真实HTTP校验后由当前Windows用户DPAPI保存；配置/密文/数据库/原始日志均被Git忽略。准备时的管理员会话已退出，父进程不保留IM连接码。
- 既有服务可安全复用。实际默认start启动服务与监听，健康接口返回ok/v0.2.1；managed为listening、auto、1群/3成员，首次auto游标准备完成。
- 再次start复用两个原PID，没有重复监听。两次联动停止/重启均无需输入连接码：先请求监听结束、确认stopped和状态锁释放，再停IM，重新启动后恢复同一绑定及游标。最后保留两进程运行供用户人工测试。
- 已安装DSH CLI三次启动版本探测均为0.2.2-rc.1；探测不调用模型。记录时本实例只有version运行，没有classifier或worker调用。未重复付费分类/编码验收，真实改代码证据仍见v0.2.0报告。

本机证据在忽略的`environment/verification/startup-v0.2.1/`：regression-first-failed.log、regression-final.log、bridge-final-after-http-fix.log、orchestration.json、live-summary.json、live-final.json及进程记录。实际配置在environment/config，运行日志在environment/logs/dsh-startup和对应DSH runs目录，不上传。

## 限制和交付

监听当前只绑定上述本机测试群；腾讯/真实团队/其他电脑未配置。Windows用户或电脑迁移需重新绑定；Git不会恢复私有配置、进程、DSH认证或代码副本。没有系统开机自启、崩溃无限重试、执行中实时接管或自动合并上线。

用户本轮完整人工体验结果仍待反馈。版本按v0.2.1新annotated tag交付；静态报告是提交前快照，最终上传以远端main/tag/Release查询为准。
