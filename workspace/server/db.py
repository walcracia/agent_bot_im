"""SQLite persistence. Every transaction is serialized inside this process."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import sqlite3
import threading


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def password_hash(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f"scrypt${salt}${digest}"


def password_matches(password: str, encoded: str) -> bool:
    try:
        _, salt, expected = encoded.split("$")
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def public_user(row) -> dict:
    return {"id": row["id"], "username": row["username"], "display_name": row["display_name"],
            "is_admin": bool(row["is_admin"]), "is_bot": bool(row["is_bot"])}


class Store:
    def __init__(self, data_dir: str | Path | None = None):
        self.data_dir = Path(data_dir or os.environ.get("IM_DATA_DIR") or Path(__file__).resolve().parents[1] / "data").resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.attachments = self.data_dir / "attachments"
        self.attachments.mkdir(exist_ok=True)
        (self.attachments / ".uploads").mkdir(exist_ok=True)
        self.path = self.data_dir / "chat.sqlite3"
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, timeout=15)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=15000")
        self.conn.executescript("""
        CREATE TABLE IF NOT EXISTS users(
          id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
          is_bot INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(
          hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations(
          id TEXT PRIMARY KEY, title TEXT NOT NULL, is_direct INTEGER NOT NULL DEFAULT 0,
          direct_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members(
          conversation_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL REFERENCES users(id),
          read_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,user_id));
        CREATE TABLE IF NOT EXISTS attachments(
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, size INTEGER NOT NULL,
          mime TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(
          id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          sender_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL,
          attachment_id TEXT REFERENCES attachments(id), client_id TEXT NOT NULL, created_at TEXT NOT NULL,
          UNIQUE(conversation_id,sender_id,client_id));
        CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,id);
        CREATE INDEX IF NOT EXISTS members_user ON members(user_id,conversation_id);
        CREATE TABLE IF NOT EXISTS ws_tickets(
          hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
          expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS media_tickets(
          hash TEXT PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES attachments(id),
          session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE, expires REAL NOT NULL);
        """)
        self.conn.commit()

    @contextmanager
    def transaction(self):
        with self.lock:
            try:
                yield self.conn
                self.conn.commit()
            except BaseException:
                self.conn.rollback()
                raise

    def create_user(self, username: str, display_name: str, password: str, *, is_admin=False, is_bot=False) -> dict:
        uid = secrets.token_hex(12)
        encoded = password_hash(password)
        with self.transaction() as conn:
            conn.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)", (uid, username, display_name, encoded, int(is_admin), int(is_bot), now()))
            return public_user(conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone())

    def issue_session(self, user_id: str, seconds: int) -> str:
        import time
        token = secrets.token_urlsafe(40)
        with self.transaction() as conn:
            conn.execute("INSERT INTO sessions VALUES(?,?,?)", (token_hash(token), user_id, time.time()+seconds))
        return token

    def session(self, hashed: str):
        import time
        with self.lock:
            row = self.conn.execute("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?", (hashed, time.time())).fetchone()
            return public_user(row) if row else None

    def member(self, conversation_id: str, user_id: str) -> bool:
        with self.lock:
            return self.conn.execute("SELECT 1 FROM members WHERE conversation_id=? AND user_id=?", (conversation_id, user_id)).fetchone() is not None

    def attachment(self, row) -> dict | None:
        if row is None:
            return None
        return {key: row[key] for key in ("id", "name", "size", "mime", "kind", "sha256")}

    def message(self, row) -> dict:
        with self.lock:
            sender = self.conn.execute("SELECT * FROM users WHERE id=?", (row["sender_id"],)).fetchone()
            attachment = self.conn.execute("SELECT * FROM attachments WHERE id=?", (row["attachment_id"],)).fetchone() if row["attachment_id"] else None
            return {"id": row["id"], "conversation_id": row["conversation_id"], "sender": public_user(sender),
                    "text": row["text"], "attachment": self.attachment(attachment), "client_id": row["client_id"], "created_at": row["created_at"]}

    def conversation(self, cid: str, user_id: str) -> dict:
        with self.lock:
            row = self.conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
            members = self.conn.execute("SELECT u.* FROM users u JOIN members m ON m.user_id=u.id WHERE m.conversation_id=? ORDER BY u.display_name", (cid,)).fetchall()
            last = self.conn.execute("SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1", (cid,)).fetchone()
            unread = self.conn.execute("SELECT COUNT(*) FROM messages WHERE conversation_id=? AND sender_id!=? AND id>COALESCE((SELECT read_id FROM members WHERE conversation_id=? AND user_id=?),0)", (cid, user_id, cid, user_id)).fetchone()[0]
            return {"id": cid, "title": row["title"], "is_direct": bool(row["is_direct"]), "members": [public_user(m) for m in members],
                    "last_message": self.message(last) if last else None, "unread_count": unread, "updated_at": row["updated_at"]}
