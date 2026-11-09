# Windows 0.3.0 便携包

本机入口：`outputs/desktop-v0.3.0/TeamRelay-win32-x64/TeamRelay.exe`。保留整个目录，不能只复制EXE。

- PE和打包manifest为0.3.0；asar9条目白名单，桌面入口和5个客户端文件与源码字节一致。
- ZIP：TeamRelay-v0.3.0-win32-x64.zip，162325663字节，74文件；CRC、完整清单和全部文件SHA256通过。
- SHA256：`838a6bed6f41db2e0eb1756d22f77297f2c1a74eb7ca6eca1033efc214138f90`。
- 蓝色UI源码保持既有设计；新构建不覆盖当前用户可能打开的旧0.2.3目录。未重新操作新EXE原生窗口，不冒称本轮人工登录验收完成。

自动发布构建另使用已合并commit和 `build-portable.ps1` 生成固定名TeamRelay-portable.zip；其时间戳/hash与本地候选ZIP可不同，远端以实际发布账本和asset digest为准。

最终已合并commit构建/发布：b8cc74166072b0f4c559426d758dd21838838860。正式资产TeamRelay-portable.zip已验证远端digest；本机副本outputs/TeamRelay-v0.3.0-portable.zip。74文件、162325663字节，SHA256 58f7e07e06ad47065e645ea89a959dd8a3b742ed9df3ea6f81894282e7614012；CRC/完整清单/每文件hash和ASAR/源码字节核验通过。候选ZIP保留，不与正式资产hash混淆。
