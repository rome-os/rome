#!/usr/bin/env python3
"""Reads the signed-in WeChat account's own store, for channels/wechat-user.ts.

Commands answer JSON on stdout:

    derive --passphrase <hex>   turn the recovered passphrase into per-database
                                keys, verify each, and write them where the
                                reader looks
    conversations --limit N [--query Q]
    messages [--conversation ID] [--since UNIX] --limit N
    count --conversation ID
    check                     verify stored keys against the current databases

Exit 3 means the account is not readable — signed out, or a key that no longer
fits. Exit 4 means the client is still creating the databases after login,
including a required database the passphrase does not open yet while it opens
others. The caller retries that state with the captured passphrase. Other non-zero
exits are transient failures.

This exists because WeChat's formats are not something to re-derive: SQLCipher
page layout, zstd message bodies, sharded per-chat tables, rich-message
envelopes. `wechat-cli` already models all of it, but renders every message as a
display string, which loses the fields a caller wants. So the reads here call
its internals and keep the fields, and only the key derivation is written out —
it is twenty lines and pinning it locally beats depending on a private helper.
"""
import argparse
import binascii
import glob
import hashlib
import hmac
import json
import os
import re
import sqlite3
import struct
import sys
import tempfile
from contextlib import closing

PAGE_SIZE = 4096
SALT_SIZE = 16
KEY_SIZE = 32
# SQLCipher keeps 80 bytes per page for the IV and the page HMAC.
RESERVE = 80
PBKDF2_ITERATIONS = 256000

HOME = os.environ.get("HOME", os.path.expanduser("~"))
KEYS_FILE = os.path.join(HOME, ".wechat-cli", "all_keys.json")
CONFIG_FILE = os.path.join(HOME, ".wechat-cli", "config.json")


class Unavailable(Exception):
    """The account cannot be read. Reported as exit 3."""


class Pending(Exception):
    """The client is still creating its message store. Reported as exit 4."""


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(3)


# ── key derivation ────────────────────────────────────────────────────────


def verify_key(enc_key, page1):
    """Does this key open this database?

    SQLCipher authenticates each page with an HMAC keyed by a value derived
    from the page key, so page 1 verifying is proof the key is right — far
    cheaper and safer than attempting a decrypt and inspecting the result.
    """
    salt = page1[:SALT_SIZE]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SIZE)
    body = page1[SALT_SIZE:PAGE_SIZE - RESERVE + SALT_SIZE]
    stored = page1[PAGE_SIZE - 64:PAGE_SIZE]
    mac = hmac.new(mac_key, body, hashlib.sha512)
    mac.update(struct.pack("<I", 1))
    return hmac.compare_digest(mac.digest(), stored)


def account_dir():
    for path in sorted(glob.glob(os.path.join(HOME, "xwechat_files", "*", "db_storage"))):
        return os.path.dirname(path)
    return None


def collect_databases(db_dir):
    """Every database under the account, with the salt each is keyed by.

    Databases sharing a salt share a key, so they are derived once — a large
    account has dozens of shards and PBKDF2 at 256000 iterations is not free.
    """
    found = []
    for root, _dirs, files in os.walk(db_dir):
        for name in files:
            if not name.endswith(".db"):
                continue
            path = os.path.join(root, name)
            try:
                with open(path, "rb") as f:
                    page1 = f.read(PAGE_SIZE)
            except OSError:
                continue
            if len(page1) < PAGE_SIZE:
                continue
            found.append({
                "rel": os.path.relpath(path, db_dir),
                "size": os.path.getsize(path),
                "salt": page1[:SALT_SIZE].hex(),
                "page1": page1,
            })
    return found


def cmd_derive(args):
    db_dir = None
    account = account_dir()
    if account:
        db_dir = os.path.join(account, "db_storage")
    if not db_dir or not os.path.isdir(db_dir):
        fail("The WeChat account is signed out on this instance.")

    try:
        passphrase = binascii.unhexlify(args.passphrase.strip())
    except (binascii.Error, ValueError):
        fail("The recovered passphrase is not hex.")

    databases = collect_databases(db_dir)
    if not databases:
        raise Pending("The signed-in account has no message databases yet.")

    by_salt = {}
    for db in databases:
        by_salt.setdefault(db["salt"], []).append(db)

    keys = {}
    for salt_hex, group in by_salt.items():
        enc_key = hashlib.pbkdf2_hmac(
            "sha512", passphrase, bytes.fromhex(salt_hex), PBKDF2_ITERATIONS, dklen=KEY_SIZE
        )
        for db in group:
            if not verify_key(enc_key, db["page1"]):
                continue
            keys[db["rel"]] = {
                "enc_key": enc_key.hex(),
                "salt": salt_hex,
                "size_mb": round(db["size"] / 1048576, 1),
            }

    if not keys:
        fail("The recovered passphrase does not open this account's databases.")

    # The passphrase has opened at least one database, so it is the account's.
    # A required database it does not open yet is one the client created but
    # has not finished writing. Its first page is still being laid down.
    validate_keys(db_dir, keys, invalid=Pending)

    write_private_json(KEYS_FILE, keys)
    write_private_json(CONFIG_FILE, {"db_dir": db_dir})

    print(json.dumps({
        "derived": len(keys),
        "databases": len(databases),
        "wxid": os.path.basename(account),
    }))


def write_private_json(path, value):
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    if os.path.islink(directory) or os.stat(directory).st_uid != os.geteuid():
        raise Unavailable("The reader directory must be owned by the runtime user.")
    os.chmod(directory, 0o700)
    fd, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_keys(db_dir, keys, invalid=Unavailable):
    """Authenticate the session and every message shard before exposing history.

    `invalid` is raised for a database no key opens. Stored keys that stop
    fitting are a locked store, while a fresh derive waits for the client.
    """
    required = [os.path.join(db_dir, "session", "session.db")]
    shards = sorted(glob.glob(os.path.join(db_dir, "message", "message_*.db")))
    shards = [path for path in shards if re.fullmatch(r"message_\d+\.db", os.path.basename(path))]
    if not shards:
        raise Pending("The WeChat message databases are not available yet.")
    required.extend(shards)
    for path in required:
        rel = os.path.relpath(path, db_dir)
        if not os.path.exists(path) or os.path.getsize(path) < PAGE_SIZE:
            raise Pending(f"The WeChat client is still creating {rel}.")
        entry = keys.get(rel, {})
        try:
            key = bytes.fromhex(entry.get("enc_key", ""))
            with open(path, "rb") as f:
                page = f.read(PAGE_SIZE)
            valid = len(key) == KEY_SIZE and len(page) == PAGE_SIZE and verify_key(key, page)
        except (OSError, ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise invalid(f"The WeChat message store is locked: {rel} has no valid key.")


def check_keys():
    account = account_dir()
    if not account:
        raise Unavailable("The WeChat account is signed out on this instance.")
    try:
        with open(KEYS_FILE, encoding="utf-8") as f:
            keys = json.load(f)
        with open(CONFIG_FILE, encoding="utf-8") as f:
            config = json.load(f)
    except (FileNotFoundError, ValueError):
        raise Unavailable("The WeChat message store has not been unlocked yet.")
    db_dir = os.path.join(account, "db_storage")
    if not isinstance(keys, dict) or not isinstance(config, dict) or config.get("db_dir") != db_dir:
        raise Unavailable("The WeChat reader keys do not belong to this account.")
    validate_keys(db_dir, keys)
    return {"keysReady": True, "wxid": os.path.basename(account)}


def cmd_check(_args):
    print(json.dumps(check_keys()))


# ── reads ─────────────────────────────────────────────────────────────────


_app = None


def app_context():
    """wechat-cli's own context, which owns decrypting the databases."""
    global _app
    check_keys()
    if _app is None:
        try:
            from wechat_cli.core.context import AppContext
        except ImportError as e:
            raise Unavailable(f"The WeChat reader is not installed: {e}") from e
        _app = AppContext()
    return _app


def cmd_conversations(args):
    app = app_context()
    from wechat_cli.core.contacts import get_contact_names
    from wechat_cli.core.messages import decompress_content

    path = app.cache.get(os.path.join("session", "session.db"))
    if not path:
        raise Unavailable("The WeChat session database could not be decrypted.")

    names = get_contact_names(app.cache, app.decrypted_dir)
    # Over-fetch when filtering: the filter is on the display name, which the
    # session table does not carry.
    fetch = args.limit if not args.query else min(args.limit * 10, 500)
    with closing(sqlite3.connect(path)) as conn:
        rows = conn.execute(
            "SELECT username, unread_count, summary, last_timestamp FROM SessionTable"
            " WHERE last_timestamp > 0 ORDER BY last_timestamp DESC LIMIT ?",
            (fetch,),
        ).fetchall()

    needle = args.query.lower() if args.query else None
    out = []
    for username, unread, summary, ts in rows:
        display = names.get(username, username)
        if needle and needle not in display.lower() and needle not in username.lower():
            continue
        if isinstance(summary, bytes):
            summary = decompress_content(summary, 4) or ""
        if isinstance(summary, str) and ":\n" in summary:
            summary = summary.split(":\n", 1)[1]
        out.append({
            "id": username,
            "name": display,
            "isGroup": "@chatroom" in username,
            "unread": unread or 0,
            "lastMessageAt": ts,
            "lastMessagePreview": str(summary or ""),
        })
        if len(out) >= args.limit:
            break
    print(json.dumps({"conversations": out}, ensure_ascii=False))


# WeChat's numeric message kinds, named so a caller never has to match on the
# CLI's display language.
TYPE_NAMES = {
    1: "text", 3: "image", 34: "voice", 43: "video", 47: "sticker",
    48: "location", 49: "link", 50: "call", 10000: "system",
}
# A rich message renders as a short placeholder followed by its whole
# serialized envelope, which is CDN keys and AES material rather than anything
# anyone said. Keep the placeholder, drop the envelope.
ENVELOPE_MARKERS = ("<?xml", "<msg>", "<msg ")
MAX_TEXT = 4000


def type_name(local_type):
    from wechat_cli.core.messages import _split_msg_type

    base, sub = _split_msg_type(local_type)
    if base == 49 and sub == 6:
        return "file"
    return TYPE_NAMES.get(base, f"type-{base}")


def clean_text(text):
    if not text:
        return ""
    cut = len(text)
    for marker in ENVELOPE_MARKERS:
        found = text.find(marker)
        if found != -1:
            cut = min(cut, found)
    return text[:cut].strip()[:MAX_TEXT]


def query_message_window(query, conn, table, since_ts, before_ts, limit):
    # Fetch the cursor second in full, plus an older page so a consumed second
    # cannot hide the next page. Include every tie at the older page's edge too.
    rows = query(conn, table, start_ts=since_ts,
                 end_ts=before_ts - 1 if before_ts is not None else None,
                 limit=limit, offset=0)
    if rows:
        edge = min(row[2] for row in rows)
        ties = query(conn, table, start_ts=edge, end_ts=edge, limit=-1, offset=0)
        rows = [row for row in rows if row[2] != edge] + ties
    if before_ts is not None and (since_ts is None or before_ts >= since_ts):
        rows += query(conn, table, start_ts=before_ts, end_ts=before_ts, limit=-1, offset=0)
    return rows


def chat_messages(app, chat_id, names, self_username, since_ts, before_ts, limit, include_boundary_ties=False):
    from wechat_cli.core.messages import (
        _format_message_text,
        _iter_table_contexts,
        _load_name2id_maps,
        _query_messages,
        _resolve_sender_label,
        decompress_content,
        resolve_chat_context,
    )

    ctx = resolve_chat_context(chat_id, app.msg_db_keys, app.cache, app.decrypted_dir)
    if not ctx or not ctx.get("db_path"):
        return []

    collected = []
    for table in _iter_table_contexts(ctx):
        try:
            with closing(sqlite3.connect(table["db_path"])) as conn:
                id_to_username = _load_name2id_maps(conn)
                if include_boundary_ties:
                    rows = query_message_window(
                        _query_messages, conn, table["table_name"], since_ts, before_ts, limit
                    )
                else:
                    rows = _query_messages(conn, table["table_name"], start_ts=since_ts,
                                           end_ts=before_ts, limit=limit, offset=0)
                for row in rows:
                    local_id, local_type, created, real_sender, content, ct = row
                    try:
                        content = decompress_content(content, ct)
                        sender, text = _format_message_text(
                            local_id, local_type, content or "[Unreadable message]",
                            table["is_group"], table["username"], table["display_name"],
                            names, app.display_name_fn,
                            db_dir=app.db_dir, create_time_ts=created,
                        )
                    except Exception:
                        sender, text = "", "[Unreadable message]"
                    label = _resolve_sender_label(
                        real_sender, sender, table["is_group"], table["username"],
                        table["display_name"], names, id_to_username, app.display_name_fn,
                    )
                    sender_id = id_to_username.get(real_sender) or ""
                    if not table["is_group"] and not sender_id:
                        sender_id = table["username"]
                    collected.append({
                        "id": f"{table['username']}:{local_id}",
                        "conversationId": table["username"],
                        "conversationName": table["display_name"],
                        "isGroup": table["is_group"],
                        "senderId": sender_id,
                        "senderName": label or "",
                        "isSelf": bool(self_username) and sender_id == self_username,
                        "timestamp": created,
                        "type": type_name(local_type),
                        "text": clean_text(text) or "[Unreadable message]",
                    })
        except Exception:  # noqa: BLE001
            # One unreadable shard must not lose the rest of the conversation.
            continue

    collected.sort(key=lambda m: m["timestamp"])
    return collected if include_boundary_ties else collected[-limit:]


def cmd_messages(args):
    app = app_context()
    from wechat_cli.core.contacts import get_contact_names, get_self_username

    names = get_contact_names(app.cache, app.decrypted_dir)
    self_username = get_self_username(app.db_dir, app.cache, app.decrypted_dir)

    if args.conversation:
        out = chat_messages(
            app, args.conversation, names, self_username, args.since, args.before, args.limit,
            args.include_boundary_ties
        )
    else:
        # No chat named: read across the most recently active ones. Bounded on
        # purpose — sweeping every chat ever opened is minutes of work, and the
        # caller asked for a page.
        out = []
        recent = argparse.Namespace(limit=20, query=None)
        app_path = app.cache.get(os.path.join("session", "session.db"))
        with closing(sqlite3.connect(app_path)) as conn:
            usernames = [
                r[0] for r in conn.execute(
                    "SELECT username FROM SessionTable WHERE last_timestamp > 0"
                    " ORDER BY last_timestamp DESC LIMIT ?",
                    (recent.limit,),
                ).fetchall()
            ]
        for username in usernames:
            out.extend(
                chat_messages(
                    app, username, names, self_username, args.since, args.before, args.limit
                )
            )
        out.sort(key=lambda m: m["timestamp"])
        out = out[-args.limit:]

    print(json.dumps({"messages": out}, ensure_ascii=False))


def cmd_count(args):
    """Total messages in a conversation, summed over its (possibly sharded)
    tables. Undecodable bodies remain readable as placeholders."""
    app = app_context()
    from wechat_cli.core.messages import (
        _is_safe_msg_table_name,
        _iter_table_contexts,
        resolve_chat_context,
    )

    ctx = resolve_chat_context(args.conversation, app.msg_db_keys, app.cache, app.decrypted_dir)
    total = 0
    if ctx and ctx.get("db_path"):
        for table in _iter_table_contexts(ctx):
            if not _is_safe_msg_table_name(table["table_name"]):
                continue
            try:
                with closing(sqlite3.connect(table["db_path"])) as conn:
                    row = conn.execute(
                        "SELECT COUNT(*) FROM [%s]" % table["table_name"]
                    ).fetchone()
                    total += int(row[0]) if row else 0
            except Exception:
                continue
    print(json.dumps({"count": total}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check")
    check.set_defaults(func=cmd_check)

    derive = sub.add_parser("derive")
    derive.add_argument("--passphrase", required=True)
    derive.set_defaults(func=cmd_derive)

    conversations = sub.add_parser("conversations")
    conversations.add_argument("--limit", type=int, default=50)
    conversations.add_argument("--query", default=None)
    conversations.set_defaults(func=cmd_conversations)

    messages = sub.add_parser("messages")
    messages.add_argument("--conversation", default=None)
    messages.add_argument("--since", type=int, default=None)
    messages.add_argument("--before", type=int, default=None)
    messages.add_argument("--limit", type=int, default=50)
    messages.add_argument("--include-boundary-ties", action="store_true")
    messages.set_defaults(func=cmd_messages)

    count = sub.add_parser("count")
    count.add_argument("--conversation", required=True)
    count.set_defaults(func=cmd_count)

    args = parser.parse_args()
    try:
        args.func(args)
    except Unavailable as e:
        fail(str(e))
    except Pending as e:
        print(str(e), file=sys.stderr)
        sys.exit(4)


if __name__ == "__main__":
    main()
