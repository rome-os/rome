#!/usr/bin/env python3
"""PROTOTYPE, never merge. Round 2 of rome-work personal-wechat-replies
(prototype-brief.md @ 62888a6): send `rome test` to File Transfer through the
client's AT-SPI accessibility tree instead of screenshots.

    python3 wechat-user-send-a11y-prototype.py --enable        # start the a11y bus (once)
    python3 wechat-user-send-a11y-prototype.py --check         # readiness only
    python3 wechat-user-send-a11y-prototype.py --dump NAME     # showing tree -> /tmp/a11y
    python3 wechat-user-send-a11y-prototype.py                 # dry run: all but Enter
    python3 wechat-user-send-a11y-prototype.py --send          # the real send
    python3 wechat-user-send-a11y-prototype.py --reliability   # 34-run dry matrix
        [--narrow | --steal]                                   # narrow-window or focus-steal runs only
    python3 wechat-user-send-a11y-prototype.py --missing-target-test   # refusal probe, dry

Enabling: --enable starts a private AT-SPI bus under /tmp/a11y and claims
org.a11y.Bus on the session bus (see wechat-user-send-a11y-prototype/a11y_bus.py).
The running client's Qt bridge notices the name within a second and joins the
bus on its own: no restart, no sign-in, no phone confirmation.

Every lookup, check and text edit goes through AT-SPI: controls are found by
role and accessible name, text is set and read back with EditableText and Text,
and the open chat is identified by the message input's accessible name, which
is the chat's display name. xdotool is used only where the tree offers no
action: raising the window, clicking the search result or Back button at the
extents the tree reports, and the final Return. Before each of those, both
AT-SPI (frame ACTIVE) and the X server (_NET_ACTIVE_WINDOW) must agree WeChat
is in front; AT-SPI alone trails an X focus change. No screenshots are read.

The body and the target are fixed: the guardian authorized only `rome test`
to File Transfer.
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.join(HERE, "wechat-user-send-a11y-prototype")
sys.path.insert(0, "/tmp/a11y/py")  # jeepney, fetched by --enable

BODY = "rome test"
TARGET = "filehelper"
# The target's accessible names per interface language. The input and the
# header carry the chat's display name, so this is the only language table.
TARGET_NAMES = {"File Transfer", "文件传输助手"}
QUERIES = {"File Transfer": "Transfer", "文件传输助手": "文件传输助手"}
A11Y_BUS = "unix:path=/tmp/a11y/bus"
READER_PY = os.path.expanduser("~/.local/share/wechat/cli/bin/python3")
HELPER = os.path.join(HERE, "wechat-user-helper.py")
XDO = "/tmp/xdo/root/usr/bin/xdotool"
XENV = {**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":99"),
        "LD_LIBRARY_PATH": "/tmp/xdo/root/usr/lib/x86_64-linux-gnu"}

FOCUSED, SHOWING, EDITABLE, SELECTED, ACTIVE, ICONIFIED = 12, 25, 7, 23, 1, 17
T0 = time.time()


def trace(event, **fields):
    print(json.dumps({"t": round(time.time() - T0, 2), "event": event, **fields}, ensure_ascii=False), flush=True)


class Stop(Exception):
    """Refuse to go on."""


# ---------------------------------------------------------------- AT-SPI

_conn = None


def conn():
    global _conn
    if _conn is None:
        from jeepney.io.blocking import open_dbus_connection
        _conn = open_dbus_connection(A11Y_BUS)
    return _conn


def call(ref, iface, member, sig=None, body=(), timeout=5):
    from jeepney import DBusAddress, new_method_call
    reply = conn().send_and_get_reply(
        new_method_call(DBusAddress(ref[1], ref[0], iface), member, sig, body), timeout=timeout)
    if reply.header.message_type.name == "error":
        raise RuntimeError(f"{iface}.{member}: {reply.body}")
    return reply.body


class Node:
    ACC = "org.a11y.atspi.Accessible"

    def __init__(self, ref):
        self.ref = tuple(ref)

    def __eq__(self, other):
        return isinstance(other, Node) and self.ref == other.ref

    def _prop(self, iface, name):
        return call(self.ref, "org.freedesktop.DBus.Properties", "Get", "ss", (iface, name))[0][1]

    @property
    def name(self): return self._prop(self.ACC, "Name")
    @property
    def role(self): return call(self.ref, self.ACC, "GetRoleName")[0]
    def children(self): return [Node(c) for c in call(self.ref, self.ACC, "GetChildren")[0]]
    def interfaces(self): return call(self.ref, self.ACC, "GetInterfaces")[0]

    def states(self):
        bits = call(self.ref, self.ACC, "GetState")[0]
        return {i for i in range(64) if bits[i // 32] >> (i % 32) & 1}

    def text(self):
        n = self._prop("org.a11y.atspi.Text", "CharacterCount")
        return call(self.ref, "org.a11y.atspi.Text", "GetText", "ii", (0, n))[0]

    def set_text(self, s):
        return call(self.ref, "org.a11y.atspi.EditableText", "SetTextContents", "s", (s,))[0]

    def actions(self):
        return [a[0] for a in call(self.ref, "org.a11y.atspi.Action", "GetActions")[0]]

    def grab_focus(self):
        return call(self.ref, "org.a11y.atspi.Component", "GrabFocus")[0]

    def extents(self):
        return call(self.ref, "org.a11y.atspi.Component", "GetExtents", "u", (0,))[0]


ROOT = Node(("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root"))


def find_all(node, pred, showing_only=True, limit=None, out=None):
    """Depth-first search. With showing_only, hidden subtrees are skipped:
    WeChat keeps every page it has built, and only the shown ones matter."""
    out = [] if out is None else out
    try:
        st = node.states()
        if showing_only and SHOWING not in st and node.role not in ("application",):
            return out
        if pred(node, st):
            out.append(node)
            if limit and len(out) >= limit:
                return out
        for k in node.children():
            find_all(k, pred, showing_only, limit, out)
            if limit and len(out) >= limit:
                break
    except RuntimeError:
        pass  # a node vanished mid-walk
    return out


def first(node, pred, **kw):
    hits = find_all(node, pred, limit=1, **kw)
    return hits[0] if hits else None


def app():
    try:
        for a in ROOT.children():
            if a.name == "wechat":
                return a
    except Exception as e:  # noqa: BLE001
        raise Stop(f"accessibility tree missing: {e}")
    return None


def main_frame(a):
    frames = [f for f in a.children() if f.role == "frame"]
    return frames[0] if len(frames) == 1 else None


def describe(n):
    d = {"role": n.role, "name": n.name}
    ifs = n.interfaces()
    d["ifaces"] = [i.replace("org.a11y.atspi.", "") for i in ifs if i != Node.ACC]
    if "org.a11y.atspi.Text" in ifs:
        d["text"] = n.text()
    if "org.a11y.atspi.Action" in ifs:
        d["actions"] = n.actions()
    st = n.states()
    d["states"] = [k for k, v in {"active": ACTIVE, "focused": FOCUSED, "showing": SHOWING,
                                  "editable": EDITABLE, "selected": SELECTED}.items() if v in st]
    return d


def title_of(name):
    """A chat-list or search item's name is 'Title\\npreview\\ntime'."""
    return (name or "").split("\n", 1)[0].strip()


# ---------------------------------------------------------------- X helpers

def xdo(*args):
    r = subprocess.run([XDO, *args], env=XENV, capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise Stop(f"xdotool {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def wechat_window():
    out = subprocess.run(["xwininfo", "-root", "-tree"], env=XENV, capture_output=True, text=True).stdout
    ids = [l.split()[0] for l in out.splitlines() if '"Weixin": ("wechat" "wechat")' in l]
    return ids[0] if len(ids) == 1 else None


def x_active_is_wechat():
    out = subprocess.run(["xprop", "-root", "_NET_ACTIVE_WINDOW"], env=XENV, capture_output=True, text=True).stdout
    win = wechat_window()
    return bool(win) and int(out.split()[-1], 16) == int(win, 16)


def wechat_is_active(frame):
    # AT-SPI's ACTIVE state trails an X focus change by a few hundred ms, so
    # the X server's answer is checked too.
    return ACTIVE in frame.states() and x_active_is_wechat()


def require_active(frame, what):
    if not wechat_is_active(frame):
        raise Stop(f"WeChat's frame is not the active window before {what}; nothing pressed")


# ---------------------------------------------------------------- store

def reader(*args):
    r = subprocess.run([READER_PY, HELPER, *args], capture_output=True, text=True, timeout=120,
                       env={**os.environ, "HOME": os.path.expanduser("~")})
    return r.returncode, r.stdout, r.stderr.strip()


def store_echoes(since):
    code, out, err = reader("messages", "--conversation", TARGET, "--since", str(since), "--limit", "50")
    if code != 0:
        raise Stop(f"store read failed (exit {code}): {err}")
    here = [m for m in json.loads(out)["messages"] if m["text"] == BODY]
    code, out, _ = reader("messages", "--since", str(since), "--limit", "200")
    elsewhere = [m for m in (json.loads(out)["messages"] if code == 0 else [])
                 if m["text"] == BODY and m["conversationId"] != TARGET]
    return here, elsewhere


# ---------------------------------------------------------------- the route

def preflight():
    pids = subprocess.run(["pgrep", "-f", "^/opt/wechat/wechat$"], capture_output=True, text=True).stdout.split()
    trace("check.process", pids=pids)
    if not pids:
        raise Stop("not running: no /opt/wechat/wechat process")
    a = app()
    if a is None:
        raise Stop("accessibility tree missing: WeChat is not registered on the a11y bus (run --enable)")
    frame = main_frame(a)
    if frame is None:
        raise Stop("no single WeChat main frame in the tree")
    chats = first(frame, lambda n, st: n.role == "list" and n.name in ("Chats", "聊天"), showing_only=False)
    search = first(frame, lambda n, st: n.role == "text" and n.name in ("Search", "搜索")
                   and EDITABLE in st, showing_only=False)
    trace("check.tree", frame=frame.name, chats_list=bool(chats), search_box=bool(search))
    if not chats or not search:
        raise Stop("the main frame has no chat list or search box: signed out, locked, or still loading")
    code, out, err = reader("check")
    trace("check.store", exit=code, keysReady=code == 0 and json.loads(out).get("keysReady") is True)
    if code != 0:
        raise Stop(f"store not readable (exit {code})")
    return a, frame


def raise_window(frame):
    win = wechat_window()
    if not win:
        raise Stop("no WeChat main X window")
    xdo("windowactivate", "--sync", win)
    for _ in range(20):
        if wechat_is_active(frame):
            break
        time.sleep(0.1)
    require_active(frame, "the search")
    return win


def open_target(a, frame):
    # 1. Search box: find by role and name among showing nodes, focus it and
    #    set its text through EditableText. Leftover text is simply replaced.
    search = first(frame, lambda n, st: n.role == "text" and n.name in ("Search", "搜索") and EDITABLE in st)
    if search is None:
        # Below about 700 px wide WeChat shows one pane: the open chat with a
        # Back button, and no chat list or search box. Back returns to the list.
        back = first(frame, lambda n, st: n.role == "push button" and n.name in ("Back", "返回"))
        trace("search.missing", back_button=bool(back))
        if back is None:
            raise Stop("no showing search box")
        x, y, w, h = back.extents()
        require_active(frame, "clicking Back")
        xdo("mousemove", str(x + w // 2), str(y + h // 2), "click", "1")
        time.sleep(0.8)
        search = first(frame, lambda n, st: n.role == "text" and n.name in ("Search", "搜索") and EDITABLE in st)
        if search is None:
            raise Stop("no showing search box, even after Back")
    # The results popup only opens, and stays open, while the box holds
    # keyboard focus, which it cannot hold while another X window is active.
    # GrabFocus returns true regardless, so the FOCUSED state is read back,
    # before setting the query and while waiting for results.
    def focus_search(attempt):
        for _ in range(3):
            search.grab_focus()
            time.sleep(0.15)
            if FOCUSED in search.states():
                return
            trace("search.not_focused", attempt=attempt, frame_active=ACTIVE in frame.states())
            raise_window(frame)
        raise Stop("the search box would not take keyboard focus; nothing typed")

    hit, target_name = None, None
    for name, q in QUERIES.items():
        target_name = name
        for attempt in range(1, 4):
            focus_search(attempt)
            search.set_text(q)
            trace("search.set", query=q, attempt=attempt, read_back=search.text(),
                  focused=FOCUSED in search.states())
            # 2. The results popup is its own top-level node. Pick the list
            #    item whose title is exactly the target's name.
            lost, deadline = False, time.time() + 5
            while hit is None and time.time() < deadline:
                time.sleep(0.3)
                if FOCUSED not in search.states():
                    lost = True
                    trace("search.focus_lost", attempt=attempt)
                    break
                for top in a.children():
                    if top == frame:
                        continue
                    hit = first(top, lambda n, st: n.role == "list item" and title_of(n.name) == name)
                    if hit:
                        break
            if hit or not lost:
                break
            raise_window(frame)
        if hit:
            break
    if not hit:
        search.set_text("")
        raise Stop(f"no search result named {sorted(TARGET_NAMES)}; nothing typed into any chat")
    x, y, w, h = hit.extents()
    trace("search.hit", name=title_of(hit.name), extents=[x, y, w, h])
    if w <= 0 or h <= 0:
        raise Stop("the matching result has no on-screen extents")
    # 3. The tree offers no action on the item, so click its centre.
    require_active(frame, "clicking the search result")
    xdo("mousemove", str(x + w // 2), str(y + h // 2), "click", "1")
    time.sleep(0.8)
    return target_name


def open_input(frame, target_name):
    """The message input's accessible name is the open chat's name."""
    deadline = time.time() + 4
    while time.time() < deadline:
        inputs = find_all(frame, lambda n, st: n.role == "text" and EDITABLE in st
                          and n.name not in ("Search", "搜索"))
        header = first(frame, lambda n, st: n.role == "label" and n.name == target_name)
        names = [i.name for i in inputs]
        if len(inputs) == 1 and names[0] == target_name and header is not None:
            trace("check.opened", input_name=names[0], header=header.name)
            return inputs[0]
        time.sleep(0.3)
    trace("check.opened", inputs=names, header=bool(header))
    raise Stop(f"the open chat is not {target_name}: showing inputs {names}")


def run(send, since=None):
    a, frame = preflight()
    raise_window(frame)
    target_name = open_target(a, frame)
    box = open_input(frame, target_name)
    draft = box.text()
    trace("input.before", text=draft)
    if draft:
        raise Stop("the File Transfer input already holds a draft; not touching it")
    box.set_text(BODY)
    typed = box.text()
    trace("input.after_set", text=typed, exact=typed == BODY)
    if typed != BODY:
        box.set_text("")
        raise Stop(f"the input holds {typed!r}, not {BODY!r}; cleared, Enter not pressed")
    box = open_input(frame, target_name)  # re-check the chat just before the end
    if not send:
        box.set_text("")
        left = box.text()
        trace("dry_run.cleared", left=left)
        if left:
            raise Stop(f"could not clear the input: {left!r}")
        return {"sent": False}
    box.grab_focus()
    time.sleep(0.2)
    st = box.states()
    trace("check.focus", input_focused=FOCUSED in st, frame_active=ACTIVE in frame.states())
    if FOCUSED not in st:
        box.set_text("")
        raise Stop("the File Transfer input did not take focus; cleared, Enter not pressed")
    if not wechat_is_active(frame):
        box.set_text("")
        raise Stop("WeChat's frame lost the active window before Return; input cleared, Enter not pressed")
    xdo("key", "--clearmodifiers", "Return")
    sent_at = time.time()
    trace("enter.pressed")
    time.sleep(0.6)
    trace("input.after_enter", text=box.text())
    known = set()
    while True:
        here, elsewhere = store_echoes(since)
        fresh = [m for m in here if m["id"] not in known]
        trace("store.poll", after_s=round(time.time() - sent_at, 1),
              target=[{k: m[k] for k in ("id", "isSelf", "type", "timestamp")} for m in fresh],
              elsewhere=[m["conversationId"] for m in elsewhere])
        if elsewhere or fresh or time.time() - sent_at > 30:
            break
        time.sleep(2)
    return {"sent": True, "store_ids": [m["id"] for m in fresh], "elsewhere": [m["conversationId"] for m in elsewhere]}


# ---------------------------------------------------------------- dump

NEEDED = {
    "search box": lambda d: d["role"] == "text" and d["name"] in ("Search", "搜索"),
    "search result": lambda d: d["role"] == "list item" and title_of(d["name"]) in TARGET_NAMES,
    "chat title": lambda d: d["role"] == "label" and d["name"] in TARGET_NAMES,
    "message input": lambda d: d["role"] == "text" and d["name"] not in ("Search", "搜索") and "editable" in d["states"],
}


def dump(label):
    a = app()
    rows = []

    def walk(n, depth):
        try:
            d = describe(n)
        except RuntimeError:
            return
        if "showing" not in d["states"] and depth > 1:
            return
        rows.append({"depth": depth, **d})
        for k in n.children():
            walk(k, depth + 1)

    walk(a, 0)
    path = f"/tmp/a11y/tree-{label}.jsonl"
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    found = {k: [r for r in rows if p(r)] for k, p in NEEDED.items()}
    trace("dump", label=label, showing_nodes=len(rows), path=path,
          needed={k: [{x: r[x] for x in ("role", "name", "text", "actions", "states") if x in r} for r in v][:3]
                  for k, v in found.items()})


# ---------------------------------------------------------------- reliability

def chrome_window():
    out = subprocess.run(["xwininfo", "-root", "-tree"], env=XENV, capture_output=True, text=True).stdout
    for l in out.splitlines():
        if '("google-chrome' in l and "Google Chrome" in l:
            wid = l.split()[0]
            st = subprocess.run(["xwininfo", "-id", wid], env=XENV, capture_output=True, text=True).stdout
            if "IsViewable" in st:
                return wid
    return None


def setup(cond):
    """Put the client in an awkward state before a dry run. Setup may click and
    resize, but never types into a chat."""
    a = app()
    frame = main_frame(a)
    win = wechat_window()
    if cond.startswith("size"):
        w, h, x, y = cond.split(":")[1].split(",")
        xdo("windowactivate", "--sync", win)
        xdo("windowsize", "--sync", win, w, h)
        xdo("windowmove", "--sync", win, x, y)
    elif cond == "minimized":
        xdo("windowminimize", "--sync", win)
    elif cond == "behind-chrome":
        xdo("windowactivate", "--sync", win)
        xdo("windowactivate", "--sync", chrome_window())
    elif cond == "leftover-search":
        raise_window(frame)
        s = first(frame, lambda n, st: n.role == "text" and n.name in ("Search", "搜索") and EDITABLE in st)
        s.grab_focus()
        s.set_text("zzqx")
    elif cond == "focus-steal":
        import random
        delay = round(random.uniform(*STEAL_WINDOW), 2)
        subprocess.Popen(["sh", "-c", f"sleep {delay}; {XDO} windowactivate {chrome_window()}"], env=XENV)
        return {"steal_after_s": delay}
    elif cond == "other-chat":
        raise_window(frame)
        item = first(frame, lambda n, st: n.role == "list item" and title_of(n.name) == "黄晓君")
        x, y, w, h = item.extents()
        require_active(frame, "setup click")
        xdo("mousemove", str(x + w // 2), str(y + h // 2), "click", "1")
    time.sleep(1)
    inputs = find_all(frame, lambda n, st: n.role == "text" and EDITABLE in st and n.name not in ("Search", "搜索"))
    search = first(frame, lambda n, st: n.role == "text" and n.name in ("Search", "搜索"))
    return {"open_chat": [i.name for i in inputs], "search_text": search.text() if search else None,
            "frame_active": ACTIVE in frame.states()}


STEAL_WINDOW = (0.5, 4.5)
CONDITIONS_STEAL = ["focus-steal"] * 8
CONDITIONS_NARROW = ["size:480,440,600,300", "size:430,420,100,100", "size:560,480,300,200", "size:480,440,600,300"]
CONDITIONS = (["size:880,640,200,80"] * 2 + ["size:760,560,40,30"] * 2 + ["size:480,440,600,300"] * 2 + ["size:1100,720,150,60"] * 2
              + ["size:1280,770,0,0"] * 2 + ["minimized"] * 4 + ["behind-chrome"] * 4
              + ["leftover-search"] * 5 + ["other-chat"] * 5 + ["focus-steal"] * 4
              + ["size:480,440,600,300"] * 2)


def reliability(conditions=None):
    results = []
    for i, cond in enumerate(conditions or CONDITIONS, 1):
        try:
            state = setup(cond)
        except Exception as e:  # noqa: BLE001
            state = {"setup_error": str(e)}
        trace("reliability.setup", run=i, condition=cond, **state)
        t = time.time()
        try:
            run(send=False)
            outcome, reason = "reached-and-cleared", None
        except Stop as e:
            outcome, reason = "stopped", str(e)
        results.append({"run": i, "condition": cond, "outcome": outcome, "reason": reason,
                        "secs": round(time.time() - t, 1)})
        trace("reliability.result", **results[-1])
    win = wechat_window()
    xdo("windowsize", "--sync", win, "880", "640")
    xdo("windowmove", "--sync", win, "200", "80")
    summary = {}
    for r in results:
        s = summary.setdefault(r["condition"].split(":")[0] if not r["condition"].startswith("size") else r["condition"],
                               {"runs": 0, "ok": 0, "stops": []})
        s["runs"] += 1
        s["ok"] += r["outcome"] == "reached-and-cleared"
        if r["reason"]:
            s["stops"].append(r["reason"])
    trace("reliability.summary", total=len(results), ok=sum(r["outcome"] == "reached-and-cleared" for r in results),
          by_condition=summary)


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--send", action="store_true")
    p.add_argument("--check", action="store_true")
    p.add_argument("--dump", metavar="LABEL")
    p.add_argument("--enable", action="store_true")
    p.add_argument("--reliability", action="store_true")
    p.add_argument("--missing-target-test", action="store_true", help="refusal probe, always dry")
    p.add_argument("--steal", action="store_true", help="with --reliability: only focus-steal runs")
    p.add_argument("--narrow", action="store_true", help="with --reliability: only the narrow-window runs")
    a = p.parse_args()
    if a.missing_target_test:
        # Refusal probe: look for a chat that does not exist. Always a dry run.
        global QUERIES, TARGET_NAMES
        QUERIES = {"Rome Nobody 9f3q": "9f3q"}
        TARGET_NAMES = set(QUERIES)
        trace("start", mode="dry-run", probe="missing target", query="9f3q")
        try:
            run(send=False)
            trace("done", sent=False)
        except Stop as e:
            trace("stopped", reason=str(e))
        return 0
    if a.reliability:
        if a.steal:
            global STEAL_WINDOW
            STEAL_WINDOW = (1.5, 3.5)
        reliability(CONDITIONS_NARROW if a.narrow else CONDITIONS_STEAL if a.steal else None)
        return 0
    if a.enable:
        if not os.path.exists(XDO):  # xdotool is not in the Rome image
            import urllib.request
            os.makedirs("/tmp/xdo", exist_ok=True)
            base = "https://deb.debian.org/debian/pool/main/x/xdotool/"
            for deb in ("xdotool_3.20160805.1-5_amd64.deb", "libxdo3_3.20160805.1-5_amd64.deb"):
                urllib.request.urlretrieve(base + deb, f"/tmp/xdo/{deb}")
                subprocess.run(["dpkg-deb", "-x", f"/tmp/xdo/{deb}", "/tmp/xdo/root"], check=True)
        subprocess.run([sys.executable, os.path.join(KIT, "a11y_bus.py"), "--background"], check=True)
        return 0
    if a.dump:
        dump(a.dump)
        return 0
    trace("start", mode="send" if a.send else "check" if a.check else "dry-run", body=BODY, target=TARGET)
    try:
        if a.check:
            preflight()
            trace("ready")
            return 0
        since = int(time.time()) - 2
        result = run(a.send, since)
        trace("done", **result)
        return 0
    except Stop as e:
        trace("stopped", reason=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
