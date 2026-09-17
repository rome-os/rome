"""Exercise reader boundaries with real SQLite rows and a simulated debugger."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load("helper", HERE / "wechat-user-helper.py")
sys.path.insert(0, str(HERE / "vendor"))
driver = load("driver", HERE / "wechat-user-launch-driver.py")


class ReaderTests(unittest.TestCase):
    def test_same_second_window_can_walk_all_rows(self):
        with sqlite3.connect(":memory:") as conn:
            conn.execute("CREATE TABLE messages (id INTEGER, kind INTEGER, ts INTEGER)")
            conn.executemany("INSERT INTO messages VALUES (?, 1, ?)",
                             [(i, 100) for i in range(650)] + [(650, 99)])

            def query(conn, table, start_ts, end_ts, limit, offset):
                return conn.execute(
                    "SELECT * FROM messages WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ? OFFSET ?",
                    (start_ts or 0, end_ts if end_ts is not None else 999, limit, offset),
                ).fetchall()

            first = helper.query_message_window(query, conn, "messages", None, None, 4)
            self.assertEqual(len(first), 650)
            second = helper.query_message_window(query, conn, "messages", None, 100, 4)
            self.assertEqual(len(second), 651)
            self.assertEqual(len({row[0] for row in second}), 651)
            older = helper.query_message_window(query, conn, "messages", None, 99, 4)
            self.assertEqual([row[0] for row in older], [650])

    def test_undecodable_body_keeps_a_counted_row(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / "messages.db")
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TABLE Msg_test (id INTEGER)")
                conn.execute("INSERT INTO Msg_test VALUES (1)")
            table = dict(db_path=db, table_name="Msg_test", username="friend",
                         display_name="Friend", is_group=False)
            messages = types.ModuleType("wechat_cli.core.messages")
            messages.resolve_chat_context = lambda *args: table
            messages._iter_table_contexts = lambda ctx: [ctx]
            messages._load_name2id_maps = lambda conn: {1: "friend"}
            messages._query_messages = lambda *a, **kw: [(1, 1, 100, 1, b"bad", 4)]
            messages._format_message_text = lambda *a, **kw: ("", a[2])
            messages._resolve_sender_label = lambda *a: "Friend"
            messages.decompress_content = lambda *a: None
            messages._split_msg_type = lambda kind: (kind, 0)
            messages._is_safe_msg_table_name = lambda name: True
            app = types.SimpleNamespace(msg_db_keys=[], cache=None, decrypted_dir=directory,
                                        display_name_fn=None, db_dir=directory)
            with patch.dict(sys.modules, {"wechat_cli.core.messages": messages}), patch.object(helper, "app_context", return_value=app):
                rows = helper.chat_messages(app, "friend", {}, "self", None, None, 1)
                self.assertEqual(rows[0]["text"], "[Unreadable message]")
                with patch.object(messages, "decompress_content", side_effect=ValueError("corrupt")):
                    rows = helper.chat_messages(app, "friend", {}, "self", None, None, 1)
                    self.assertEqual(rows[0]["text"], "[Unreadable message]")
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    helper.cmd_count(types.SimpleNamespace(conversation="friend"))
                self.assertIn('"count": 1', output.getvalue())


class CaptureTests(unittest.TestCase):
    def test_artifacts_are_private_and_removed_on_success_failure_and_signal(self):
        for outcome in ("success", "failure", "signal"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                staged = Path(directory) / "launch.py"
                staged.touch()
                previous_mask = os.umask(0o022)
                handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
                def capture(path):
                    self.assertEqual(os.stat(path).st_mode & 0o777, 0o700)
                    artifact = Path(path) / "result"
                    artifact.write_text("secret")
                    self.assertEqual(artifact.stat().st_mode & 0o777, 0o600)
                    if outcome == "failure":
                        raise RuntimeError("capture failed")
                    if outcome == "signal":
                        signal.raise_signal(signal.SIGTERM)
                try:
                    with patch.object(driver, "__file__", str(staged)), patch.object(driver, "capture", side_effect=capture):
                        if outcome == "success":
                            driver.main()
                        else:
                            with self.assertRaises((RuntimeError, SystemExit)):
                                driver.main()
                    self.assertEqual(list(Path(directory).iterdir()), [staged])
                finally:
                    os.umask(previous_mask)
                    for sig, handler in handlers.items():
                        signal.signal(sig, handler)


if __name__ == "__main__":
    unittest.main()
