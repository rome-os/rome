#!/usr/bin/env python3
"""PROTOTYPE, never merge. Round 3 of rome-work personal-wechat-replies
(prototype-brief.md @ ed2b839): can the send rely on accessibility alone?

    python3 wechat-user-send-a11y-only-prototype.py survey --contact <name>
    python3 wechat-user-send-a11y-only-prototype.py lag [--trials N]
    python3 wechat-user-send-a11y-only-prototype.py keys-follow-focus   # scratch display, not the client

Reuses the #505 driver (`wechat-user-send-driver.py`) for tree access. Keys go
through the AT-SPI registry's DeviceEventController.GenerateKeyboardEvent, not
xdotool. xdotool is used only by `lag` to create the focus steal it measures.

Environment: DISPLAY=:99, DBUS_SESSION_BUS_ADDRESS=<client's session bus>,
PYTHONPATH with jeepney, and the accessibility bus from a11y_bus.py running.
"""
import argparse
import importlib.util
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("driver", os.path.join(HERE, "wechat-user-send-driver.py"))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

STATES = ["invalid", "active", "armed", "busy", "checked", "collapsed", "defunct", "editable", "enabled",
          "expandable", "expanded", "focusable", "focused", "has-tooltip", "horizontal", "iconified", "modal",
          "multi-line", "multiselectable", "opaque", "pressed", "resizable", "selectable", "selected",
          "sensitive", "showing", "single-line", "stale", "transient", "vertical", "visible",
          "manages-descendants", "indeterminate", "required", "truncated", "animated", "invalid-entry",
          "supports-autocompletion", "selectable-text", "is-default", "visited", "checkable", "has-popup",
          "read-only"]
KEY_SYM = 3  # AtspiKeySynthType: the keycode argument is a keysym
XK = {"Down": 0xFF54, "Up": 0xFF52, "Return": 0xFF0D}
XDO = "/tmp/xdo/root/usr/bin/xdotool"
XENV = {**os.environ, "LD_LIBRARY_PATH": "/tmp/xdo/root/usr/lib/x86_64-linux-gnu"}
T0 = time.time()


def trace(event, **fields):
    print(json.dumps({"t": round(time.time() - T0, 3), "event": event, **fields}, ensure_ascii=False), flush=True)


def call(node, iface, member, sig=None, body=()):
    return node._call(iface, member, sig, body)


def state_names(node):
    return [STATES[i] if i < len(STATES) else str(i) for i in sorted(node.states())]


def describe(node, parent=None):
    ifaces = call(node, d.Node.ACC, "GetInterfaces")[0]
    out = {"role": node.role, "name": node.name, "states": state_names(node),
           "interfaces": [i.replace("org.a11y.atspi.", "") for i in ifaces if i != d.Node.ACC],
           "index": call(node, d.Node.ACC, "GetIndexInParent")[0],
           "attributes": call(node, d.Node.ACC, "GetAttributes")[0],
           "description": node._prop(d.Node.ACC, "Description")}
    if "org.a11y.atspi.Action" in ifaces:
        out["actions"] = [a[0] for a in call(node, "org.a11y.atspi.Action", "GetActions")[0]]
    if "org.a11y.atspi.Selection" in ifaces:
        out["nSelected"] = node._prop("org.a11y.atspi.Selection", "NSelectedChildren")
    if parent is not None:
        out["parent"] = f"{parent.role}[{parent.name}]"
    out["extents_for_reference"] = list(node.extents())
    return out


def registry(conn):
    from jeepney import DBusAddress
    return DBusAddress("/org/a11y/atspi/registry/deviceeventcontroller", "org.a11y.atspi.Registry",
                       "org.a11y.atspi.DeviceEventController")


def press(app, key):
    """One key through the AT-SPI registry. It lands wherever X focus is."""
    from jeepney import new_method_call
    conn = app.conn
    reply = conn.send_and_get_reply(new_method_call(registry(conn), "GenerateKeyboardEvent", "isu",
                                                    (XK[key], "", KEY_SYM)), timeout=5)
    return reply.header.message_type.name


KEY_PRESS, KEY_RELEASE, ALT_L = 0, 1, 64


def raise_by_alt_tab(app, frame, tries=4):
    """Raise WeChat with openbox's Alt+Tab, sent through the AT-SPI registry.
    Openbox grabs Alt+Tab, so the Tab does not reach the focused window; the Alt
    press and release alone do. Confirmed by AT-SPI's ACTIVE state."""
    from jeepney import new_method_call
    dec = registry(app.conn)
    for attempt in range(tries):
        if d.ACTIVE in frame.states():
            return attempt
        for ks, kind in ((ALT_L, KEY_PRESS), (0xFF09, KEY_SYM), (ALT_L, KEY_RELEASE)):
            app.conn.send_and_get_reply(new_method_call(dec, "GenerateKeyboardEvent", "isu", (ks, "", kind)), timeout=5)
        for _ in range(20):
            time.sleep(0.05)
            if d.ACTIVE in frame.states():
                return attempt + 1
    return None


def popup_rows(app, frame):
    rows = []
    for top in app.children():
        if top == frame:
            continue
        for lst in d.find(top, lambda n, st: n.role == "list"):
            rows.append(("list", lst, None))
            for kid in lst.children():
                rows.append(("row", kid, lst))
    return rows


def dump_popup(app, frame, label):
    out = []
    for kind, node, parent in popup_rows(app, frame):
        try:
            out.append({"kind": kind, **describe(node, parent)})
        except LookupError:
            pass
    trace("popup", label=label, rows=out)
    return out


def survey(args):
    app = d.wechat_app()
    frame = d.main_frame(app)
    box = d.search_box(frame)
    trace("frame", **describe(frame), search_box=describe(box) if box else None)
    if d.ACTIVE not in frame.states():
        trace("stop", reason="WeChat is not the active window; the survey sends keys, so bring it forward first")
        return 1
    box.grab_focus()
    time.sleep(0.3)
    box.set_text("")
    time.sleep(1)
    dump_popup(app, frame, "empty query: recent searches")
    for query in (args.contact, "Transfer"):
        box.grab_focus()
        box.set_text(query)
        time.sleep(2.5)
        dump_popup(app, frame, f"query {query!r}: settled")
        for step in (1, 2):
            if d.ACTIVE not in frame.states() or d.FOCUSED not in box.states():
                trace("stop", reason="focus left the search box; no more keys")
                break
            trace("key", key="Down", reply=press(app, "Down"))
            time.sleep(0.5)
            sel = [r for r in dump_popup(app, frame, f"query {query!r}: after Down x{step}")
                   if "selected" in r["states"] or "focused" in r["states"]]
            trace("selected_after_down", step=step, rows=[(r["name"], r["index"], r["states"]) for r in sel],
                  search_box_focused=d.FOCUSED in box.states())
    box.set_text("")
    return 0


def lag(args):
    """Measure how long AT-SPI keeps reporting WeChat active after X focus moves."""
    app = d.wechat_app()
    frame = d.main_frame(app)
    desk = d.Desktop()
    win = desk.window()
    chrome = next(l.split()[0] for l in subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True,
                  text=True).stdout.splitlines() if "Google Chrome" in l and "google-chrome" in l)
    results = []
    for trial in range(args.trials):
        subprocess.run([XDO, "windowactivate", "--sync", win], env=XENV)
        time.sleep(0.5)
        if d.ACTIVE not in frame.states():
            continue
        # Steal in the background, then poll X input focus and the AT-SPI state
        # side by side. Their difference is the window in which a key guarded
        # only by AT-SPI would reach Chrome.
        t0 = time.time()
        steal = subprocess.Popen([XDO, "windowactivate", chrome], env=XENV)
        t_x = t_a = None
        while (t_x is None or t_a is None) and time.time() - t0 < 3:
            if t_x is None:
                focus = subprocess.run([XDO, "getwindowfocus"], env=XENV, capture_output=True, text=True).stdout
                if focus.strip() and int(focus) != int(win, 16):
                    t_x = time.time() - t0
            if t_a is None and d.ACTIVE not in frame.states():
                t_a = time.time() - t0
        steal.wait()
        results.append({"trial": trial, "x_focus_left_ms": round((t_x or 9) * 1000),
                        "atspi_inactive_ms": round((t_a or 9) * 1000),
                        "atspi_after_x_ms": round(((t_a or 9) - (t_x or 9)) * 1000)})
        trace("lag", **results[-1])
    for key in ("atspi_after_x_ms",):
        ms = sorted(r[key] for r in results)
        trace("lag.summary", measure=key, trials=len(ms), min=ms[0], median=ms[len(ms) // 2], max=ms[-1])
    return 0



# ---------------------------------------------------------------- the keyboard route

XK.update({"space": 0x20})
# Header rows whose section is not a local chat. Only English is verified.
NONLOCAL_HEADERS = {"Internet search results", "More"}
BACK_NAMES = ("Back", "返回")


class Stop(Exception):
    def __init__(self, code, reason, typed=False):
        super().__init__(reason)
        self.code, self.reason, self.typed = code, reason, typed


class XFocus:
    """The one X11 read left in the route: which window has X input focus.
    AT-SPI lags X by 38 to 107 ms, and the registry's keys follow X focus."""

    def __init__(self):
        import ctypes
        self.x = ctypes.cdll.LoadLibrary("libX11.so.6")
        self.x.XOpenDisplay.restype = ctypes.c_void_p
        self.x.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
        self.x.XFlush.argtypes = [ctypes.c_void_p]
        self.dpy = self.x.XOpenDisplay(None)
        self.ctypes = ctypes

    def focus(self):
        win, rev = self.ctypes.c_ulong(), self.ctypes.c_int()
        self.x.XGetInputFocus(self.dpy, self.ctypes.byref(win), self.ctypes.byref(rev))
        return win.value


class Route:
    def __init__(self, app, x_guard=True, x_raise=False):
        self.app, self.frame = app, d.main_frame(app)
        self.x_guard, self.x_raise = x_guard, x_raise
        self.xf = XFocus() if x_guard else None
        self.win = None
        self.keys = []  # every key sent, with the guard's view

    def wechat_x_window(self):
        tree = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True).stdout
        ids = [int(l.split()[0], 16) for l in tree.splitlines() if '"Weixin": ("wechat" "wechat")' in l]
        return ids[0] if len(ids) == 1 else None

    def front(self):
        a11y = d.ACTIVE in self.frame.states()
        if not self.x_guard:
            return a11y
        return a11y and self.xf.focus() == self.win

    def key(self, name, must_focus=None):
        """One key through the AT-SPI registry, only while WeChat is in front
        (and `must_focus`, if given, holds keyboard focus), then re-checked
        after the AT-SPI lag: a steal in that window may have taken the key."""
        if not self.front() or (must_focus is not None and d.FOCUSED not in must_focus.states()):
            raise Stop("focus-lost", f"WeChat is not in front before {name}; no key sent", self.typed)
        press(self.app, name)
        self.keys.append(name)
        time.sleep(0.15)
        if not self.front():
            raise Stop("focus-lost-after-key", f"WeChat lost the front within 150 ms of {name}; the key may have gone elsewhere", self.typed)

    def bring_forward(self):
        self.win = self.wechat_x_window()
        if self.front():
            return
        if raise_by_alt_tab(self.app, self.frame) is not None and self.front():
            trace("raise", via="registry Alt+Tab")
            return
        if self.x_raise:
            subprocess.run([XDO, "windowactivate", "--sync", hex(self.win)], env=XENV)
            time.sleep(0.3)
            if self.front():
                trace("raise", via="xdotool windowactivate (X11)")
                return
        raise Stop("not-raised", "WeChat is not in front and could not be raised" + ("" if self.x_raise else " without X11"))

    def search_box(self):
        box = d.search_box(self.frame)
        if box is None:
            back = d.find(self.frame, lambda n, st: n.role == "push button" and n.name in BACK_NAMES)
            if not back:
                raise Stop("not-ready", "no search box and no Back button")
            back[0].grab_focus()  # SetFocus is the button's only action
            time.sleep(0.2)
            self.key("space", must_focus=back[0])  # a focused button takes Space
            time.sleep(0.5)
            box = d.search_box(self.frame)
            if box is None:
                raise Stop("not-ready", "no search box even after Back")
        return box

    def focus_box(self, box):
        for _ in range(3):
            box.grab_focus()
            time.sleep(0.15)
            if d.FOCUSED in box.states():
                return
            self.bring_forward()
        raise Stop("focus-lost", "the search box would not take keyboard focus")

    def rows(self):
        out = []
        for top in self.app.children():
            if top == self.frame:
                continue
            try:
                for lst in d.find(top, lambda n, st: n.role == "list"):
                    out.extend((i, kid, kid.name, kid.states()) for i, kid in enumerate(lst.children()))
            except LookupError:
                return []  # the list was rebuilt mid-read; the caller reads again
        return out

    def choose(self, box, name):
        """Open the one local result named `name`, confirmed through the tree:
        Down then Up makes the tree mark the current row as focused."""
        for attempt in range(3):
            self.focus_box(box)
            box.set_text(name)
            seen, stable, deadline = None, 0, time.time() + 6
            while time.time() < deadline:
                time.sleep(0.3)
                if d.FOCUSED not in box.states():
                    break
                names = [r[2] for r in self.rows()]
                # Every query lists a web suggestion named after itself, so a
                # list without that row still shows an earlier state.
                current = box.text() in names
                stable = stable + 1 if names and current and names == seen else 0
                seen = names
                if stable >= 2:
                    break
            if d.FOCUSED not in box.states():
                self.bring_forward()
                continue
            if stable < 2:
                box.set_text("")
                raise Stop("not-found", f"the results for {name!r} never settled")
            rows = self.rows()
            exact = [r for r in rows if r[2] == name]
            if not exact:
                trace("not-found.rows", rows=[r[2] for r in rows][:12])
                box.set_text("")
                raise Stop("not-found", f"no row is named {name!r}")
            self.key("Down", must_focus=box)
            self.key("Up", must_focus=box)
            rows = self.rows()
            current = [r for r in rows if d.FOCUSED in r[3]]
            header = rows[0][2] if rows else None
            trace("choose", current=[(r[0], r[2]) for r in current], first_header=header,
                  exact_rows=[r[0] for r in exact])
            if len(current) != 1 or current[0][2] != name or current[0][0] != 1 or header in NONLOCAL_HEADERS:
                box.set_text("")
                code = "ambiguous" if len(exact) > 1 else "not-found"
                raise Stop(code, f"the top hit is {current and current[0][2]!r} under {header!r}, not a local {name!r}")
            if len([r for r in exact if r[0] < self.web_index(rows)]) > 1:
                box.set_text("")
                raise Stop("ambiguous", f"more than one local row is named {name!r}")
            return current[0][1]
        box.set_text("")
        raise Stop("focus-lost", "the search lost focus before its results settled")

    @staticmethod
    def web_index(rows):
        return next((r[0] for r in rows if r[2] == "Internet search results"), len(rows))

    typed = False

    def open_chat(self, name):
        self.bring_forward()
        box = self.search_box()
        self.choose(box, name)
        self.key("Return", must_focus=box)
        time.sleep(0.8)
        if not self.front() or self.rows():
            raise Stop("wrong-chat", "Return did not open a chat in WeChat's main window")
        inputs = d.chat_inputs(self.frame)
        if len(inputs) != 1 or inputs[0].name != name:
            raise Stop("wrong-chat", f"the open chat is {[i.name for i in inputs]}, not {name!r}")
        return inputs[0]

    def run(self, name, body, send=False, store=None, chat_id=None):
        before = {m["id"] for m in store.chat(chat_id) if d.is_echo(m, body)} if send else set()
        # A focus steal before anything is typed is retried from the top, like
        # round 2. Every key was guarded, so the retry cannot repeat a leak.
        for attempt in range(3):
            try:
                box = self.open_chat(name)
                break
            except Stop as e:
                if e.typed or e.code not in ("focus-lost", "focus-lost-after-key", "wrong-chat") or attempt == 2:
                    raise
                trace("retry", attempt=attempt + 1, after=e.code)
                time.sleep(0.3)
        if box.text():
            raise Stop("not-ready", "the input already holds a draft")
        box.set_text(body)
        self.typed = True
        if box.text() != body:
            box.set_text("")
            raise Stop("not-ready", "the input did not take the text exactly", True)
        if not send:
            box.set_text("")
            return {"reached": name, "left": box.text(), "keys": self.keys}
        box.grab_focus()
        time.sleep(0.2)
        if not self.front() or d.FOCUSED not in box.states() or box.text() != body:
            box.set_text("")
            raise Stop("focus-lost", "WeChat or its input lost focus before Return; input cleared", True)
        press(self.app, "Return")
        self.keys.append("Return")
        time.sleep(0.15)
        lost = not self.front()  # recorded, but the store decides whether it sent
        deadline = time.time() + 30
        while time.time() < deadline:
            fresh = [m for m in store.chat(chat_id) if d.is_echo(m, body) and m["id"] not in before]
            if fresh:
                return {"sent": True, "store_id": fresh[-1]["id"], "keys": self.keys, "front_lost_after_return": lost}
            time.sleep(1.5)
        raise Stop("no-echo", "no copy in the store after 30 s", True)


def race(args):
    """Deterministic steal: move X focus to the thief, then at once try one
    guarded Down. The AT-SPI state still reads WeChat active for ~40-110 ms."""
    thief = thief_window()
    app = d.wechat_app()
    out = []
    for guard in ("a11y-only", "a11y+X"):
        for trial in range(args.trials):
            r = Route(app, x_guard=guard == "a11y+X")
            r.win = r.wechat_x_window()
            xdo("windowactivate", "--sync", hex(r.win))
            time.sleep(0.5)
            before = os.path.getsize(THIEF_LOG) if os.path.exists(THIEF_LOG) else 0
            xdo("windowactivate", "--sync", thief)
            a11y_active = d.ACTIVE in r.frame.states()
            sent = False
            if r.front():
                press(app, "Down")
                sent = True
            time.sleep(0.3)
            leaked = (os.path.getsize(THIEF_LOG) if os.path.exists(THIEF_LOG) else 0) - before
            out.append({"guard": guard, "trial": trial, "atspi_said_active": a11y_active, "key_sent": sent, "leaked_bytes": leaked})
            trace("race", **out[-1])
    for guard in ("a11y-only", "a11y+X"):
        rows = [o for o in out if o["guard"] == guard]
        trace("race.summary", guard=guard, trials=len(rows), keys_sent=sum(o["key_sent"] for o in rows),
              leaked=sum(o["leaked_bytes"] > 0 for o in rows))
    xdo("windowactivate", "--sync", hex(Route(app).wechat_x_window()))
    return 0


def run_cmd(args):
    app = d.wechat_app()
    r = Route(app, x_guard=not args.a11y_only_guard, x_raise=args.x_raise)
    # The query is the display name, except that File Transfer is only found by
    # "Transfer" (round 1): the match stays exact on "File Transfer".
    try:
        if args.query:
            orig = d.Node.set_text
            d.Node.set_text = lambda self, s: orig(self, args.query if s == args.name else s)
        if args.send:
            if (args.name, args.text) != ("File Transfer", "rome test"):
                raise SystemExit("real sends are authorized only for 'rome test' to File Transfer")
            out = r.run(args.name, args.text, send=True, store=d.Store(), chat_id="filehelper")
        else:
            out = r.run(args.name, "rome test")
        trace("done", **out)
        return 0
    except Stop as e:
        trace("stopped", code=e.code, typed=e.typed, reason=e.reason, keys=r.keys)
        return 1


# ---------------------------------------------------------------- scenario 4 (dry)

THIEF_LOG = "/tmp/r3/thief-keys.txt"


def xdo(*args):
    return subprocess.run([XDO, *args], env=XENV, capture_output=True, text=True).stdout.strip()


def thief_window():
    """An xterm that records every key it receives: a stand-in for Chrome
    taking focus, so a leaked key is counted and does nothing."""
    tree = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True).stdout
    ids = [l.split()[0] for l in tree.splitlines() if '"r3-thief"' in l]
    if ids:
        return ids[0]
    subprocess.Popen(["xterm", "-T", "r3-thief", "-geometry", "30x3+960+700", "-e", "sh", "-c",
                      f"stty raw -echo; cat >> {THIEF_LOG}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    return thief_window()


def chrome_window():
    tree = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True).stdout
    return next(l.split()[0] for l in tree.splitlines() if "Google Chrome" in l and "google-chrome" in l
                and "IsViewable" in subprocess.run(["xwininfo", "-id", l.split()[0]], capture_output=True, text=True).stdout)


def setup(cond, win, contact):
    if cond.startswith("size"):
        w, h, x, y = cond.split(":")[1].split(",")
        xdo("windowactivate", "--sync", win); xdo("windowsize", "--sync", win, w, h); xdo("windowmove", "--sync", win, x, y)
    elif cond == "minimized":
        xdo("windowminimize", "--sync", win)
    elif cond == "behind-chrome":
        xdo("windowactivate", "--sync", win); xdo("windowactivate", "--sync", chrome_window())
    elif cond == "leftover-search":
        xdo("windowactivate", "--sync", win)
        box = d.search_box(d.main_frame(d.wechat_app()))
        box.grab_focus(); box.set_text("zzqx")
    elif cond == "other-chat":
        xdo("windowactivate", "--sync", win)
        Route(d.wechat_app()).open_chat(contact)  # open only, nothing typed
    elif cond == "focus-steal":
        import random
        xdo("windowactivate", "--sync", win)
        delay = round(random.uniform(0.3, 5.0), 2)
        subprocess.Popen(["sh", "-c", f"sleep {delay}; {XDO} windowactivate {thief_window()}"], env=XENV)
        return {"steal_after_s": delay}
    time.sleep(0.8)
    return {}


CONDITIONS = (["size:880,640,200,80"] * 2 + ["size:760,560,40,30"] * 2 + ["size:480,440,600,300"] * 3
              + ["size:1280,770,0,0"] * 2 + ["minimized"] * 4 + ["behind-chrome"] * 4
              + ["leftover-search"] * 4 + ["other-chat"] * 4 + ["focus-steal"] * 25)


def reliability(args):
    thief_window()
    win = hex(Route(d.wechat_app()).wechat_x_window())
    conds = CONDITIONS if not args.only else [c for c in CONDITIONS if c.startswith(args.only)]
    results = []
    for i, cond in enumerate(conds, 1):
        leaked_before = os.path.getsize(THIEF_LOG) if os.path.exists(THIEF_LOG) else 0
        try:
            extra = setup(cond, win, args.contact)
        except Exception as e:  # noqa: BLE001
            extra = {"setup_error": str(e)}
        r = Route(d.wechat_app(), x_guard=not args.a11y_guard, x_raise=args.x_raise)
        orig = d.Node.set_text
        d.Node.set_text = lambda self, s: orig(self, "Transfer" if s == "File Transfer" else s)
        t = time.time()
        try:
            out = r.run("File Transfer", "rome test")
            outcome, code, reason = "reached-and-cleared", None, None
        except Stop as e:
            outcome, code, reason = "stopped", e.code, e.reason
        except LookupError as e:  # a node vanished: nothing more is sent
            outcome, code, reason = "stopped", "tree-changed", str(e)[:120]
        finally:
            d.Node.set_text = orig
        time.sleep(0.3)
        leaked = (os.path.getsize(THIEF_LOG) if os.path.exists(THIEF_LOG) else 0) - leaked_before
        results.append({"run": i, "condition": cond, "outcome": outcome, "code": code, "reason": reason,
                        "keys": r.keys, "leaked_bytes": leaked, "secs": round(time.time() - t, 1), **extra})
        trace("reliability.result", **results[-1])
        xdo("windowactivate", "--sync", win)
    xdo("windowsize", "--sync", win, "878", "640"); xdo("windowmove", "--sync", win, "200", "80")
    by = {}
    for r in results:
        b = by.setdefault(r["condition"], {"runs": 0, "ok": 0, "stops": [], "leaks": 0})
        b["runs"] += 1; b["ok"] += r["outcome"] == "reached-and-cleared"; b["leaks"] += r["leaked_bytes"] > 0
        if r["code"]:
            b["stops"].append(r["code"])
    trace("reliability.summary", total=len(results), ok=sum(r["outcome"] == "reached-and-cleared" for r in results),
          leaks=sum(r["leaked_bytes"] > 0 for r in results), by_condition=by)
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("survey")
    s.add_argument("--contact", required=True)
    rn = sub.add_parser("run")
    rn.add_argument("--name", required=True)
    rn.add_argument("--query")
    rn.add_argument("--text", default="rome test")
    rn.add_argument("--send", action="store_true")
    rn.add_argument("--x-raise", action="store_true", help="allow xdotool windowactivate when minimized")
    rn.add_argument("--a11y-only-guard", action="store_true", help="drop the X input-focus check")
    rl = sub.add_parser("reliability")
    rl.add_argument("--contact", required=True)
    rl.add_argument("--x-raise", action="store_true")
    rl.add_argument("--only")
    rl.add_argument("--a11y-guard", action="store_true", help="drop the X input-focus check (measures leaks)")
    rc = sub.add_parser("race")
    rc.add_argument("--trials", type=int, default=10)
    lg = sub.add_parser("lag")
    lg.add_argument("--trials", type=int, default=20)
    a = p.parse_args()
    return {"survey": survey, "lag": lag, "run": run_cmd, "reliability": reliability, "race": race}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
