# v0.1.3 蓝色主题验收报告

本报告记录DSH主题源码阶段，当时尚未重建Windows包；后续v0.2.3已完成新包交付，见VERIFICATION-desktop-v0.2.3.md。后续独立审查还修正了绿色扫描的camelCase CSS属性读取并重新通过；15组对比度不受该缺口影响。下文“未调用模型”指验收脚本未额外调用模型，主题修改本身由已绑定的真实DSH会话完成。

日期：2026-11-09（Asia/Shanghai）。范围：`workspace/client/` 的颜色与设计令牌、品牌图标配色，以及对应文档和验证脚本。布局、文案、DOM、交互与功能未改。

## 修改

- `client/tokens.css`：移除 `--green*` 旧主色令牌，新增 `--primary:#2563eb`、`--primary-deep:#102a4c`、`--primary-hover:#1d4ed8`、`--primary-pressed:#1e40af`、`--accent:#0b6fd8`；页面、会话、搜索、选中、自身气泡、文件/媒体表面改为蓝调中性色。错误红 `#ad4942` 与警告琥珀 `#795719` 保留语义。
- `client/styles.css`：只替换颜色引用与强调色落点；未读、选中标记、进度和复选框使用 `--accent`，主按钮/链接/焦点使用主蓝色系。逐行 diff 无布局属性变化。
- `client/logo.svg`：保留原图形，蓝色底、白气泡、深蓝描边。
- `workspace/docs/UI-v0.1.3.md`：改动前冻结的范围、令牌和验收标准；DESIGN/HANDOFF/PROCESS/TESTING/RESTORE 同步记录。
- `environment/scripts/verify-ui-theme.py`：新增临时隔离服务 + 真实 Chrome 的蓝色主题/对比度检查。

## 实际测试

| 检查 | 命令 | 实际结果 |
| --- | --- | --- |
| 既有完整浏览器流程 | `environment/venv/Scripts/python.exe environment/scripts/verify-ui-v0.1.2.py --output-dir environment/verification/ui-blue-theme/regression` | 通过，13项检查、8张截图、0页面异常；登录/错误恢复、群聊/私聊、分组与时间键盘、IME、四类媒体/拖放/hash/Range、重试、重连、XSS、管理员助手、退出均通过 |
| 蓝色主题与对比度 | `environment/venv/Scripts/python.exe environment/scripts/verify-ui-theme.py` | 通过，7张截图；旧绿色十六进制/令牌名0处，页面可见绿色族颜色0处，15组对比度全部通过 |
| Python 服务/备份 | `python -m pytest tests -q`（工作目录 `workspace`） | 26 passed，1条 Starlette/httpx 弃用警告 |
| 客户端/桌面语法 | `node --check client/app.js`、`desktop/main.cjs`、`desktop/build.cjs` | 三个文件均通过 |

主题检查在真实 Chrome 中读取 computed style：登录按钮 `#2563eb`、导航 `#102a4c`、未读强调 `#0b6fd8`、会话背景 `#f3f7fd`、自身气泡 `#dbe8ff`，色相均在210–222°；1280×860和960×680均无横向溢出，发送按钮和输入框在视口内。

## 对比度（计算值）

| 前景/背景 | 比值 | 最低要求 | 结果 |
| --- | --- | --- | --- |
| 登录按钮白字/主蓝 | 5.17:1 | 4.5 | 通过 |
| 输入占位文字/白底 | 5.94:1 | 4.5 | 通过 |
| 输入框边界/白底 | 3.91:1 | 3.0 | 通过 |
| 未读白字/强调蓝 | 4.91:1 | 4.5 | 通过 |
| 导航文字/深蓝 | 13.39:1 | 4.5 | 通过 |
| 自身消息文字/自身气泡 | 11.70:1 | 4.5 | 通过 |
| 会话时间/选中会话底 | 4.86:1 | 4.5 | 通过 |
| 正文/页面底 | 14.09:1 | 4.5 | 通过 |
| 次要文字/表面 | 5.68:1 | 4.5 | 通过 |
| 焦点环/页面底 | 6.53:1 | 3.0 | 通过 |
| 选中文字/选中底 | 8.42:1 | 4.5 | 通过 |
| 错误文字/错误底 | 5.00:1 | 4.5 | 通过 |
| 警告文字/表面 | 6.30:1 | 4.5 | 通过 |
| 导航激活文字/激活底 | 8.38:1 | 4.5 | 通过 |
| 输入边界令牌/表面 | 3.75:1 | 3.0 | 通过 |

## 截图

忽略目录 `environment/verification/ui-blue-theme/`：

- 主题检查：`login-1280.png`、`login-960.png`、`conversations-1280.png`、`chat-1280.png`、`chat-960.png`、`members-1280.png`、`settings-1280.png`、`theme-report.json`。
- 全流程回归：`regression/` 下 8 张，含 `login-375.png`、`attachment-menu-1280.png`。

人工查看1280×860与960×680登录、聊天、成员/设置后未发现需要再改的配色或可读性问题；本轮只做一轮集中检查，没有继续美化。

## 未完成 / 限制

- `outputs/TeamRelay-win32-x64` 的 Windows 包仍是 v0.1.2 旧绿色版本，本轮未重建；需要重建并重新验收原生窗口后，才能说安装包已带蓝色主题。
- `outputs/design-preview-v0.1.2` 保留为历史绿色快照，未改成蓝色。
- 未部署腾讯生产、未连接真实团队服务、未调用真实 DSH 模型；这些不属于本次 UI 主题改动。

结论：源码中的登录页与主界面已统一为蓝色主题，旧绿色主色在客户端源码和可见 computed style 中均无残留，现有功能回归和对比度检查通过；Windows 安装包与历史预览仍是旧配色，已明确列为未完成。
