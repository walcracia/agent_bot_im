# v0.1 接口合同

JSON 接口 `/api`，时间为 UTC ISO-8601（UI 按用户本地时区）；ID 字符串，message.id 为递增整数。错误 `{detail: string}`，HTTP 401/403/404/409/413/422/429。除 login/health/静态客户端，使用 Authorization: Bearer TOKEN。所有响应禁止缓存。

## 身份

- `GET /api/health` -> `{status:"ok", version:"0.2.1", max_file_bytes:100000000}`。
- `POST /api/login {username,password}` -> `{token,user}`。
- `GET /api/me` -> User。`POST /api/logout` -> `{ok:true}`。
- `GET /api/users` -> User[]。User `{id,username,display_name,is_admin,is_bot}`（不含密码/令牌）。
- `POST /api/admin/users {username,display_name,password,is_bot:false}` -> User；仅管理员。机器人 password 可同样设置；可独立发 token。
- `POST /api/admin/users/{id}/token` -> `{token}`；仅管理员，返回机器人长期连接令牌（期限 90 天）。

## 会话

- `GET /api/conversations` -> Conversation[]。
- `POST /api/conversations {title,member_ids:[...],is_direct:false}` -> Conversation；调用者自动加入，至少两人，私聊相同两人复用。
- Conversation `{id,title,is_direct,members:User[],last_message:Message|null,unread_count:int,updated_at}`。
- `POST /api/conversations/{id}/read {message_id}` -> `{ok:true}`。
- `GET /api/conversations/{id}/messages?before=ID&limit=50` -> Message[]（升序，最近一页，before 可选）。
- `POST /api/conversations/{id}/messages {text,attachment_id?:string,client_id:string}` -> Message；文字与附件至少一种，文字上限 10000。client_id 幂等。
- Message `{id,conversation_id,sender:User,text,attachment:Attachment|null,client_id,created_at}`。

## 附件

- `POST /api/conversations/{id}/attachments` multipart `file` -> Attachment。
- Attachment `{id,name,size,mime,kind:"image"|"audio"|"video"|"file",sha256}`。
- `POST /api/attachments/{id}/ticket` -> `{url,expires_in:300}`；url 为相对服务根的短时授权路径。
- `GET /api/attachments/{id}/content?ticket=...&download=1`：支持 Range，下载保留清理过的文件名；inline 仅已识别的媒体。HTTP 413 表示 >=100000000 字节。

## 实时

- `POST /api/ws-ticket` -> `{ticket}`；30 秒一次性。
- `WS /api/ws?ticket=...`：下行 `{type:"message",message:Message}`、`{type:"conversation",conversation_id}`；上行 `{type:"ping"}` -> `{type:"pong"}`。消息通知按成员过滤。
- 客户端指数退避重连并刷新会话与当前历史，避免断线丢失。通知与 API 可能同一消息多次送达，客户端以 message.id 去重。

## 机器人

- `GET /api/agent/events?after=ID&limit=50` -> `{events:Message[],cursor:int}`；仅机器人，查询其会话内非机器人消息（不含其他 bot，防回路），id 升序。空结果 cursor 保持 after。
- 回复仍使用 `/messages`。适配器自行按 @dsh 或私聊筛选、调用真实 Harness；client_id=`dsh-{event_id}`。接口不是无鉴权管理后门。

静态客户端由服务器 `/` 托管，同时 Electron 用打包的本地 UI 连接指定 HTTP(S) 服务器；CORS 仅允许本地桌面来源/null（无 cookie auth），同源 web。真实 DSH 专用 channel 扩展若需要修改合同，先更新此文档并记录决策。
