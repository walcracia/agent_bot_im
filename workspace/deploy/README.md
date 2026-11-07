# 腾讯轻量应用服务器部署

目标：Linux x86_64，Docker Engine + Compose 插件，域名 A/AAAA 指向服务器。建议从 2 核/2 GB 内存起，磁盘按团队附件保留量选择；这是初始容量建议，未做压力测试。应用为单进程，不能自行扩容 workers。

1. 将 workspace 源码上传服务器项目目录（不上传本机 environment/config/data）。
2. `cd deploy`，将 `.env.example` 复制为 `.env` 并填写域名。
3. 腾讯控制台防火墙开放 TCP 80、443（可选 UDP 443）；Linux 主机防火墙同样开放。无需开放 18200/数据库端口。
4. `docker compose up -d --build`。Caddy 自动申请 TLS，HTTP 自动跳转 HTTPS。
5. 在当前 shell 安全读取管理员密码，设置 `IM_ADMIN_PASSWORD` 环境变量（不写入 .env），然后 `docker compose exec -e IM_ADMIN_PASSWORD im python -m server.cli init-admin --username admin`。完成后清除当前 shell 的变量。CLI 不提供默认密码，也不覆盖已有同名账号。
6. 客户端填 `https://你的域名` 登录；由管理员在成员界面添加用户和机器人。
7. 另一台 DSH 机器部署 bridge；其主动访问 HTTPS IM，无需公网暴露 DSH。

更新：先备份，再拉取明确 tag 的源码，`docker compose up -d --build`；保留 `im-data` 卷。不要使用 `docker compose down -v`，它会删除数据。

备份必须一致保存 SQLite 与附件。首版在维护窗口停止 im 服务，再导出 im-data 卷即可；恢复到新空卷后启动核对。也可用项目 backup 脚本执行数据库在线备份，但数据库快照后的新附件不在该时点保证内。

本项目没有腾讯账号、SSH 或域名凭据，远端生产部署尚未执行。Docker 本机验证不等于腾讯网络/TLS 验收。
