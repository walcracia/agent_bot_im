# 同频TeamPlay v0.3.2：最终集成验收

日期：2026-11-17。基于远端main `6e6186a2e4322d12aec99914792c58be72de48d8`，在保留本地草稿6e2802a后合入；本文件为提交前快照，最终源码/tag/Release按远端查询及最新HANDOFF回执确认。

## 实际范围

- 精确显示名同频TeamPlay；服务、桌面及桥接版本元数据0.3.2；依赖、内部TeamRelay标识、旧用户目录、协议和操作兼容。
- 保留远端已选石墨主题/规则设置齿轮及所有旧Release/报告；本地蓝色0.3.1候选从未发布，其报告另存teamplay-candidate-20261110。最终构建与截图均来自合入后的石墨源码。
- 根README直接记录设计/角色/业务流程及文章核对；保留正式审计两项P1和其余已知缺口。本轮只更名/整理，不修复交付、可信测试来源、取消IO、上下文或发布恢复。
- 根据用户问题新增CLOUD-SECURITY.md：推荐真实key独立代理、凭据最小化、执行与出口隔离、配额/轮换。当前仍有广权限与环境继承，未实施云端密钥隔离，也未进行其安全验收。

## 验证

| 项目 | 结果 |
| --- | --- |
| 完整常规验证 | `environment/scripts/verify.ps1`，项目Node24.19.0/Python3.12.16；26 Python、256 Node、16模拟Windows编排及JS语法全部通过。Starlette/httpx旧弃用警告1条保留。 |
| 石墨真实Chrome | `verify-ui-graphite.py --output-dir environment/verification/teamplay-v0.3.2-ui`：10截图、27检查、29对比度通过，0页面错误。1280×860、960×680登录/聊天均可用，新名完整。批量查看4张关键图，无需修正。报告脚本固定product_version0.3.1是旧脚本标识；包版本另由PE/manifest确认为0.3.2。 |
| 构建 | `environment/scripts/build-portable.ps1`，Electron45.2.3/packager20.3.0锁定依赖；版本目录desktop-v0.3.2，未覆盖旧目录。仅进程代理变量，无全局网络改动。 |
| ASAR/源码 | 9条目白名单，5个client文件及desktop/main.cjs共6文件逐字节匹配；精简manifest0.3.2，名称及兼容app.setName正确；不含server/bridge/数据/凭据。 |
| PE | FileVersion/ProductVersion0.3.2，ProductName/CompanyName同频TeamPlay；加载背景仍为石墨#171a1d。 |
| 完整ZIP | 74文件、162,326,276字节；目录/ZIP清单、CRC与逐文件SHA256全部一致，说明显示新名。 |
| 依赖/主题保留 | 两份锁文件仅根version更新到0.3.2，依赖条目与origin/main一致；client/app.js/styles.css/logo.svg与远端一致，tokens仅品牌注释差异，桌面保留石墨背景/行为。 |

ZIP：`outputs/TeamRelay-portable.zip`；SHA256：`13c4d6fb2c936d5f8d42d59886cdd24567f8cfcb329776eb30e133c0262bd4ff`。校验文本：SHA256SUMS-v0.3.2-portable.txt。

## 证据与未执行项

本机日志在忽略目录environment/logs/verify-v0.3.2.log、build-teamplay-v0.3.2.log；截图/ASAR/PE/ZIP报告在environment/verification/teamplay-v0.3.2-*。历史蓝色候选曾打包直连超时、进程代理重试成功，单独保留；最终石墨构建一次成功。

交付时发现原本地Git的URL专用代理仍指旧端口，普通http.proxy参数未覆盖它。核对当前Windows已配置代理后只更新本仓库原URL专用条目，fetch成功；未改全局/系统代理或Git身份。远端已有v0.3.1，所以使用新v0.3.2，不移动已发布tag/资产。

未运行真实模型、正式IM/DSH/Watchdog、原生EXE窗口或人工登录、Docker/腾讯/真正异机部署，也未修复或重验正式审计缺陷。常规测试通过不推翻已复现P1，不是普通讨论到完整可信发布的真实业务整链证据。云端安全设计为建议，不能作为现成部署保证。
