# v0.3.0 · 合并后的构建与发布

2026-11-09，编码前设计。`ReleasePipeline(options).run(task)` 只处理已确认合并到固定仓库的任务PR。与代码worker分开，在专用detached Git worktree构建固定merge commit；不会reset、checkout或清理用户/worker的工作目录。

可信配置包括 `repository`、`repositoryPath`、`worktreesPath`、`statePath`、`versionFile`、`buildCommands`、`artifacts` 和 `publishRelease`。versionFile默认workspace/package.json，只接受严格SemVer版本；tag固定为v加版本，不接受聊天提供的tag或命令。固定产物路径须为相对路径，不能穿越、链接到工作副本外或同名。默认publishRelease=false不执行。

发布顺序：核对真实merged PR和merge_commit_sha；准备独立副本；在持久账本先记building再执行可信argv构建；核对产物size/SHA256；创建或核对annotated tag并普通push；幂等创建带稳定标记的草稿Release；逐个上传固定产物并检查远端digest/size；全部确认后公开Release。已存在tag指向别的commit、已有asset内容不同、已有Release缺少本次merge标记时停止，绝不移动tag、不clobber资产、不force push。

账本使用独占锁及原子写。相同任务重复调用复用完成结果，不重复构建。构建中崩溃/失败标记uncertain，保留目录与日志，由操作者核对后明确处理，不自动重做。GitHub/tag写入丢确认先读远端证明；能证明已生效才推进，否则保留pending effect并暂停。后续恢复只读核验该effect，仍无法证明时不盲重试发布。

协调器在merge生命周期后异步调用，发布结果回原IM。PR成功合并与Release成功发布是不同状态；发布失败不能回写成代码未合并。发布自己的状态/源码与实际交付应按仓库过程记录。

验收使用真实临时Git和裸远端、可信小构建及假gh：合并门禁、SemVer、重复调用不重复构建、产物hash、草稿到公开、tag/asset冲突阻止覆盖、丢ACK只读证明、未知构建/上传不自动重做。常规测试没有模型或真实GitHub写入。

本轮 `node --test workspace/bridge/test/super-release.test.mjs workspace/bridge/test/super-github.test.mjs` 通过21项（release7、GitHub14）。构建与Git提交/推送在合成临时仓库真实执行；GitHub仅为协议夹具，未声称线上Release已生成。
