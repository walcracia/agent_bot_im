"""Authenticated IM API and static client. Run exactly one Uvicorn worker."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager
import hashlib
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from python_multipart.multipart import MultipartParser, parse_options_header
from python_multipart.exceptions import MultipartParseError
from starlette.concurrency import run_in_threadpool

from .db import Store, now, password_hash, password_matches, public_user, token_hash

MAX_FILE_BYTES = 100_000_000
MAX_UPLOAD_BODY = MAX_FILE_BYTES + 65_536
VERSION = "0.1.2"
bearer = HTTPBearer(auto_error=False)


class BodyLimitMiddleware:
    """Bound chunked JSON before FastAPI accumulates it; uploads have their own stream parser."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        upload = scope["path"].startswith("/api/conversations/") and scope["path"].endswith("/attachments")
        limit = MAX_UPLOAD_BODY if upload else 65_536
        for name, value in scope.get("headers", []):
            if name.lower() == b"content-length":
                try:
                    length = int(value)
                except ValueError:
                    return await JSONResponse({"detail": "无效 Content-Length"}, status_code=400)(scope, receive, send)
                if length < 0 or length > limit:
                    return await JSONResponse({"detail": "请求体超过允许上限"}, status_code=413)(scope, receive, send)
        count = 0

        async def bounded_receive():
            nonlocal count
            message = await receive()
            if message["type"] == "http.request":
                count += len(message.get("body", b""))
                if count > limit:
                    raise HTTPException(413, "请求体超过允许上限")
            return message
        await self.app(scope, bounded_receive, send)


class Login(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)


class UserCreate(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,40}$")
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=200)
    is_bot: bool = False


class ConversationCreate(BaseModel):
    title: str = Field(default="", max_length=100)
    member_ids: list[str] = Field(min_length=1, max_length=100)
    is_direct: bool = False


class MessageCreate(BaseModel):
    text: str = Field(default="", max_length=10000)
    attachment_id: str | None = None
    client_id: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")


class ReadUpdate(BaseModel):
    message_id: int = Field(ge=0)


def sniff_media(data: bytes, name: str) -> tuple[str, str]:
    """Only recognized inert media containers may be displayed inline."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "image"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "image"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", "image"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "image"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav", "audio"
    if data.startswith(b"ID3") or (len(data) > 3 and data[0] == 255 and (data[1] & 0xE0) == 0xE0 and (data[1] & 0x18) != 0x08):
        return "audio/mpeg", "audio"
    if data.startswith(b"fLaC"):
        return "audio/flac", "audio"
    if data.startswith(b"OggS"):
        return ("video/ogg", "video") if name.lower().endswith(".ogv") else ("audio/ogg", "audio")
    if len(data) >= 12 and data[4:8] == b"ftyp":
        if data[8:12] in (b"M4A ", b"M4B ", b"M4P "):
            return "audio/mp4", "audio"
        return "video/mp4", "video"
    if data.startswith(b"\x1a\x45\xdf\xa3") and b"webm" in data:
        return ("audio/webm", "audio") if name.lower().endswith(".weba") else ("video/webm", "video")
    return "application/octet-stream", "file"


def safe_name(name: str) -> str:
    cleaned = re.sub(r"[\x00-\x1f\x7f]", "", name.replace("\\", "/").split("/")[-1]).strip(" .")
    return cleaned[:180] or "attachment"


class Hub:
    def __init__(self, store: Store):
        self.store = store
        self.clients: dict[WebSocket, tuple[str, str, asyncio.Lock]] = {}

    async def send(self, ws: WebSocket, value: dict):
        client = self.clients.get(ws)
        if client:
            async with client[2]:
                await asyncio.wait_for(ws.send_json(value), timeout=3)

    async def broadcast(self, conversation_id: str, event: dict):
        async def one(ws, uid, hashed):
            if not self.store.session(hashed):
                self.clients.pop(ws, None)
                try:
                    await ws.close(code=1008)
                except Exception:
                    pass
                return
            if self.store.member(conversation_id, uid):
                try:
                    await self.send(ws, event)
                except Exception:
                    self.clients.pop(ws, None)
        await asyncio.gather(*(one(ws, uid, hashed) for ws, (uid, hashed, _) in list(self.clients.items())))


def create_app(data_dir: str | Path | None = None) -> FastAPI:
    store = Store(data_dir)
    hub = Hub(store)
    failures: dict[str, deque] = defaultdict(deque)
    dummy_password = password_hash(secrets.token_urlsafe(24))

    @asynccontextmanager
    async def lifespan(app):
        yield
        for ws in list(hub.clients):
            try:
                await ws.close(code=1001)
            except Exception:
                pass
        store.conn.close()

    app = FastAPI(title="同频 Team Relay", version=VERSION, lifespan=lifespan)
    app.state.store = store
    app.state.hub = hub
    app.add_middleware(BodyLimitMiddleware)
    origins = ["null", "app://team-relay"]
    origins.extend(filter(None, os.environ.get("IM_CORS_ORIGINS", "").split(",")))
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False,
                       allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Authorization", "Content-Type", "Range"],
                       expose_headers=["Content-Disposition", "Content-Range", "Accept-Ranges", "Content-Length"])

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Pydantic's default includes the rejected input, possibly a password. Never echo it.
        fields = [".".join(str(part) for part in error["loc"]) for error in exc.errors()[:8]]
        return JSONResponse({"detail": "请求参数无效：" + "、".join(fields)}, status_code=422)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        # Early bound before multipart body parsing (this endpoint uses Request.stream).
        raw_length = request.headers.get("content-length")
        if raw_length:
            try:
                if int(raw_length) < 0 or int(raw_length) > MAX_UPLOAD_BODY:
                    return JSONResponse({"detail": "请求体超过上传上限"}, status_code=413)
            except ValueError:
                return JSONResponse({"detail": "无效 Content-Length"}, status_code=400)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api/attachments/"):
            response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        return response

    async def identity(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(401, "请先登录")
        hashed = token_hash(credentials.credentials)
        user = store.session(hashed)
        if not user:
            raise HTTPException(401, "登录已过期，请重新登录")
        return {**user, "session_hash": hashed}

    def authorize(cid: str, user: dict):
        if not store.member(cid, user["id"]):
            raise HTTPException(403, "没有此会话的访问权限")

    def require_admin(user: dict):
        if not user["is_admin"]:
            raise HTTPException(403, "需要管理员权限")

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": VERSION, "max_file_bytes": MAX_FILE_BYTES}

    @app.post("/api/login")
    async def login(body: Login, request: Request):
        key = f"{request.client.host if request.client else 'local'}:{body.username.lower()}"
        attempts = failures[key]
        stamp = time.monotonic()
        while attempts and attempts[0] < stamp - 60:
            attempts.popleft()
        if len(attempts) >= 5:
            raise HTTPException(429, "登录尝试过多，请一分钟后重试")
        # Reserve before off-thread hashing so parallel attempts cannot bypass the bound.
        attempts.append(stamp)
        with store.lock:
            row = store.conn.execute("SELECT * FROM users WHERE username=?", (body.username,)).fetchone()
        encoded = row["password_hash"] if row else dummy_password
        valid = await run_in_threadpool(password_matches, body.password, encoded)
        if not row or not valid:
            if len(failures) > 10000:
                # Bound anonymous-rate-limit memory; only expired records are evicted.
                for old in list(failures):
                    if not failures[old] or failures[old][-1] < stamp - 60:
                        failures.pop(old, None)
            raise HTTPException(401, "用户名或密码错误")
        failures.pop(key, None)
        token = store.issue_session(row["id"], 24*3600)
        return {"token": token, "user": public_user(row)}

    @app.get("/api/me")
    def me(user=Depends(identity)):
        return {k: v for k, v in user.items() if k != "session_hash"}

    @app.post("/api/logout")
    async def logout(user=Depends(identity)):
        with store.transaction() as conn:
            conn.execute("DELETE FROM sessions WHERE hash=?", (user["session_hash"],))
        for ws, (_, hashed, _) in list(hub.clients.items()):
            if hashed == user["session_hash"]:
                hub.clients.pop(ws, None)
                try:
                    await ws.close(code=1008)
                except Exception:
                    pass
        return {"ok": True}

    @app.get("/api/users")
    def users(user=Depends(identity)):
        with store.lock:
            return [public_user(row) for row in store.conn.execute("SELECT * FROM users ORDER BY display_name").fetchall()]

    @app.post("/api/admin/users", status_code=201)
    async def create_user(body: UserCreate, user=Depends(identity)):
        require_admin(user)
        try:
            return await run_in_threadpool(store.create_user, body.username, body.display_name.strip() or body.username, body.password, is_bot=body.is_bot)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "用户名已存在") from None

    @app.post("/api/admin/users/{uid}/token")
    def bot_token(uid: str, user=Depends(identity)):
        require_admin(user)
        with store.lock:
            target = store.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            raise HTTPException(404, "用户不存在")
        if not target["is_bot"]:
            raise HTTPException(422, "长期令牌只用于机器人账号")
        return {"token": store.issue_session(uid, 90*86400)}

    @app.get("/api/conversations")
    def conversations(user=Depends(identity)):
        with store.lock:
            rows = store.conn.execute("SELECT c.id FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE m.user_id=? ORDER BY c.updated_at DESC,c.id", (user["id"],)).fetchall()
            return [store.conversation(row["id"], user["id"]) for row in rows]

    @app.post("/api/conversations", status_code=201)
    async def create_conversation(body: ConversationCreate, user=Depends(identity)):
        ids = sorted(set(body.member_ids + [user["id"]]))
        if len(ids) < 2 or (body.is_direct and len(ids) != 2):
            raise HTTPException(422, "私聊需要两人，群聊至少两人")
        with store.transaction() as conn:
            found = conn.execute(f"SELECT id,display_name FROM users WHERE id IN ({','.join('?' for _ in ids)})", ids).fetchall()
            if len(found) != len(ids):
                raise HTTPException(422, "成员不存在")
            direct_key = ":".join(ids) if body.is_direct else None
            old = conn.execute("SELECT id FROM conversations WHERE direct_key=?", (direct_key,)).fetchone() if direct_key else None
            if old:
                return store.conversation(old["id"], user["id"])
            cid, stamp = secrets.token_hex(12), now()
            title = body.title.strip() or "、".join(row["display_name"] for row in found)[:100]
            conn.execute("INSERT INTO conversations VALUES(?,?,?,?,?,?)", (cid, title, int(body.is_direct), direct_key, stamp, stamp))
            conn.executemany("INSERT INTO members(conversation_id,user_id) VALUES(?,?)", [(cid, uid) for uid in ids])
        await hub.broadcast(cid, {"type": "conversation", "conversation_id": cid})
        return store.conversation(cid, user["id"])

    @app.get("/api/conversations/{cid}/messages")
    def messages(cid: str, before: int | None = Query(default=None, ge=1), limit: int = Query(default=50, ge=1, le=100), user=Depends(identity)):
        authorize(cid, user)
        with store.lock:
            if before:
                rows = store.conn.execute("SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT ?", (cid, before, limit)).fetchall()
            else:
                rows = store.conn.execute("SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?", (cid, limit)).fetchall()
            return [store.message(row) for row in reversed(rows)]

    @app.post("/api/conversations/{cid}/messages", status_code=201)
    async def send_message(cid: str, body: MessageCreate, user=Depends(identity)):
        authorize(cid, user)
        if not body.text.strip() and not body.attachment_id:
            raise HTTPException(422, "消息不能为空")
        with store.transaction() as conn:
            previous = conn.execute("SELECT * FROM messages WHERE conversation_id=? AND sender_id=? AND client_id=?", (cid, user["id"], body.client_id)).fetchone()
            if previous:
                if previous["text"] != body.text or previous["attachment_id"] != body.attachment_id:
                    raise HTTPException(409, "client_id 已用于不同消息")
                return store.message(previous)
            if body.attachment_id:
                attachment = conn.execute("SELECT * FROM attachments WHERE id=? AND conversation_id=? AND owner_id=?", (body.attachment_id, cid, user["id"])).fetchone()
                if not attachment:
                    raise HTTPException(403, "附件不属于此用户或会话")
            stamp = now()
            cur = conn.execute("INSERT INTO messages(conversation_id,sender_id,text,attachment_id,client_id,created_at) VALUES(?,?,?,?,?,?)", (cid, user["id"], body.text, body.attachment_id, body.client_id, stamp))
            conn.execute("UPDATE conversations SET updated_at=? WHERE id=?", (stamp, cid))
            result = store.message(conn.execute("SELECT * FROM messages WHERE id=?", (cur.lastrowid,)).fetchone())
        await hub.broadcast(cid, {"type": "message", "message": result})
        return result

    @app.post("/api/conversations/{cid}/read")
    def read(cid: str, body: ReadUpdate, user=Depends(identity)):
        authorize(cid, user)
        with store.transaction() as conn:
            if body.message_id and not conn.execute("SELECT 1 FROM messages WHERE id=? AND conversation_id=?", (body.message_id, cid)).fetchone():
                raise HTTPException(422, "消息不属于此会话")
            conn.execute("UPDATE members SET read_id=MAX(read_id,?) WHERE conversation_id=? AND user_id=?", (body.message_id, cid, user["id"]))
        return {"ok": True}

    @app.post("/api/conversations/{cid}/attachments", status_code=201)
    async def upload(cid: str, request: Request, user=Depends(identity)):
        authorize(cid, user)
        content_type, options = parse_options_header(request.headers.get("content-type", ""))
        boundary = options.get(b"boundary")
        if content_type != b"multipart/form-data" or not boundary or len(boundary) > 200:
            raise HTTPException(400, "需要 multipart/form-data file 字段")
        aid = secrets.token_hex(16)
        temporary = store.attachments / ".uploads" / f"{aid}.part"
        final = store.attachments / f"{aid}.bin"
        state = {"parts": 0, "size": 0, "head": bytearray(), "headers": {}, "field": bytearray(),
                 "value": bytearray(), "header_size": 0, "name": "attachment", "part_done": False, "done": False}
        digest = hashlib.sha256()
        fp = None

        def part_begin():
            state["parts"] += 1
            if state["parts"] != 1:
                raise HTTPException(400, "每次请求只支持一个 file 字段")

        def header_field(data, start, end):
            state["field"].extend(data[start:end])
            state["header_size"] += end-start
            if state["header_size"] > 8192:
                raise HTTPException(400, "附件头过长")

        def header_value(data, start, end):
            state["value"].extend(data[start:end])
            state["header_size"] += end-start
            if state["header_size"] > 8192:
                raise HTTPException(400, "附件头过长")

        def header_end():
            state["headers"][bytes(state["field"]).lower()] = bytes(state["value"])
            state["field"].clear()
            state["value"].clear()

        def headers_finished():
            disposition, parameters = parse_options_header(state["headers"].get(b"content-disposition", b""))
            if disposition != b"form-data" or parameters.get(b"name") != b"file" or b"filename" not in parameters:
                raise HTTPException(400, "需要 file 文件字段")
            filename = parameters[b"filename"].decode("utf-8", errors="replace")
            state["name"] = safe_name(filename)

        def data_received(data, start, end):
            state["size"] += end-start
            if state["size"] >= MAX_FILE_BYTES:
                raise HTTPException(413, "文件必须小于 100 MB（100,000,000 字节）")
            chunk = memoryview(data)[start:end]
            digest.update(chunk)
            if len(state["head"]) < 512:
                state["head"].extend(chunk[:512-len(state["head"])])
            fp.write(chunk)

        def part_end():
            state["part_done"] = True

        def finished():
            state["done"] = True

        parser = MultipartParser(boundary, {"on_part_begin": part_begin, "on_header_field": header_field,
              "on_header_value": header_value, "on_header_end": header_end, "on_headers_finished": headers_finished,
              "on_part_data": data_received, "on_part_end": part_end, "on_end": finished})
        total = 0
        try:
            with temporary.open("xb") as fp:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > MAX_UPLOAD_BODY:
                        raise HTTPException(413, "请求体超过上传上限")
                    parser.write(chunk)
                parser.finalize()
                if not state["done"] or not state["part_done"]:
                    raise HTTPException(400, "附件上传不完整")
                fp.flush()
                os.fsync(fp.fileno())
            mime, kind = sniff_media(bytes(state["head"]), state["name"])
            temporary.replace(final)
            try:
                with store.transaction() as conn:
                    conn.execute("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?)", (aid, cid, user["id"], state["name"], state["size"], mime, kind, digest.hexdigest(), now()))
                    result = store.attachment(conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone())
            except BaseException:
                final.unlink(missing_ok=True)
                raise
            return result
        except MultipartParseError:
            raise HTTPException(400, "附件格式无效") from None
        except OSError:
            raise HTTPException(507, "服务器无法保存附件，请检查可用空间") from None
        finally:
            temporary.unlink(missing_ok=True)

    @app.post("/api/attachments/{aid}/ticket")
    def media_ticket(aid: str, user=Depends(identity)):
        with store.transaction() as conn:
            row = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
            if not row:
                raise HTTPException(404, "附件不存在")
            authorize(row["conversation_id"], user)
            token = secrets.token_urlsafe(32)
            conn.execute("DELETE FROM media_tickets WHERE expires<?", (time.time(),))
            conn.execute("INSERT INTO media_tickets VALUES(?,?,?,?)", (token_hash(token), aid, user["session_hash"], time.time()+300))
        return {"url": f"/api/attachments/{aid}/content?ticket={token}", "expires_in": 300}

    @app.get("/api/attachments/{aid}/content")
    def content(aid: str, ticket: str = Query(min_length=1, max_length=200), download: int = 0):
        with store.lock:
            grant = store.conn.execute("SELECT * FROM media_tickets WHERE hash=? AND attachment_id=? AND expires>?", (token_hash(ticket), aid, time.time())).fetchone()
            user = store.session(grant["session_hash"]) if grant else None
            if not user:
                raise HTTPException(401, "附件链接已过期")
            row = store.conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
            authorize(row["conversation_id"], user)
        path = store.attachments / f"{aid}.bin"
        if not path.is_file():
            raise HTTPException(404, "附件文件缺失")
        disposition = "attachment" if download or row["kind"] == "file" else "inline"
        return FileResponse(path, media_type=row["mime"], filename=row["name"], content_disposition_type=disposition)

    @app.post("/api/ws-ticket")
    def ws_ticket(user=Depends(identity)):
        ticket = secrets.token_urlsafe(32)
        with store.transaction() as conn:
            conn.execute("DELETE FROM ws_tickets WHERE expires<?", (time.time(),))
            conn.execute("INSERT INTO ws_tickets VALUES(?,?,?)", (token_hash(ticket), user["session_hash"], time.time()+30))
        return {"ticket": ticket}

    @app.websocket("/api/ws")
    async def websocket(ws: WebSocket, ticket: str = ""):
        with store.transaction() as conn:
            row = conn.execute("SELECT * FROM ws_tickets WHERE hash=? AND expires>?", (token_hash(ticket), time.time())).fetchone()
            if row:
                conn.execute("DELETE FROM ws_tickets WHERE hash=?", (token_hash(ticket),))
            user = store.session(row["session_hash"]) if row else None
        if not user:
            await ws.close(code=1008)
            return
        await ws.accept()
        hub.clients[ws] = (user["id"], row["session_hash"], asyncio.Lock())
        try:
            while True:
                if not store.session(row["session_hash"]):
                    await ws.close(code=1008)
                    break
                try:
                    value = await asyncio.wait_for(ws.receive_text(), timeout=30)
                except asyncio.TimeoutError:
                    await hub.send(ws, {"type": "ping"})
                    continue
                if len(value) > 256:
                    await ws.close(code=1009)
                    break
                # WS is notification-only; message mutations must use the authenticated API.
                import json
                try:
                    payload = json.loads(value)
                except ValueError:
                    await ws.close(code=1003)
                    break
                if isinstance(payload, dict) and payload.get("type") == "ping":
                    await hub.send(ws, {"type": "pong"})
        except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
            pass
        finally:
            hub.clients.pop(ws, None)

    @app.get("/api/agent/events")
    def agent_events(after: int = Query(default=0, ge=0), limit: int = Query(default=50, ge=1, le=100), user=Depends(identity)):
        if not user["is_bot"]:
            raise HTTPException(403, "仅机器人可监听事件")
        with store.lock:
            rows = store.conn.execute("SELECT msg.* FROM messages msg JOIN members m ON m.conversation_id=msg.conversation_id JOIN users u ON u.id=msg.sender_id WHERE m.user_id=? AND msg.id>? AND u.is_bot=0 ORDER BY msg.id LIMIT ?", (user["id"], after, limit)).fetchall()
            return {"events": [store.message(row) for row in rows], "cursor": rows[-1]["id"] if rows else after}

    client_dir = Path(__file__).resolve().parents[1] / "client"
    app.mount("/", StaticFiles(directory=client_dir, html=True, check_dir=False), name="client")
    return app


app = create_app()
