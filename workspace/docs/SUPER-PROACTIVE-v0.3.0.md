# v0.3.0 主动静默核查

2026-11-09。实现前冻结，补齐文章3.4的低打扰投机执行。由可信本机配置`proactive.enabled`控制，不接受聊天打开权限。

- Router只有`allowProactive === true`才可返回`speculate`。明确交办仍为`new`；未交办的具体缺陷讨论可以静默核查；闲聊、尚未决定的方案、已解决、取消、泛泛猜测忽略。决策字段仍严格校验，speculate必须新任务且有目标与可验证指令。
- `event.addressed`只由程序识别真实私聊/`@助手`；addressed=true不能静默投机，纯询问可ignore，明确工作请求走可见任务。普通群反馈addressed=false且没有明确交办才适用静默核查。
- 每个worker首次从可信仓库HEAD创建任务工作副本时保存完整`baseCommit`，随元数据和账本持久化；恢复不能用聊天指定的SHA替换原值。旧任务缺少原base时，不冒充可验证的投机基线。
- speculative任务提示先复现，只有确认缺陷且能小范围修复时才改代码并验证；否则结束。任务不自动扩大范围、不自动无限重试。
- GitDelivery要求完整有效base SHA，解析原始Git对象并确认base属于任务HEAD历史。实际`base → 当前工作树`差异包括worker自行提交的变化；另检查不被ignore的未跟踪文件。凭模型一句“修好了”不能交付。没有真实变化时返回`{skipped:true,reason:'no_verified_change',head,branch}`，不commit/push/PR。有变化仍必须通过可信测试和私有文件检查，然后按既有GitHub流程交付。
- 私有数据、运行目录或无效路径的变化阻断交付，不把它们当作有价值成果；不读取其内容作差异摘要。忽略文件不作为交付变化。现有命令环境隔离、诊断私有存储、单次Git代理和停止前置检查保持。
- 协调器负责静默准入、无价值/失败静默结束、真实验证后统一通知，以及明确后续用户指令的任务提升；本模块不改变其消息策略。

验收：Router默认禁止、显式开启、严格字段/外来任务阻断；真实临时Git验证空改动不push/PR、已提交变化仍被识别、只有忽略文件不交付、未跟踪源码须先可信测试、私有路径阻断、原base跨恢复保持及外来SHA拒绝。默认测试零模型；最多一个额外只读分类会话须由根协调单独显式运行，不新增代码worker模型会话。

## 验证结果

- `node --test workspace/bridge/test/super-proactive.test.mjs workspace/bridge/test/super-github.test.mjs workspace/bridge/test/super-worker.test.mjs`：34项通过；包含同仓库存在但不属于当前任务祖先的真实orphan commit拒绝。语法与diff空白检查通过。
- 根协调显式授权一次只读真实分类，使用`environment/scripts/verify-super-proactive.mjs --live`，两分钟上限、一次调用、零worker、零重试。实际普通群缺陷讨论返回speculate，实际addressed=true的明确修复请求返回new；原生run记录permissionMode=read-only，完成。原始证据仅在忽略目录`environment/verification/super-proactive-live/`。该脚本不带`--live`为零模型入口，不重复运行此前Watchdog验收。
- 协调器低打扰消息策略、可信配置启用与远端spec/base元数据桥接由根协调集成后进行整体验证；本模块测试不代替最终协调器回归。
