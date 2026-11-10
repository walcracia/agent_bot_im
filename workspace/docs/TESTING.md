# 验收计划

## 2026-11-10 · v0.3.1复审证据（已知缺口，非通过门槛）

报告`outputs/AUDIT-SUPERAGENT-v0.3.1-2026-11-10.md`覆盖原文比对、启动链/包体与历史证据边界。35项现有协调/集成/主动性测试通过；三份`environment/scripts/audit-super-v0.3.1/*.mjs`为固定dad375d基线复现器，根复跑5+3+2项均确认报告问题/能力边界（发布恢复重复交叉核验）。运行命令见报告，只写忽略verification，GitHub完全模拟、DSH零调用。脚本成功代表问题仍存在，不能纳入绿色产品验收冒称功能通过；修复后应转成相反预期的正式回归。全量26/256/16及真实模型/PR发布保留历史范围，本轮不重复算通过；普通IM到真实业务修改再完整发布/恢复尚缺连续实证。

## v0.3.0 新增验收

- 最终补充：真实临时Git覆盖fresh base不移动主检出、空任务不交付、同步base复测、版本顺序、精确head自动合并与关闭PR明确恢复；协调器覆盖已合并后续任务/继续提示/关闭PR保留身份。`verify-super-proactive.mjs --live`是单独显式的一次只读分类验收，默认零模型。实际PR→合并→Windows构建→资产digest核验结果见最终交付报告。

- `environment/scripts/verify-super-agent.ps1`：零模型新模块与Windows配置转换；`verify.ps1`仍为全量回归。
- `environment/scripts/verify-task.ps1 -Python <可信解释器绝对路径>`：独立任务副本不依赖自己的venv/node_modules，不修改源码/索引，运行真实Python与全部桥接测试。
- `verify-super-live.mjs --live`：显式且有预算的本机真实并行编码；remote-tools实证必须显式使用其专用flag。原生输入以inbox spliced target=next-step、user/message序号与持久回执匹配，不仅看模型回答。
- `verify-super-model.mjs --live`：最多两个真实只读会话；停滞监督使用明确标注的合成事实，不能称为真实生产故障。
- 真实入口测试独立启动Node/Watchdog、HTTP IM与PowerShell假CLI；GitHub/Release测试使用临时真实Git/构建与模拟gh，实际远端发布另行记录。
- 每项验证按本轮报告给出实际结果；失败保留。腾讯部署未执行，本轮不因接口存在而宣称所有平台/模型/任意复杂任务均已验收。

设计先于实现冻结。每项实际结果写测试报告；下列为计划，不代表已通过。

1. 身份：正确/错误密码、退出失效、非管理员不能建用户，未知令牌不能访问。
2. 通讯：两用户/群组、私聊复用、消息排序、client_id 重发幂等、历史分页、read 游标、WebSocket 身份和隔离。
3. 附件：普通文件、PNG/JPEG、WAV/MP3、MP4/WebM，按真实内容分类；哈希和下载字节一致，Range 206，越权拒绝；100,000,000 字节拒绝，99,999,999 字节接受（真实边界验证）；异常不留临时文件。
4. DSH：只有加入会话才可读取；不监听 bot 回话；cursor 恢复；真实 Harness/channel 握手、消息转入、实际结果回传，mock 只可作为协议单测且标注。
5. 客户端：登录、创建私聊/群组、文字/媒体、上传进度、断线重连、中文输入、退出；至少一轮真实桌面打开/截图检查，自动端到端检查浏览器 UI→API→持久化→第二用户。
6. 部署：Docker 镜像可构建，容器启动/健康；Windows 便携 EXE 可构建和启动；备份/恢复隔离验证。
7. Git：各迭代提交和 tag；远端 commit 对齐。生产腾讯部署和异机 DSH 需用户具体服务器信息，未执行则如实记录。

## v0.2.1 启动验收计划

规格见STARTUP-v0.2.1.md。新增隔离Windows进程验收：managed启动前CLI零模型检查/身份/白名单/游标/异常任务；完成当前分类或worker后停止、同批次下一事件不执行、锁释放、错误nonce不影响当前实例；DPAPI真实保存/另一PowerShell进程解密、无明文落地、路径/格式拒绝、原前台方式兼容；start/stop模拟身份错配与超时、重复启动、ServerOnly和控制器互斥。测试使用临时目录、动态端口、假CLI，不读取本机团队凭据或调用模型。

本机另外检查已安装CLI版本、当前隔离测试群真实ready、重复start及stop/start无需重输码；代码worker的真实模型改文件证据沿用v0.2.0，不能将本轮fakeCLI当作新增模型验收。实际结果写outputs/VERIFICATION-v0.2.1.md。

## v0.2.2 恢复验收计划

规格见DSH-RECOVERY-v0.2.2.md。worker两小时预算以参数和假CLI短超时验证，分类独立两分钟；不真实等待两小时。覆盖超时已证实清理/无法确认保留租约、终态侧车、同群授权精确继续/取消、原会话和已有改动保留、重启暂停零调用、旧继续命令去重、连续失败需新指令、原会话缺失不可换新、通知ACK丢失、同批最后有效控制与权限再验。

实际Node+HTTP+fakeCLI进行在线暂停和恢复集成；Windows状态文件rename注入EPERM/EIO，验证有限退避、owner重验、失败队列恢复及非任务账本状态发布不打断worker。所有假CLI结果和本机真实原任务续接分开记录；正式命令和结果见outputs/VERIFICATION-v0.2.2.md。

## v0.1.3 蓝色主题验收计划

规格见UI-v0.1.3.md。用真实 Chrome 在临时隔离服务上检查登录页和聊天主界面在1280×860、960×680的整体配色与不溢出；从源码移除旧绿色十六进制/令牌名，从 computed style 确认无绿色族可见颜色；主蓝、深蓝导航、亮蓝强调、蓝调表面都来自 `tokens.css`。对比度用计算值检查：正文/次要文字/未读白字≥4.5:1，控件边界/焦点环≥3:1；同时重跑既有v0.1.2真实浏览器流程，证明布局、文案和功能未回退。

验收脚本为 `environment/scripts/verify-ui-v0.1.2.py`（全流程回归）与 `environment/scripts/verify-ui-theme.py`（蓝色角色/旧色/对比度）。Windows包重建和原生窗口不在本轮自动范围；未重建时必须明确记录安装包仍是旧配色。实际结果见outputs/VERIFICATION-ui-v0.1.3.md。

## 2026-11-10 · 四套风格审核待用户选择

本轮在D:/Work/CodexProjects/agent-bot-im从fd1238c接续。用户明确调用Hallmark要求几套配色/设计风格供审核，输出outputs/design-review-2026-11-10/index.html：A霁蓝、B暖砂、C石墨、D暮紫；聊天/登录可切换，四图对照或单套可操作。仅合成演示数据，真实client/desktop零改动，未切换正式主题、未重建EXE、未接触正式IM/DSH/私有数据。

确认轮16截图/288检查、审核页7项功能检查通过；Hallmark渲染0 FAIL/0 REFLEX/0 WARN，两项已记录waiver。独立复核2项意见均解决。报告outputs/VERIFICATION-design-review-2026-11-10.md；构建build-design-review.mjs，重开静态审核服务preview-designs.ps1，默认http://127.0.0.1:18310/。服务运行是本次观察，重启后须实查。下一步等用户在Codex对话选A/B/C/D，再做正式落地/完整回归/App打包。

## 2026-11-10 · C石墨与规则齿轮开始

用户已选C并要求重做设置图标，先冻结UI-v0.1.4，再分工改语义令牌/样式/标志和共享settings路径。UI真实隔离10截图/27检查/29对比度、原13项浏览器回归及Hallmark渲染通过；全量Node首轮255/256卡在恢复后Windows登记等待，原失败保留，由独立模块复验与冷副本门禁确认。无模型调用和真实任务重启。最终交付见outputs/VERIFICATION-v0.3.1.md。

## 2026-11-10 · v0.3.1 实际交付

用户已选C石墨，规则六齿设置图标与生产主题落地。独立冷副本26 Python/256 Node及语法通过，16启动编排、原UI13项回归、石墨10截图/27检查/29对比度通过。最低文字6.140、边界4.220、rail焦点9.756。独立齿轮复核ship，Hallmark渲染0 FAIL/REFLEX/WARN。原255/256等待失败保留，targeted3/3和冷副本通过，未改测试或归因成已知原因。

PR #2通过可信测试自动合并为95a76e0a99690d8cc4d6e1d72d76b8e24cbd0907；在该merge的独立checkout构建并发布https://github.com/walcracia/agent_bot_im/releases/tag/v0.3.1，新annotated v0.3.1与两资产远端digest已核验。ZIP 74文件/162326214字节，SHA256 5f350874756a1bcdf0011b4d9034c27fd48e5efc069784c4abeee624f6438aa8，CRC/每文件hash、ASAR9条目/6源文件字节、PE/manifest 0.3.1均通过。发布初次创建draft后即时API尚未确认，随后只读确认既有owned draft，原账本继续上传；没有重建或重复创建Release。

此前18200未在线且账本0活动任务，本轮默认start恢复已有绑定，当前IM v0.3.1、DSH listening/ready及独立Watchdog身份实查通过；没有重启/中断真实worker。只更新本项目失效代理引用到当前系统已有回环端口，不改全局网络。新App可用原账号连接http://127.0.0.1:18200。实际运行须接续时重查，不把Git当成账号/服务/二进制恢复。
