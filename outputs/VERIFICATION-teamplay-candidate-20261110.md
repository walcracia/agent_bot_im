> 本地蓝色更名候选记录，未发布；远端v0.3.1为另一份石墨版本。合入最新主题后的正式更名改为v0.3.2。

# 同频TeamPlay v0.3.1 验收与核对

设计冻结：2026-11-10；本机验证：11月10日；最终补充与交付准备：2026-11-17。基线fd1238c（main）。本文件为提交前快照，远端状态以Git及Release查询和HANDOFF最新回执为准。

## 范围与结论

- 显示名称统一为“同频TeamPlay”，版本元数据0.3.1；登录/窗口/PE产品属性/当前文档/服务管理帮助/桥接品牌prompt已更新。主题、交互、协议、存储键、app.setName('同频')用户目录、TeamRelay.exe/目录、npm名称保留兼容。
- 根README直接包含Super-agent逐项核对、架构图、团队/IM/DSH/代码项目职责、完整业务流程、运行中补充/停止/恢复、主动核查、PR/合并/发布及证据等级。文章/源码两条只读审查相互独立，未复制整篇文章。
- 符合主要机制；上下文预算/摘要、Router老任务召回、通用订阅、补充顺序/媒体、真正异机长期验收有边界。本轮只记录，不宣称修复。独立复核修正了状态命令示例、两小时按invocation计时及交付串行的策略条件。
- 用户11月17日询问云端API key保护，新增CLOUD-SECURITY.md记录推荐的独立调用代理/最小权限/执行与出口隔离；当前环境与认证不能保证密钥对Worker不可读，方案未实施。

## 已执行验证

| 验证 | 实际结果 |
| --- | --- |
| `environment/scripts/verify.ps1`，进程PATH前置隔离Node24.19.0 | 26 Python、256 Node、16模拟Windows启动编排及客户端/桌面JS语法全部通过。Python3.12.16，Starlette/httpx旧弃用警告1条保留。 |
| 最后品牌prompt/CLI说明改动后的补验（11月17日） | `python -m pytest workspace/tests -q` 26通过；`python -m compileall -q workspace/server`通过；`node --test workspace/bridge/test/bridge.test.mjs` 11通过。 |
| `verify-ui-theme.py --output-dir environment/verification/teamplay-v0.3.1-ui` | 真实Chrome、临时HTTP服务/SQLite/合成账号；登录与聊天1280×860、960×680均不溢出，新名完整；7张截图、15组对比度通过，0页面异常。主代理批量看4张关键截图，无需修正；其余为成员/设置。报告中的version0.1.3是复用主题验收脚本标识，不是本次包版本。 |
| `environment/scripts/build-portable.ps1` | Electron45.2.3 / packager20.3.0按锁构建，输出到新的desktop-v0.3.1，旧包不覆盖。 |
| ASAR | 9条目明确白名单；client五文件及desktop/main.cjs共6文件与源码逐字节一致；精简manifest版本0.3.1、品牌正确；无server/bridge/凭据/用户数据。 |
| Windows PE | FileVersion/ProductVersion为0.3.1；ProductName/CompanyName为同频TeamPlay，FileDescription含新名。 |
| ZIP | 74个文件，清单与构建目录完全一致；CRC及逐文件SHA256一致，便携说明新名正确。总162,325,706字节。 |
| 依赖与兼容 | 两份package-lock除根版本外依赖不变；旧用户目录名、TEAMRELAY_PROFILE与存储键保留。不做真实用户资料迁移。 |

本机原始日志/截图/ASAR、PE、ZIP详细报告在忽略目录environment/logs和environment/verification/teamplay-v0.3.1-*，不提交原始运行记录。源码审查和常规模拟/真实进程测试不替代模型编码验收；真实模型证据仍是2026-11-09历史报告。

## 构建失败及恢复

第一次打包直连github.com超时，退出失败，未记作通过。使用Windows现有代理，仅为该构建进程设置HTTP_PROXY/HTTPS_PROXY及NODE_USE_ENV_PROXY=1后成功；未关闭TLS、跳过官方checksums或改系统网络。失败与成功日志分别保留。

11月17日交付时旧回环代理暂不可达，普通GitHub网页直连超时而API直连可达，按当前网络核对后选择可用的Git/API交付路径；是否上传以实际远端回执为准，不由本段推断。

## 包与限制

包：outputs/TeamRelay-portable.zip；校验：outputs/SHA256SUMS-v0.3.1-portable.txt。

SHA256：`c8943950d0c26ae37749ac4b6577a345618be180221ebfc2c86f9e1a28bb4050`。

未执行原生EXE窗口/人工登录、真实模型、正式IM/DSH/Watchdog启动、Docker或腾讯/物理异机部署；没有进行安全渗透或云端密钥隔离验收。18200在本次检查时没有监听。云端安全建议不改变这些事实。
