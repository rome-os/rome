#!/usr/bin/env python3
"""Sends one text from the guardian's own WeChat account by driving the desktop
client through its accessibility tree, for channels/wechat-user.ts.

    send [--dry-run] --chat <wxid> --name <display name> --text <body>
    check

`send` prints one JSON object: {"ok": true, "conversationId", "messageId"} or
{"ok": false, "code", "typed", "reason"}. `typed` says whether any text reached
a chat input. `ambiguous` means the name does not lead to exactly one chat: a
second result has that name, or the settled results put the target below
another one or in a section that holds no chat. `not-ready` covers a client or
store that is not ready and results that never settled, which may pass.
`--dry-run` does every step but the Return in the chat input, then clears the
input, and answers {"ok": true, "dryRun": true, "conversationId"}.
`check` prints {"ready", "reason"} and does not touch the client. It is not
ready unless the interface is English, the only language verified live.
Every error after argument parsing is such a JSON answer with exit 0; argparse's
own errors (a missing flag, an unknown command) exit 2.

Controls come from the client's Qt AT-SPI tree, by role and accessible name;
text is set and read back through editable text. The chat opens by keyboard:
Down then Up makes the tree mark the current search result `focused`, and Return
opens it only when that is the one local result named after the chat. xdotool,
on DISPLAY, presses only Down, Up and Return (Escape would open "Log out?"),
each only while AT-SPI and X agree WeChat is in front. Only the store confirms
a send, answered with the reader's message id (`<wxid>:<local id>`).
"""
import argparse
import contextlib
import json
import os
import re
import subprocess
import time

MAX_TEXT = 4000
ENVELOPE_MARKERS = ("<?xml", "<msg>", "<msg ")  # the reader cuts a line's text at these
ECHO_TIMEOUT_S = 30
PRESEND_TIMEOUT_S = 20  # all store reads before the client is touched
HERE = os.path.dirname(os.path.abspath(__file__))
# Accessible names per interface language. Only English is verified live.
SEARCH = ("Search", "搜索")
CHATS = ("Chats", "聊天")
TITLE = ("Weixin", "微信")  # the main window's X title; the Chinese one is not seen live yet
# Search sections that hold no chat of the account's own (English only, verified live).
NONLOCAL_HEADERS = ("Internet search results", "More")
KEYS = ("Down", "Up", "Return")  # every key this driver can press
FOCUSED, SHOWING, EDITABLE, ACTIVE = 12, 25, 7, 1


class Failure(Exception):
    def __init__(self, code, reason, typed=False):
        super().__init__(reason)
        self.code, self.reason, self.typed = code, reason, typed


class Node:
    """One AT-SPI object, read over D-Bus with jeepney."""
    ACC = "org.a11y.atspi.Accessible"

    def __init__(self, conn, ref):
        self.conn, self.ref = conn, tuple(ref)

    def __eq__(self, other):
        return isinstance(other, Node) and self.ref == other.ref

    def _call(self, iface, member, sig=None, body=()):
        from jeepney import DBusAddress, new_method_call
        msg = new_method_call(DBusAddress(self.ref[1], self.ref[0], iface), member, sig, body)
        reply = self.conn.send_and_get_reply(msg, timeout=5)
        if reply.header.message_type.name == "error":
            raise LookupError(f"{iface}.{member}: {reply.body}")
        return reply.body

    def _prop(self, iface, name):
        return self._call("org.freedesktop.DBus.Properties", "Get", "ss", (iface, name))[0][1]

    @property
    def name(self): return self._prop(self.ACC, "Name")
    @property
    def role(self): return self._call(self.ACC, "GetRoleName")[0]
    def children(self): return [Node(self.conn, c) for c in self._call(self.ACC, "GetChildren")[0]]

    def states(self):
        bits = self._call(self.ACC, "GetState")[0]
        return {i for i in range(64) if bits[i // 32] >> (i % 32) & 1}

    def text(self):
        n = self._prop("org.a11y.atspi.Text", "CharacterCount")
        return self._call("org.a11y.atspi.Text", "GetText", "ii", (0, n))[0]

    def set_text(self, s): self._call("org.a11y.atspi.EditableText", "SetTextContents", "s", (s,))
    def grab_focus(self): self._call("org.a11y.atspi.Component", "GrabFocus")


def wechat_app():
    try:
        from jeepney import DBusAddress, new_method_call
        from jeepney.io.blocking import open_dbus_connection
        session = open_dbus_connection(bus="SESSION")
        reply = session.send_and_get_reply(new_method_call(
            DBusAddress("/org/a11y/bus", "org.a11y.Bus", "org.a11y.Bus"), "GetAddress"), timeout=5)
        conn = open_dbus_connection(reply.body[0])
        root = Node(conn, ("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root"))
        apps = [a for a in root.children() if a.name == "wechat"]
    except Exception as e:  # noqa: BLE001 — any bus failure means no tree
        raise Failure("not-ready", f"the accessibility tree is not available: {e}")
    if not apps:
        raise Failure("not-ready", "the WeChat client is not on the accessibility bus")
    return apps[0]


def find(node, pred, out=None):
    """Matching showing nodes; hidden subtrees (every page ever built) are skipped."""
    out = [] if out is None else out
    try:
        st = node.states()
        if SHOWING not in st:
            return out
        if pred(node, st):
            out.append(node)
        for kid in node.children():
            find(kid, pred, out)
    except LookupError:
        pass  # the node went away mid-walk
    return out


def search_box(frame):
    boxes = find(frame, lambda n, st: n.role == "text" and n.name in SEARCH and EDITABLE in st)
    return boxes[0] if boxes else None


def main_frame(app):
    """The frame showing a chat list or search box. Login and lock views show
    neither; a minimized window still reports its nodes as showing."""
    frames = [f for f in app.children() if f.role == "frame" and find(
        f, lambda n, st: (n.role == "list" and n.name in CHATS)
        or (n.role == "text" and n.name in SEARCH and EDITABLE in st))]
    if len(frames) != 1:
        raise Failure("not-ready", f"expected one signed-in WeChat main window, found {len(frames)}")
    return frames[0]


def chat_inputs(frame):
    return find(frame, lambda n, st: n.role == "text" and EDITABLE in st and n.name not in SEARCH)


class Desktop:
    """The X side on DISPLAY: the front window, one activate request, and KEYS."""

    def _run(self, *args):
        return subprocess.run(args, capture_output=True, text=True, timeout=15)

    def window(self):
        tree = self._run("xwininfo", "-root", "-tree").stdout
        ids = [l.split()[0] for l in tree.splitlines()
               if any(f'"{t}": ("wechat" "wechat")' in l for t in TITLE)]
        return ids[0] if len(ids) == 1 else None

    def x_active(self):
        # With no active window (no EWMH manager, or one restarting) xprop prints
        # "not found."; that is simply not active.
        found = re.search(r"0x[0-9a-fA-F]+", self._run("xprop", "-root", "_NET_ACTIVE_WINDOW").stdout)
        win = self.window()
        return bool(win and found) and int(found.group(0), 16) == int(win, 16)

    def activate(self):
        win = self.window()
        if win:
            self._run("xdotool", "windowactivate", "--sync", win)

    def key(self, name):
        if name not in KEYS:
            raise ValueError(f"{name!r} is not a key this driver presses")
        self._run("xdotool", "key", "--clearmodifiers", name)


class Store:
    """Reads through the reader helper, in the reader's own environment."""

    def __init__(self):
        venv = os.path.join(os.path.expanduser("~"), ".local/share/wechat/cli/bin/python3")
        self.python = os.environ.get("WECHAT_READER_PYTHON", venv)
        self.helper = os.path.join(HERE, "wechat-user-helper.py")

    def lines(self, *args, timeout):
        r = subprocess.run([self.python, self.helper, "messages", *args],
                           capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            raise Failure("not-ready", f"the store could not be read: {r.stderr.strip()[:300]}")
        return json.loads(r.stdout)["messages"]

    def chat(self, chat_id, timeout): return self.lines("--conversation", chat_id, "--limit", "200", timeout=timeout)
    def recent(self, since, timeout): return self.lines("--since", str(since), "--limit", "500", timeout=timeout)


def is_echo(m, body):
    return m.get("isSelf") and m.get("type") == "text" and m.get("text") == body.strip()


class Driver:
    def __init__(self, app, desktop, store, clock=time):
        self.app, self.desk, self.store, self.clock = app, desktop, store, clock
        self.frame = main_frame(app)
        self.typed, self.returned, self.box, self.dry_run = False, False, None, False

    def active(self):
        return ACTIVE in self.frame.states() and self.desk.x_active()

    def bring_forward(self):
        """One activate request is the only raise (a minimize or stray client)."""
        if self.active():
            return
        self.desk.activate()
        for _ in range(20):
            if self.active():
                return
            self.clock.sleep(0.1)
        raise Failure("focus-lost", "WeChat is not in front, even after an activate request")

    def guard(self, name, focused):
        if FOCUSED not in focused.states() or not self.active():
            raise Failure("focus-lost", f"WeChat lost the front before {name}", self.typed)

    def key(self, name, focused):
        self.guard(name, focused)
        self.desk.key(name)

    def read_rows(self):
        """The search popup's rows as (index, node, name, states); WeChat's own
        windows are frames, the popup is not. Raises LookupError for a vanished row."""
        lists = [n for top in self.app.children() if top.role != "frame"
                 for n in find(top, lambda n, st: n.role == "list")]
        return [(i, k, k.name, k.states()) for i, k in enumerate(lists[0].children())] if lists else []

    def rows(self):
        """The rows, or none when a row vanished mid-read: the caller reads again."""
        try:
            return self.read_rows()
        except LookupError:
            return []

    def popup_open(self):
        """Whether results still show. A read that fails counts as open (fail closed)."""
        try:
            return bool(self.read_rows())
        except LookupError:
            return True

    @staticmethod
    def are_results(rows, name):
        """The real results, not the recent-searches panel shown first, which can
        list the target's own name from an earlier search: only the results carry
        the web suggestion named after the query, right under "Internet search results"."""
        return any(r[2] == NONLOCAL_HEADERS[0] and r[0] + 1 < len(rows) and rows[r[0] + 1][2] == name
                   for r in rows)

    @staticmethod
    def local_hits(rows, name):
        """Rows named `name` that may be a chat, in any section. Only the web
        suggestion, the row right under "Internet search results", is left out.
        Fail-closed: a same-named row anywhere else counts, so it makes the
        choice `ambiguous` rather than opening the wrong chat."""
        web = {r[0] + 1 for r in rows if r[2] == NONLOCAL_HEADERS[0]}
        return [r for r in rows if r[2] == name and r[0] not in web]

    def settle(self, box, name):
        """The real results (not the recent searches shown first) once they have
        stopped changing: at once when they hold a local row named after the query,
        else at the deadline, since local sections can load after the web one.
        Returns (rows or None when they never settled, whether a results panel showed)."""
        seen, stable, steady, panel, deadline = None, 0, None, False, self.clock.time() + 6
        while self.clock.time() < deadline and FOCUSED in box.states():
            self.clock.sleep(0.3)
            rows = self.rows()
            names = [r[2] for r in rows]
            panel = panel or self.are_results(rows, name)
            stable = stable + 1 if self.are_results(rows, name) and names == seen else 0
            seen = names
            steady = rows if stable >= 2 else None
            if steady and self.local_hits(rows, name):
                return rows, True
        return steady, panel

    def choose(self, box, name):
        """Leave current the one local result named `name`: index 1, under a first
        header that is not a web or "More" section."""
        rows, panel = self.settle(box, name)
        if rows is None:
            if FOCUSED not in box.states():
                raise Failure("focus-lost", "the search lost focus before its results settled")
            if not panel:
                raise Failure("not-ready", f"no search results panel appeared for {name!r}: WeChat shows "
                              '"Internet search results" only when online and in English, the one '
                              "interface language verified live")
            raise Failure("not-ready", f"the search results for {name!r} kept changing and never settled")
        if not self.local_hits(rows, name):  # settled, and truly absent
            raise Failure("not-found", f"no search result is named {name!r}")
        if len(self.local_hits(rows, name)) > 1:
            raise Failure("ambiguous", f"more than one search result is named {name!r}")
        self.key("Down", box)
        self.key("Up", box)
        rows = self.rows()
        if not self.are_results(rows, name):  # the list changed under the keys
            raise Failure("not-ready", f"the search results for {name!r} changed before Return")
        if len(self.local_hits(rows, name)) > 1:  # a section that loaded during the keys
            raise Failure("ambiguous", f"more than one search result is named {name!r}")
        current = [r for r in rows if FOCUSED in r[3]]
        header = rows[0][2] if rows else None
        if len(current) != 1:
            raise Failure("not-ready", f"the search results for {name!r} did not mark one current result")
        if current[0][0] != 1 or current[0][2] != name or header in NONLOCAL_HEADERS:
            # Settled results that put the target below another one, or in a section that
            # holds no chat, stay that way: the name does not lead to this one chat.
            raise Failure("ambiguous", f"the result named {name!r} is not the first local one (top: "
                          f"{current[0][2]!r} under {header!r})")

    def open_chat(self, name):
        self.bring_forward()
        box = search_box(self.frame)
        if box is None:
            raise Failure("not-ready", "the search box is not showing")
        for _ in range(2):
            box.grab_focus()
            self.clock.sleep(0.15)
            if FOCUSED in box.states():
                break
            self.bring_forward()
        box.set_text(name)
        try:
            self.choose(box, name)
            self.key("Return", box)
        except Exception:  # noqa: BLE001 — any failure before Return leaves no query behind
            with contextlib.suppress(Exception):
                box.set_text("")
            raise
        self.clock.sleep(0.8)
        # A chat result closes the list and keeps WeChat in front. Anything else, like a
        # web search window, fails here even when the target chat was already open.
        if not self.active() or self.popup_open():
            raise Failure("wrong-chat", "Return did not open a chat in WeChat's main window")

    def target_input(self, name):
        inputs, deadline = [], self.clock.time() + 4
        while self.clock.time() < deadline:
            inputs = chat_inputs(self.frame)
            if len(inputs) == 1 and inputs[0].name == name:
                return inputs[0]
            self.clock.sleep(0.3)
        raise Failure("wrong-chat", f"the open chat is {[i.name for i in inputs]}, not {name!r}", self.typed)

    def type_body(self, name, body):
        box = self.target_input(name)
        if box.text():
            raise Failure("not-ready", f"the {name!r} input already holds a draft")
        self.box, self.typed = box, True  # before set_text: a set_text that raises may have typed
        box.set_text(body)
        if box.text() != body:
            raise Failure("not-ready", "the input did not take the text exactly", True)

    def press(self, name, body):
        if self.dry_run:
            raise AssertionError("a dry run never presses Return in a chat input")
        box = self.target_input(name)
        box.grab_focus()
        self.clock.sleep(0.2)
        if box.text() != body:
            raise Failure("not-ready", "the input changed before Return", True)
        self.guard("Return", box)
        self.returned = True  # from here the text may have gone out
        self.desk.key("Return")
        # No verdict from the input here: a slow client can still be sending. Only the
        # store decides, over the whole echo budget (`_send`).

    def clear_leftover(self, name, body):
        """After Return, a copy of the body still in the target's input, read name
        last, is cleared, so the guardian cannot send it again by accident. With
        Ctrl+Enter to send, Return only adds a line break to it."""
        with contextlib.suppress(Exception):
            if self.box and self.box.text() in (body, body + "\n") and self.box.name == name:
                self.box.set_text("")

    def send(self, chat_id, name, body, press_return=True):
        self.dry_run = not press_return
        try:
            return self._send(chat_id, name, body, press_return)
        except Exception as e:  # noqa: BLE001 — any failure is a coded Failure with `typed`
            # The target's input was empty before typing, so what it holds is ours; the name
            # is read last, so only a chat switch in that one round trip could race it.
            with contextlib.suppress(Exception):
                if self.box and not self.returned and self.box.text() and self.box.name == name:
                    self.box.set_text("")
            if isinstance(e, Failure):
                e.typed = e.typed or self.typed
                raise
            code, tail = ("no-echo", " after Return; check WeChat") if self.returned else ("not-ready", "")
            raise Failure(code, f"{type(e).__name__}: {e}{tail}", self.typed) from e

    def _send(self, chat_id, name, body, press_return):
        presend = self.clock.time() + PRESEND_TIMEOUT_S
        left = lambda end: max(1, end - self.clock.time())  # noqa: E731
        history = self.store.chat(chat_id, timeout=left(presend))
        # The store names the chat the way the client shows it. A chat with no lines yet (a
        # first message) has no name to check: the caller makes sure the name is unique.
        names = {m.get("conversationName") for m in history} - {None, ""}
        if names and name not in names:
            raise Failure("not-found", f"the store names {chat_id!r} {sorted(names)!r}, not {name!r}")
        before = {m["id"] for m in history if is_echo(m, body)}
        # Lines from the last minute, by id: the scan after Return uses the same bound,
        # so a host clock up to 60 s ahead of WeChat's timestamps cannot hide a
        # misdelivered copy. A larger skew can; NTP keeps both far inside it.
        since = int(self.clock.time()) - 60
        elsewhere_before = {m["id"] for m in self.store.recent(since, timeout=left(presend))}
        for attempt in range(3):  # a focus loss before typing starts over
            try:
                self.open_chat(name)
                break
            except Failure as e:
                if e.code != "focus-lost" or attempt == 2:
                    raise
        self.type_body(name, body)
        if self.dry_run:  # every step but the Return in the chat input
            self.box.set_text("")
            if self.box.text():
                raise Failure("not-ready", "the dry run could not clear the input", True)
            return None
        self.press(name, body)
        deadline = self.clock.time() + ECHO_TIMEOUT_S
        # A copy in another chat is only a misdelivery if the target's echo never comes:
        # the same text sent there from the phone can land before our echo does.
        elsewhere = None
        while True:
            fresh, stray = [], []
            try:  # each read gets only what is left of the budget
                fresh = [m for m in self.store.chat(chat_id, timeout=left(deadline))
                         if is_echo(m, body) and m["id"] not in before]
                # One Return makes one line: with an echo in the target, a copy elsewhere
                # (the same text sent there from the phone) is not ours.
                if not fresh:
                    stray = [m for m in self.store.recent(since, timeout=left(deadline)) if is_echo(m, body)
                             and m["conversationId"] != chat_id and m["id"] not in elsewhere_before]
            except Exception:  # noqa: BLE001 — a read that fails after Return is no echo yet
                pass
            if fresh:
                self.clear_leftover(name, body)
                return fresh[-1]["id"]
            elsewhere = elsewhere or (stray[0]["conversationId"] if stray else None)
            if self.clock.time() > deadline:
                self.clear_leftover(name, body)
                if elsewhere:
                    raise Failure("misdelivered", f"the text landed in {elsewhere}, not the target", True)
                raise Failure("no-echo", f"no copy in the store after {ECHO_TIMEOUT_S} s; check WeChat", True)
            self.clock.sleep(1.5)


def ready_client():
    """Reads only the process list, the tree and the window list."""
    if subprocess.run(["pgrep", "-x", "wechat"], capture_output=True).returncode != 0:
        raise Failure("not-ready", "the WeChat client is not running")
    app, desktop = wechat_app(), Desktop()
    if not find(main_frame(app), lambda n, st: (n.role == "list" and n.name == CHATS[0])
                or (n.role == "text" and n.name == SEARCH[0] and EDITABLE in st)):
        raise Failure("not-ready", "WeChat's interface language is not English, the only one this "
                      "driver is verified on: set the client's language to English")
    if desktop.window() is None:
        raise Failure("not-ready", "the WeChat main window is not on the display")
    return app, desktop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    send = sub.add_parser("send")
    for flag in ("--chat", "--name", "--text"):
        send.add_argument(flag, required=True)
    send.add_argument("--dry-run", action="store_true", help="every step but the Return that sends")
    sub.add_parser("check")
    args = parser.parse_args()

    try:
        if args.command == "check":
            ready_client()
            return print(json.dumps({"ready": True, "reason": "ready"}))
        # The store cuts a line at an envelope marker, so such a body's echo could never match.
        if (not args.chat.strip() or not args.name.strip() or not args.text.strip()
                or len(args.text) > MAX_TEXT or any(m in args.text for m in ENVELOPE_MARKERS)):
            raise Failure("invalid", "--chat and --name must be set; "
                          f"--text 1 to {MAX_TEXT} characters, no {ENVELOPE_MARKERS}")
        app, desktop = ready_client()
        message_id = Driver(app, desktop, Store()).send(args.chat, args.name, args.text, not args.dry_run)
        done = {"dryRun": True} if args.dry_run else {"messageId": message_id}
        print(json.dumps({"ok": True, **done, "conversationId": args.chat}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001 — every answer is one JSON object; Driver.send sets typed
        e = e if isinstance(e, Failure) else Failure("not-ready", f"{type(e).__name__}: {e}")
        answer = {"ready": False} if args.command == "check" else {"ok": False, "code": e.code, "typed": e.typed}
        print(json.dumps({**answer, "reason": e.reason}, ensure_ascii=False))


if __name__ == "__main__":
    main()
