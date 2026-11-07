"""Explicit account setup; no default production credentials or automatic demo seeding."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys

from .db import Store, now


def main():
    parser = argparse.ArgumentParser(description="同频 Team Relay server administration")
    commands = parser.add_subparsers(dest="command", required=True)
    admin = commands.add_parser("init-admin")
    admin.add_argument("--data-dir")
    admin.add_argument("--username", default="admin")
    admin.add_argument("--display-name", default="管理员")
    admin.add_argument("--password-env", default="IM_ADMIN_PASSWORD")
    demo = commands.add_parser("seed-demo")
    demo.add_argument("--data-dir", required=True, help="Must be an empty isolated test data directory")
    demo.add_argument("--credentials-file", required=True, help="Write generated credentials to an ignored local file")
    args = parser.parse_args()
    if args.command == "init-admin":
        password = os.environ.get(args.password_env, "")
        if len(password) < 10 or len(password) > 200:
            parser.error(f"Set {args.password_env} to a password containing 10–200 characters")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", args.username):
            parser.error("Invalid username")
        store = Store(args.data_dir)
        try:
            user = store.create_user(args.username, args.display_name, password, is_admin=True)
        except sqlite3.IntegrityError:
            parser.error("Username already exists; existing credentials were not changed")
        print(json.dumps({"created": user["username"], "data_dir": str(store.data_dir)}, ensure_ascii=False))
        store.conn.close()
        return

    store = Store(args.data_dir)
    with store.lock:
        if store.conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
            parser.error("Refusing to seed a nonempty database")
    generated = []
    for username, display_name, admin, bot in [("admin", "林一", True, False), ("alice", "陈夏", False, False), ("bob", "周牧", False, False), ("dsh", "小同", False, True)]:
        password = secrets.token_urlsafe(18)
        user = store.create_user(username, display_name, password, is_admin=admin, is_bot=bot)
        generated.append({"username": username, "password": password, "user": user})
    cid = secrets.token_hex(12)
    stamp = now()
    with store.transaction() as conn:
        conn.execute("INSERT INTO conversations VALUES(?,?,0,NULL,?,?)", (cid, "产品协作组", stamp, stamp))
        conn.executemany("INSERT INTO members(conversation_id,user_id) VALUES(?,?)", [(cid, item["user"]["id"]) for item in generated])
        conn.execute("INSERT INTO messages(conversation_id,sender_id,text,client_id,created_at) VALUES(?,?,?,?,?)", (cid, generated[1]["user"]["id"], "早上好，今天的方案我们在这里一起讨论。", "demo-welcome", stamp))
        conn.execute("INSERT INTO messages(conversation_id,sender_id,text,client_id,created_at) VALUES(?,?,?,?,?)", (cid, generated[2]["user"]["id"], "好，我整理一下刚才的想法，稍后发给大家。", "demo-media", stamp))
    output = Path(args.credentials_file).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"warning": "Local isolated demo credentials. Never commit.", "accounts": generated, "conversation_id": cid}, ensure_ascii=False, indent=2), encoding="utf-8")
    store.conn.close()
    print(f"Created isolated demo. Credentials saved to {output}; no passwords printed.")


if __name__ == "__main__":
    main()
