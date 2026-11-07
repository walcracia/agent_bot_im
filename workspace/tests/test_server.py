"""Meaningful API contracts against isolated on-disk SQLite and real multipart bodies."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server.app import MAX_FILE_BYTES, create_app
from server.db import Store, password_matches, token_hash


@pytest.fixture
def env(tmp_path):
    app = create_app(tmp_path / "server")
    store = app.state.store
    admin = store.create_user("admin", "Admin", "admin-password", is_admin=True)
    alice = store.create_user("alice", "Alice", "alice-password")
    bob = store.create_user("bob", "Bob", "bob-password")
    outsider = store.create_user("outsider", "Outsider", "outside-password")
    bot = store.create_user("dsh", "DSH", "bot-password", is_bot=True)
    auth = {u["username"]: {"Authorization": "Bearer " + store.issue_session(u["id"], 3600)}
            for u in [admin, alice, bob, outsider, bot]}
    with TestClient(app) as client:
        response = client.post("/api/conversations", headers=auth["alice"], json={"title": "Test", "member_ids": [bob["id"], bot["id"]]})
        assert response.status_code == 201
        yield {"client": client, "app": app, "store": store, "auth": auth,
               "alice": alice, "bob": bob, "admin": admin, "outsider": outsider, "bot": bot,
               "cid": response.json()["id"]}


def send(env, text="hello", sender="alice", client_id="message-1", cid=None, **extra):
    return env["client"].post(f"/api/conversations/{cid or env['cid']}/messages", headers=env["auth"][sender],
                              json={"text": text, "client_id": client_id, **extra})


def upload(env, data, name="report.txt", sender="alice", mime="text/plain"):
    return env["client"].post(f"/api/conversations/{env['cid']}/attachments", headers=env["auth"][sender], files={"file": (name, data, mime)})


def test_identity_hash_logout_and_no_public_registration(env):
    client = env["client"]
    assert client.get("/api/health").json()["max_file_bytes"] == MAX_FILE_BYTES
    assert client.get("/api/users").status_code == 401
    assert client.get("/api/me", headers={"Authorization": "Bearer not-a-token"}).status_code == 401
    assert client.post("/api/login", json={"username": "alice", "password": "wrong"}).status_code == 401
    login = client.post("/api/login", json={"username": "alice", "password": "alice-password"}).json()
    assert login["user"] == env["alice"]
    token = login["token"]
    auth = {"Authorization": f"Bearer {token}"}
    with env["store"].lock:
        row = env["store"].conn.execute("SELECT hash FROM sessions WHERE hash=?", (token_hash(token),)).fetchone()
        assert row["hash"] != token
        encoded = env["store"].conn.execute("SELECT password_hash FROM users WHERE username='alice'").fetchone()[0]
        assert encoded != "alice-password" and password_matches("alice-password", encoded)
    assert client.post("/api/logout", headers=auth).status_code == 200
    assert client.get("/api/me", headers=auth).status_code == 401


def test_login_rate_limit(env):
    client = env["client"]
    for _ in range(5):
        assert client.post("/api/login", json={"username": "alice", "password": "bad"}).status_code == 401
    assert client.post("/api/login", json={"username": "alice", "password": "alice-password"}).status_code == 429


def test_admin_account_and_bot_token_permissions(env):
    client = env["client"]
    body = {"username": "newbie", "display_name": "New", "password": "a-long-password"}
    assert client.post("/api/admin/users", headers=env["auth"]["alice"], json=body).status_code == 403
    created = client.post("/api/admin/users", headers=env["auth"]["admin"], json=body)
    assert created.status_code == 201
    assert created.json()["is_admin"] is False
    assert client.post("/api/admin/users", headers=env["auth"]["admin"], json=body).status_code == 409
    url = f"/api/admin/users/{env['bot']['id']}/token"
    assert client.post(url, headers=env["auth"]["alice"]).status_code == 403
    token = client.post(url, headers=env["auth"]["admin"]).json()["token"]
    assert client.get("/api/me", headers={"Authorization": "Bearer " + token}).json()["is_bot"] is True
    assert client.post(f"/api/admin/users/{env['alice']['id']}/token", headers=env["auth"]["admin"]).status_code == 422


def test_direct_reuse_membership_and_visibility(env):
    client = env["client"]
    body = {"member_ids": [env["bob"]["id"]], "is_direct": True}
    first = client.post("/api/conversations", headers=env["auth"]["alice"], json=body).json()
    again = client.post("/api/conversations", headers=env["auth"]["bob"], json={"member_ids": [env["alice"]["id"]], "is_direct": True}).json()
    assert first["id"] == again["id"]
    assert client.get("/api/conversations", headers=env["auth"]["outsider"]).json() == []
    assert client.get(f"/api/conversations/{env['cid']}/messages", headers=env["auth"]["outsider"]).status_code == 403
    assert send(env, sender="outsider").status_code == 403
    assert client.post("/api/conversations", headers=env["auth"]["alice"], json={"member_ids": ["unknown"]}).status_code == 422


def test_message_idempotence_pagination_unread_and_text_safety(env):
    client = env["client"]
    text = '<img src=x onerror="alert(1)"> 你好'
    message = send(env, text).json()
    assert message["text"] == text
    assert send(env, text).json()["id"] == message["id"]
    assert send(env, "changed").status_code == 409
    second = send(env, "second", client_id="m2").json()
    third = send(env, "third", client_id="m3").json()
    url = f"/api/conversations/{env['cid']}/messages"
    assert [m["id"] for m in client.get(url+"?limit=2", headers=env["auth"]["bob"]).json()] == [second["id"], third["id"]]
    assert [m["id"] for m in client.get(url+f"?before={second['id']}", headers=env["auth"]["bob"]).json()] == [message["id"]]
    assert client.get("/api/conversations", headers=env["auth"]["bob"]).json()[0]["unread_count"] == 3
    assert client.post(f"/api/conversations/{env['cid']}/read", headers=env["auth"]["bob"], json={"message_id": third["id"]}).status_code == 200
    assert client.get("/api/conversations", headers=env["auth"]["bob"]).json()[0]["unread_count"] == 0
    assert send(env, "   ", client_id="empty").status_code == 422
    assert send(env, "x"*10001, client_id="long").status_code == 422


@pytest.mark.parametrize(("name", "data", "kind", "mime"), [
    ("photo.png", b"\x89PNG\r\n\x1a\n"+b"content", "image", "image/png"),
    ("photo.jpg", b"\xff\xd8\xff\xe0data", "image", "image/jpeg"),
    ("sound.wav", b"RIFF\x10\x00\x00\x00WAVEfmt ", "audio", "audio/wav"),
    ("sound.mp3", b"ID3\x04\x00\x00content", "audio", "audio/mpeg"),
    ("movie.mp4", b"\x00\x00\x00\x18ftypisom"+b"\x00"*12, "video", "video/mp4"),
    ("movie.webm", b"\x1a\x45\xdf\xa3\x01webm\x00", "video", "video/webm"),
    ("pretend.png", b"<html><script>alert(1)</script></html>", "file", "application/octet-stream"),
    ("vector.svg", b'<svg xmlns="http://www.w3.org/2000/svg"/>', "file", "application/octet-stream"),
])
def test_attachment_sniffing_hash_access_and_range(env, name, data, kind, mime):
    client = env["client"]
    response = upload(env, data, name, mime="image/png")
    assert response.status_code == 201, response.text
    attachment = response.json()
    assert attachment["kind"] == kind and attachment["mime"] == mime
    assert attachment["sha256"] == hashlib.sha256(data).hexdigest()
    message = send(env, "", attachment_id=attachment["id"]).json()
    assert message["attachment"]["id"] == attachment["id"]
    assert send(env, "", sender="bob", client_id="stolen", attachment_id=attachment["id"]).status_code == 403
    ticket_url = f"/api/attachments/{attachment['id']}/ticket"
    assert client.post(ticket_url, headers=env["auth"]["outsider"]).status_code == 403
    url = client.post(ticket_url, headers=env["auth"]["bob"]).json()["url"]
    downloaded = client.get(url)
    assert downloaded.content == data
    assert downloaded.headers["x-content-type-options"] == "nosniff"
    assert downloaded.headers["content-disposition"].startswith("attachment" if kind == "file" else "inline")
    part = client.get(url, headers={"Range": "bytes=1-3"})
    assert part.status_code == 206 and part.content == data[1:4]
    assert client.get(url, headers={"Range": "bytes=9999-99999"}).status_code == 416
    assert client.get(url+"&download=1").headers["content-disposition"].startswith("attachment")


def test_attachment_ticket_expiry_logout_and_filename(env):
    client = env["client"]
    attachment = upload(env, b"example", "../../unsafe\\report.txt").json()
    assert attachment["name"] == "report.txt"
    url = client.post(f"/api/attachments/{attachment['id']}/ticket", headers=env["auth"]["bob"]).json()["url"]
    with env["store"].transaction() as conn:
        conn.execute("UPDATE media_tickets SET expires=?", (time.time()-1,))
    assert client.get(url).status_code == 401
    url = client.post(f"/api/attachments/{attachment['id']}/ticket", headers=env["auth"]["bob"]).json()["url"]
    client.post("/api/logout", headers=env["auth"]["bob"])
    assert client.get(url).status_code == 401
    assert upload(env, b"secret", sender="outsider").status_code == 403


def test_multipart_validation_cancellation_and_chunked_body_bound(env):
    client = env["client"]
    url = f"/api/conversations/{env['cid']}/attachments"
    assert client.post(url, headers=env["auth"]["alice"], content=b"not multipart").status_code == 400
    auth = {**env["auth"]["alice"], "Content-Type": "multipart/form-data; boundary=test"}
    truncated = b'--test\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\n\r\ntruncated'
    assert client.post(url, headers=auth, content=truncated).status_code == 400
    assert not list((env["store"].attachments/".uploads").iterdir())
    assert client.post(url, headers=env["auth"]["alice"], files=[("file", ("one", b"1")), ("file", ("two", b"2"))]).status_code == 400
    assert not list((env["store"].attachments/".uploads").iterdir())


def test_json_body_limit_and_validation_never_echoes_password(env):
    client = env["client"]
    secret = "secret-" * 40
    invalid = client.post("/api/login", json={"username": "alice", "password": secret})
    assert invalid.status_code == 422
    assert secret not in invalid.text and isinstance(invalid.json()["detail"], str)
    assert client.post("/api/login", content=b"x" * 65537, headers={"Content-Type": "application/json"}).status_code == 413
    def chunks():
        yield b'{"username":"'
        yield b"x" * 65537
        yield b'","password":"test"}'
    assert client.post("/api/login", content=chunks(), headers={"Content-Type": "application/json"}).status_code == 413


def test_upload_authorizes_before_consuming_body(env):
    touched = []
    def chunks():
        touched.append(True)
        yield b"this body must not be read"
    response = env["client"].post(f"/api/conversations/{env['cid']}/attachments", headers={**env["auth"]["outsider"], "Content-Type": "multipart/form-data; boundary=test"}, content=chunks())
    assert response.status_code == 403 and touched == []


def test_storage_failure_leaves_no_attachment_or_partial_file(env, monkeypatch):
    def disk_full(_):
        raise OSError("sensitive host filesystem details")
    monkeypatch.setattr("server.app.os.fsync", disk_full)
    response = upload(env, b"not saved")
    assert response.status_code == 507 and "sensitive" not in response.text
    assert not list(env["store"].attachments.glob("*.bin"))
    assert not list((env["store"].attachments / ".uploads").iterdir())
    with env["store"].lock:
        assert env["store"].conn.execute("SELECT COUNT(*) FROM attachments").fetchone()[0] == 0


@pytest.mark.parametrize(("size", "accepted"), [(99_999_999, True), (100_000_000, False)])
def test_real_100mb_boundary(env, size, accepted):
    """Use a real 100MB multipart file (not a mocked size or lowered constant)."""
    with tempfile.TemporaryFile() as file:
        block = b"b" * 1024 * 1024
        remaining = size
        while remaining:
            chunk = block[:min(remaining, len(block))]
            file.write(chunk)
            remaining -= len(chunk)
        file.seek(0)
        response = upload(env, file, "boundary.bin")
    assert response.status_code == (201 if accepted else 413), response.text
    assert not list((env["store"].attachments/".uploads").iterdir())
    if accepted:
        assert response.json()["size"] == size
        assert (env["store"].attachments/f"{response.json()['id']}.bin").stat().st_size == size
    else:
        assert not list(env["store"].attachments.glob("*.bin"))


def test_websocket_ticket_single_use_ping_delivery_and_isolation(env):
    client = env["client"]
    def get_ticket(who):
        return client.post("/api/ws-ticket", headers=env["auth"][who]).json()["ticket"]
    ticket = get_ticket("bob")
    with client.websocket_connect(f"/api/ws?ticket={ticket}") as ws:
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}
        message = send(env, "real-time").json()
        assert ws.receive_json() == {"type": "message", "message": message}
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/api/ws?ticket={ticket}"):
                pass
    with client.websocket_connect(f"/api/ws?ticket={get_ticket('outsider')}") as ws:
        send(env, "hidden message", client_id="hidden")
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}, "Outsider must not receive conversation events"
    with env["store"].transaction() as conn:
        conn.execute("UPDATE ws_tickets SET expires=0")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/ws?ticket=invalid"):
            pass


def test_bot_events_membership_cursor_and_no_bot_loops(env):
    client = env["client"]
    first = send(env, "@dsh do something").json()
    send(env, "DSH reply", sender="dsh", client_id="bot-1")
    hidden_cid = client.post("/api/conversations", headers=env["auth"]["alice"], json={"member_ids": [env["bob"]["id"]], "is_direct": True}).json()["id"]
    send(env, "not visible to DSH", cid=hidden_cid, client_id="hidden")
    second = send(env, "another event", client_id="event-2").json()
    assert client.get("/api/agent/events", headers=env["auth"]["alice"]).status_code == 403
    events = client.get("/api/agent/events", headers=env["auth"]["dsh"]).json()
    assert [m["id"] for m in events["events"]] == [first["id"], second["id"]]
    assert events["cursor"] == second["id"]
    assert client.get(f"/api/agent/events?after={first['id']}", headers=env["auth"]["dsh"]).json()["events"] == [second]
    assert client.get(f"/api/agent/events?after={second['id']}", headers=env["auth"]["dsh"]).json() == {"events": [], "cursor": second["id"]}


def test_sqlite_persistence_survives_app_recreation(tmp_path):
    data = tmp_path / "persistent"
    app = create_app(data)
    app.state.store.create_user("admin", "Admin", "long-password", is_admin=True)
    with TestClient(app) as client:
        assert client.post("/api/login", json={"username": "admin", "password": "long-password"}).status_code == 200
    restored = create_app(data)
    with TestClient(restored) as client:
        assert client.post("/api/login", json={"username": "admin", "password": "long-password"}).status_code == 200


def test_expired_session_and_cors(env):
    client = env["client"]
    cors = client.options("/api/me", headers={"Origin": "null", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization"})
    assert cors.status_code == 200 and cors.headers["access-control-allow-origin"] == "null"
    blocked = client.options("/api/me", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert blocked.status_code == 400
    with env["store"].transaction() as conn:
        conn.execute("UPDATE sessions SET expires=0")
    assert client.get("/api/me", headers=env["auth"]["alice"]).status_code == 401
