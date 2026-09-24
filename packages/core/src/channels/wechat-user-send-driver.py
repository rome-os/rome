#!/usr/bin/env python3
"""Sends one text from the guardian's own WeChat account by driving the desktop
client through its accessibility tree, for channels/wechat-user.ts.

    send --chat <wxid> --name <display name> --text <body>
    check

`send` prints one JSON object: {"ok": true, "conversationId", "messageId"} or
{"ok": false, "code", "typed", "reason"}. `typed` says whether any text reached
a chat input. `check` prints {"ready", "reason"} and does not touch the client.

Controls come from the client's Qt AT-SPI tree, found by role and accessible
name; text is set and read back through the input's editable-text interface.
The tree has no press action, so xdotool clicks the chosen result and presses
Return. Escape is never sent: on the main window it opens "Log out?" with OK
highlighted. Only the store confirms a send: a new self-sent line with the body
in the chat, answered with the reader's message id (`<wxid>:<local id>`).
"""
import argparse
import contextlib
import json
import os
import subprocess
import sys
import time

MAX_TEXT = 4000
ENVELOPE_MARKERS = ("<?xml", "<msg>", "<msg ")  # the reader cuts a line's text at these
ECHO_TIMEOUT_S = 30
HERE = os.path.dirname(os.path.abspath(__file__))
# Accessible names per interface language. Only English is verified live.
SEARCH = ("Search", "搜索")
BACK = ("Back", "返回")
CHATS = ("Chats", "聊天")
TITLE = ("Weixin", "微信")  # the main window's X title; the Chinese one is not seen live yet
FOCUSED, SHOWING, EDITABLE, ACTIVE = 12, 25, 7, 1
# Contact and feature results are 64 px rows; headers and suggestions 32 to 38 px.
RESULT_ROW_PX = 48


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
    def extents(self): return self._call("org.a11y.atspi.Component", "GetExtents", "u", (0,))[0]


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


def find(node, pred, showing=True, out=None):
    """Matching nodes; with `showing`, skips hidden subtrees (every page ever built)."""
    out = [] if out is None else out
    try:
        st = node.states()
        if showing and SHOWING not in st:
            return out
        if pred(node, st):
            out.append(node)
        for kid in node.children():
            find(kid, pred, showing, out)
    except LookupError:
        pass  # the node went away mid-walk
    return out


def has_chat_list(frame, showing=True):
    """The chat list, or in a narrow window the Back button leading to it."""
    return bool(find(frame, lambda n, st: (n.role == "list" and n.name in CHATS)
                     or (n.role == "push button" and n.name in BACK), showing))


def main_frame(app):
    frames = [f for f in app.children() if f.role == "frame" and has_chat_list(f, showing=False)]
    if len(frames) != 1:
        raise Failure("not-ready", f"expected one signed-in WeChat main window, found {len(frames)}")
    return frames[0]


def search_box(frame):
    boxes = find(frame, lambda n, st: n.role == "text" and n.name in SEARCH and EDITABLE in st)
    return boxes[0] if boxes else None


def chat_inputs(frame):
    return find(frame, lambda n, st: n.role == "text" and EDITABLE in st and n.name not in SEARCH)


class Desktop:
    """Which window is in front, and the only two input events: click and Return."""

    def _run(self, *args):
        return subprocess.run(args, capture_output=True, text=True, timeout=15)

    def window(self):
        tree = self._run("xwininfo", "-root", "-tree").stdout
        ids = [l.split()[0] for l in tree.splitlines()
               if any(f'"{t}": ("wechat" "wechat")' in l for t in TITLE)]
        return ids[0] if len(ids) == 1 else None

    def viewable(self):
        win = self.window()
        return bool(win) and "IsViewable" in self._run("xwininfo", "-id", win).stdout

    def x_active(self):
        out = self._run("xprop", "-root", "_NET_ACTIVE_WINDOW").stdout.split()
        win = self.window()
        return bool(win and out) and int(out[-1], 16) == int(win, 16)

    def raise_window(self):
        win = self.window()
        if win:
            self._run("xdotool", "windowactivate", "--sync", win)

    def click(self, x, y):
        self._run("xdotool", "mousemove", str(x), str(y), "click", "1")

    def press_return(self):
        self._run("xdotool", "key", "--clearmodifiers", "Return")


class Store:
    """Reads through the reader helper, in the reader's own environment."""

    def __init__(self):
        venv = os.path.join(os.path.expanduser("~"), ".local/share/wechat/cli/bin/python3")
        self.python = os.environ.get("WECHAT_READER_PYTHON", venv)
        self.helper = os.path.join(HERE, "wechat-user-helper.py")

    def lines(self, *args):
        r = subprocess.run([self.python, self.helper, "messages", *args],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise Failure("not-ready", f"the store could not be read: {r.stderr.strip()[:300]}")
        return json.loads(r.stdout)["messages"]

    def chat(self, chat_id): return self.lines("--conversation", chat_id, "--limit", "200")
    def recent(self, since): return self.lines("--since", str(since), "--limit", "500")


def is_echo(m, body):
    return m.get("isSelf") and m.get("type") == "text" and m.get("text") == body.strip()


class Driver:
    def __init__(self, app, desktop, store, clock=time):
        self.app, self.desk, self.store, self.clock = app, desktop, store, clock
        self.frame = main_frame(app)
        self.typed, self.returned, self.box = False, False, None

    def active(self):
        # AT-SPI reports the frame active for a few hundred ms after X focus
        # has moved to another window, so both must agree.
        return ACTIVE in self.frame.states() and self.desk.x_active()

    def bring_forward(self):
        for _ in range(3):
            self.desk.raise_window()
            for _ in range(10):
                if self.active():
                    return
                self.clock.sleep(0.1)
        raise Failure("focus-lost", "WeChat would not come to the front")

    def click(self, node, what):
        x, y, w, h = node.extents()
        if w <= 0 or h <= 0 or not self.active():
            raise Failure("focus-lost", f"WeChat lost the front before clicking {what}", self.typed)
        self.desk.click(x + w // 2, y + h // 2)
        self.clock.sleep(0.8)

    def open_search(self):
        box = search_box(self.frame)
        if box is None:
            # A narrow window shows one pane: the open chat and a Back button.
            back = find(self.frame, lambda n, st: n.role == "push button" and n.name in BACK)
            if not back:
                raise Failure("not-ready", "the search box is not showing")
            self.click(back[0], "Back")
            box = search_box(self.frame)
            if box is None:
                raise Failure("not-ready", "the search box is not showing, even after Back")
        return box

    def focus(self, box):
        for _ in range(3):
            box.grab_focus()
            self.clock.sleep(0.15)
            if FOCUSED in box.states():
                return
            self.bring_forward()
        raise Failure("focus-lost", "the search box would not take keyboard focus")

    def results(self):
        # The search popup is an unnamed filler top-level (prototype round 2). WeChat's
        # windows, the main one and a chat opened on its own alike, are frames.
        return [(n, n.name, tuple(n.extents())) for top in self.app.children() if top.role != "frame"
                for n in find(top, lambda n, st: n.role == "list item")]

    def result(self, box, name):
        """The one local result named exactly `name`. The list opens only while the
        box has focus, shows recent searches before it fills in, and always lists a
        web suggestion named after the query: read it once settled, local rows only."""
        for _ in range(3):
            self.focus(box)
            box.set_text(name)
            seen, stable, deadline = None, 0, self.clock.time() + 6
            while self.clock.time() < deadline and FOCUSED in box.states():
                self.clock.sleep(0.3)
                items = self.results()
                stable = stable + 1 if items and [i[1:] for i in items] == seen else 0
                seen = [i[1:] for i in items]
                if stable < 2:
                    continue
                hits = [n for n, text, ext in items if text == name and ext[3] >= RESULT_ROW_PX]
                if len(hits) != 1:
                    box.set_text("")
                    raise Failure("ambiguous" if hits else "not-found",
                                  f"{len(hits)} local search results are named {name!r}")
                return hits[0]
            if FOCUSED in box.states():
                box.set_text("")
                raise Failure("not-found", f"the search results for {name!r} never settled")
            self.bring_forward()
        box.set_text("")
        raise Failure("focus-lost", "the search lost focus before its results appeared")

    def open_chat(self, box, name):
        self.click(self.result(box, name), "the search result")
        # A chat result closes the list and keeps WeChat in front. Anything else, like a
        # web search window, fails here even when the target chat was already open.
        if not self.active() or self.results():
            raise Failure("wrong-chat", "the click did not open a chat in WeChat's main window")

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
        return box

    def press(self, name, body):
        box = self.target_input(name)
        box.grab_focus()
        self.clock.sleep(0.2)
        if box.text() != body or FOCUSED not in box.states() or not self.active():
            box.set_text("")
            raise Failure("focus-lost", "WeChat lost the front before Return; the input was cleared", True)
        self.returned = True  # from here the text may have gone out
        self.desk.press_return()
        self.clock.sleep(1)
        if box.text():
            box.set_text("")
            raise Failure("no-echo", "Return did not send; the input was cleared", True)

    def send(self, chat_id, name, body, press_return=True):
        try:
            return self._send(chat_id, name, body, press_return)
        except Exception as e:  # noqa: BLE001 — any failure is a coded Failure with `typed`
            # The target's input was empty before typing, so what it holds is ours. Another
            # chat's input is never touched. Best effort: the answer below still says typed.
            with contextlib.suppress(Exception):
                if self.box and not self.returned and self.box.name == name and self.box.text():
                    self.box.set_text("")
            if isinstance(e, Failure):
                e.typed = e.typed or self.typed
                raise
            code, tail = ("no-echo", " after Return; check WeChat") if self.returned else ("not-ready", "")
            raise Failure(code, f"{type(e).__name__}: {e}{tail}", self.typed) from e

    def _send(self, chat_id, name, body, press_return):
        before = {m["id"] for m in self.store.chat(chat_id) if is_echo(m, body)}
        started = int(self.clock.time()) - 1
        elsewhere_before = {m["id"] for m in self.store.recent(started - 60)}
        self.bring_forward()
        self.open_chat(self.open_search(), name)
        box = self.type_body(name, body)
        if not press_return:  # dry run, for live checks: every step but Return
            box.set_text("")
            return None
        self.press(name, body)
        deadline = self.clock.time() + ECHO_TIMEOUT_S
        while True:
            try:
                fresh = [m for m in self.store.chat(chat_id) if is_echo(m, body) and m["id"] not in before]
                stray = [m for m in self.store.recent(started) if is_echo(m, body)
                         and m["conversationId"] != chat_id and m["id"] not in elsewhere_before]
            except Exception:  # noqa: BLE001 — a read that fails after Return is no echo yet
                fresh, stray = [], []
            if stray:
                raise Failure("misdelivered", f"the text landed in {stray[0]['conversationId']}", True)
            if fresh:
                return fresh[-1]["id"]
            if self.clock.time() > deadline:
                raise Failure("no-echo", f"no copy in the store after {ECHO_TIMEOUT_S} s; check WeChat", True)
            self.clock.sleep(1.5)


def readiness(app, desktop):
    """Reads only the tree and the window. Nothing is raised, focused or typed."""
    frame = main_frame(app)
    if desktop.window() is None:
        raise Failure("not-ready", "the WeChat main window is not on the display")
    # A minimized window shows nothing, so only a window on screen must show its list.
    if desktop.viewable() and not has_chat_list(frame):
        raise Failure("not-ready", "the client shows no chat list: signed out, locked, or loading")


def ready_client():
    if subprocess.run(["pgrep", "-x", "wechat"], capture_output=True).returncode != 0:
        raise Failure("not-ready", "the WeChat client is not running")
    app, desktop = wechat_app(), Desktop()
    readiness(app, desktop)
    return app, desktop


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    send = sub.add_parser("send")
    for flag in ("--chat", "--name", "--text"):
        send.add_argument(flag, required=True)
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
        message_id = Driver(app, desktop, Store()).send(args.chat, args.name, args.text)
        print(json.dumps({"ok": True, "conversationId": args.chat, "messageId": message_id}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001 — every answer is one JSON object; Driver.send sets typed
        e = e if isinstance(e, Failure) else Failure("not-ready", f"{type(e).__name__}: {e}")
        answer = {"ready": False} if args.command == "check" else {"ok": False, "code": e.code, "typed": e.typed}
        print(json.dumps({**answer, "reason": e.reason}, ensure_ascii=False))


if __name__ == "__main__":
    main()
