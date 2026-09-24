#!/usr/bin/env python3
"""PROTOTYPE, never merge. Sends `rome test` to WeChat's File Transfer chat
(`filehelper`) by driving the live desktop client with xdotool and the
clipboard, then confirms the send from the client's local store.

Brief: rome-work personal-wechat-replies/prototype-brief.md @ 8127f36.

    python3 wechat-user-send-prototype.py            # dry run: every step but Enter
    python3 wechat-user-send-prototype.py --send     # the real send
    python3 wechat-user-send-prototype.py --check    # readiness only

The body and the target are fixed. The guardian authorized only `rome test`
to File Transfer, so neither is a parameter.

Guards before Enter, each one a stop:
  1. the client process, its main window, no login window, the store keys;
  2. the client's sidebar is drawn (meant to catch a lock screen; not run locked);
  3. Ctrl+F focused the search box, and its top hit is the File Transfer feature;
  4. the opened chat's header is File Transfer (checked twice);
  5. the message input was empty, and holds exactly `rome test` after the paste.
Checks 2-4 compare pixels with reference crops cut from this client
(4.1.13.9, English UI, 880x640 window), in wechat-user-send-prototype/.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

from PIL import Image, ImageChops

BODY = "rome test"
TARGET = "filehelper"
# Only this single-word query surfaces File Transfer in the client's search.
# `filehelper`, `File Transfer` and `文件传输助手` return only web suggestions.
QUERY = "Transfer"
HERE = os.path.dirname(os.path.abspath(__file__))
REFS = os.path.join(HERE, "wechat-user-send-prototype")
HELPER = os.path.join(HERE, "wechat-user-helper.py")
READER_PY = os.path.expanduser("~/.local/share/wechat/cli/bin/python3")
SHOTS = "/tmp/wechat-send-prototype"

# Crops relative to the main window's top-left corner.
HEADER = (305, 38, 600, 72)
TOPHIT = (73, 72, 393, 168)
SIDEBAR = (13, 145, 49, 225)
SEARCH_BOX = (73, 44, 253, 70)
SENTINEL = "⁣rome-prototype-sentinel⁣"

T0 = time.time()


def trace(event, **fields):
    line = {"t": round(time.time() - T0, 2), "event": event, **fields}
    print(json.dumps(line, ensure_ascii=False), flush=True)


class Stop(Exception):
    """Refuse to go on. Nothing after this point touches the client."""


def ensure_xdotool():
    found = shutil.which("xdotool")
    if found:
        return found, {}
    root = "/tmp/xdo/root"
    binary = f"{root}/usr/bin/xdotool"
    if not os.path.exists(binary):
        os.makedirs("/tmp/xdo", exist_ok=True)
        base = "https://deb.debian.org/debian/pool/main/x/xdotool/"
        for deb in ("xdotool_3.20160805.1-5_amd64.deb", "libxdo3_3.20160805.1-5_amd64.deb"):
            path = f"/tmp/xdo/{deb}"
            urllib.request.urlretrieve(base + deb, path)
            subprocess.run(["dpkg-deb", "-x", path, root], check=True)
        trace("setup.xdotool_fetched", path=binary)
    return binary, {"LD_LIBRARY_PATH": f"{root}/usr/lib/x86_64-linux-gnu"}


class Desktop:
    def __init__(self, display):
        self.env = {**os.environ, "DISPLAY": display}
        self.xdotool, extra = ensure_xdotool()
        self.env.update(extra)
        self.window = None
        self.origin = (0, 0)
        os.makedirs(SHOTS, exist_ok=True)

    def run(self, *args, input=None, check=True):
        r = subprocess.run(args, env=self.env, input=input, capture_output=True, text=True, timeout=20)
        if check and r.returncode != 0:
            raise Stop(f"{args[0]} failed: {r.stderr.strip()}")
        return r

    def key(self, *keys):
        self.assert_active()
        self.run(self.xdotool, "key", "--clearmodifiers", *keys)

    def set_clipboard(self, text):
        # xclip stays alive as the selection owner; keep it off our pipes.
        subprocess.Popen(["xclip", "-selection", "clipboard"], env=self.env, stdin=subprocess.PIPE,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).communicate(text.encode())

    def get_clipboard(self):
        r = self.run("xclip", "-o", "-selection", "clipboard", check=False)
        return r.stdout if r.returncode == 0 else None

    def windows(self):
        tree = self.run("xwininfo", "-root", "-tree").stdout
        out = []
        for line in tree.splitlines():
            if '("wechat" "wechat")' in line and '"Weixin"' in line:
                wid = line.split()[0]
                size = line.split(")")[-1].split()[0]
                out.append((wid, size))
        return out

    def active(self):
        r = self.run("xprop", "-root", "_NET_ACTIVE_WINDOW")
        return int(r.stdout.strip().split()[-1], 16)

    def assert_active(self):
        if self.window is None:
            return
        active = self.active()
        if active != int(self.window, 16):
            raise Stop(f"focus moved to window {hex(active)}, not the WeChat main window {self.window}")

    def geometry(self):
        info = self.run("xwininfo", "-id", self.window).stdout
        get = lambda k: int(next(l for l in info.splitlines() if k in l).split(":")[1])
        state = next(l for l in info.splitlines() if "Map State" in l).split(":")[1].strip()
        return get("Absolute upper-left X"), get("Absolute upper-left Y"), get("Width"), get("Height"), state

    def shot(self, name):
        path = f"{SHOTS}/{int(T0)}-{name}.png"
        self.run("import", "-window", "root", path)
        return path

    def green(self, shot, box):
        x0, y0, x1, y1 = box
        ox, oy = self.origin
        c = Image.open(shot).convert("RGB").crop((ox + x0, oy + y0, ox + x1, oy + y1))
        return sum(1 for r, g, b in c.getdata() if g > 150 and r < 140 and b < 170 and g - r > 50)

    def match(self, shot, box, ref):
        x0, y0, x1, y1 = box
        ox, oy = self.origin
        got = Image.open(shot).convert("L").crop((ox + x0, oy + y0, ox + x1, oy + y1))
        want = Image.open(os.path.join(REFS, ref))
        hist = ImageChops.difference(got, want).histogram()
        return sum(hist[48:]) / sum(hist)


def reader(*args):
    r = subprocess.run([READER_PY, HELPER, *args], capture_output=True, text=True, timeout=120,
                       env={**os.environ, "HOME": os.path.expanduser("~")})
    return r.returncode, r.stdout, r.stderr.strip()


def store_echoes(since):
    """Self-sent `rome test` lines since `since`, in File Transfer and in the 20
    most recent chats."""
    code, out, err = reader("messages", "--conversation", TARGET, "--since", str(since), "--limit", "50")
    if code != 0:
        raise Stop(f"store read failed (exit {code}): {err}")
    here = [m for m in json.loads(out)["messages"] if m["text"] == BODY]
    code, out, err = reader("messages", "--since", str(since), "--limit", "200")
    elsewhere = [m for m in json.loads(out)["messages"]
                 if code == 0 and m["text"] == BODY and m["conversationId"] != TARGET]
    return here, elsewhere


def preflight(d):
    pids = subprocess.run(["pgrep", "-f", "^/opt/wechat/wechat"], capture_output=True, text=True).stdout.split()
    trace("check.process", pids=pids)
    if not pids:
        raise Stop("not running: no /opt/wechat/wechat process")
    wins = d.windows()
    trace("check.windows", windows=wins)
    if any(size.startswith("280x380") for _, size in wins):
        raise Stop("signed out: the 280x380 login window is present")
    mains = [w for w, size in wins if not size.startswith("280x380")]
    if len(mains) != 1:
        raise Stop(f"expected one WeChat main window, saw {len(mains)}")
    d.window = mains[0]
    code, out, err = reader("check")
    keys_ready = code == 0 and json.loads(out).get("keysReady") is True
    trace("check.store", exit=code, keysReady=keys_ready, err=err[:160] or None)
    if code != 0:
        raise Stop(f"store not readable (exit {code}): signed out or keys no longer fit")


def open_target(d):
    before = d.geometry()
    d.run(d.xdotool, "windowactivate", "--sync", d.window)
    time.sleep(0.8)
    x, y, w, h, state = d.geometry()
    d.origin = (x, y)
    trace("window.activated", window=d.window, before=before[4], after=state, origin=[x, y], size=[w, h],
          active=hex(d.active()))
    if state != "IsViewable" or (w, h) != (880, 640):
        raise Stop(f"main window is {state} at {w}x{h}; the reference crops need a viewable 880x640 window")
    d.assert_active()
    shot = d.shot("1-activated")
    side = d.match(shot, SIDEBAR, "ref-sidebar.png")
    trace("check.sidebar", diff=round(side, 4), shot=shot)
    if side > 0.01:
        raise Stop("the client's sidebar is not drawn: locked, signing in, or covered")

    # Never press Escape here: on the bare main window it opens WeChat's
    # "Log out?" dialog, whose highlighted button is OK.
    d.key("ctrl+f")
    time.sleep(0.4)
    # The search box draws a green outline when it holds focus. Without it,
    # the clear and paste below would land in whatever input has focus.
    shot = d.shot("2-search-focus")
    outline = d.green(shot, SEARCH_BOX)
    trace("check.search_focus", green_px=outline, shot=shot)
    if outline < 20:
        raise Stop("Ctrl+F did not focus the search box; nothing typed")
    d.key("ctrl+a", "BackSpace")  # leftover search text
    d.set_clipboard(QUERY)
    d.key("ctrl+v")
    deadline = time.time() + 6
    while True:
        time.sleep(0.5)
        shot = d.shot("2-search")
        top = d.match(shot, TOPHIT, "ref-tophit.png")
        if top <= 0.01 or time.time() > deadline:
            break
    trace("search.top_hit", query=QUERY, diff=round(top, 4), shot=shot)
    if top > 0.01:
        d.key("ctrl+a", "BackSpace")
        raise Stop("the search's top hit is not the File Transfer feature; Enter not pressed")
    d.key("Return")
    time.sleep(1.2)
    check_header(d, "3-opened")


def check_header(d, name):
    shot = d.shot(name)
    head = d.match(shot, HEADER, "ref-header.png")
    trace("check.header", diff=round(head, 4), shot=shot)
    if head > 0.005:
        raise Stop("the open chat's header is not File Transfer")


def input_text(d):
    """What the message input holds, read by select-all + copy."""
    d.set_clipboard(SENTINEL)
    d.key("ctrl+a")
    d.key("ctrl+c")
    time.sleep(0.3)
    got = d.get_clipboard()
    d.key("End")
    return "" if got == SENTINEL else got


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--send", action="store_true", help="press Enter (otherwise a dry run)")
    p.add_argument("--check", action="store_true", help="readiness checks only")
    p.add_argument("--display", default=os.environ.get("DISPLAY", ":99"))
    a = p.parse_args()
    d = Desktop(a.display)
    trace("start", mode="send" if a.send else "check" if a.check else "dry-run", body=BODY, target=TARGET,
          display=a.display)
    try:
        preflight(d)
        if a.check:
            trace("ready")
            return 0
        since = int(time.time()) - 2
        before, _ = store_echoes(since - 3600)
        trace("store.snapshot", target_rome_test_ids=[m["id"] for m in before])

        open_target(d)
        draft = input_text(d)
        trace("input.before_paste", text=draft)
        if draft:
            raise Stop("the File Transfer input already holds a draft; not touching it")
        d.set_clipboard(BODY)
        d.key("ctrl+v")
        time.sleep(0.3)
        typed = input_text(d)
        trace("input.after_paste", text=typed, exact=typed == BODY)
        if typed != BODY:
            raise Stop(f"the input holds {typed!r}, not {BODY!r}; Enter not pressed")
        check_header(d, "4-before-enter")

        if not a.send:
            d.key("ctrl+a", "Delete")
            left = input_text(d)
            trace("dry_run.cleared", left=left)
            trace("done", sent=False)
            return 0

        d.key("Return")
        sent_at = time.time()
        trace("enter.pressed")
        time.sleep(0.5)
        left = input_text(d)
        trace("input.after_enter", text=left)
        if left:
            raise Stop(f"Enter did not send: input still holds {left!r} (send key may be Ctrl+Enter)")
        d.shot("5-after-enter")

        known = {m["id"] for m in before}
        while True:
            here, elsewhere = store_echoes(since)
            fresh = [m for m in here if m["id"] not in known]
            trace("store.poll", after_s=round(time.time() - sent_at, 1),
                  target=[{k: m[k] for k in ("id", "isSelf", "type", "timestamp")} for m in fresh],
                  elsewhere=[m["conversationId"] for m in elsewhere])
            if elsewhere:
                trace("done", sent=True, confirmed=False, misdelivered_to=[m["conversationId"] for m in elsewhere])
                return 2
            if fresh or time.time() - sent_at > 30:
                break
            time.sleep(2)
        if not fresh:
            trace("done", sent=True, confirmed=False, reason="no echo within 30 s")
            return 2
        self_texts = [m for m in fresh if m["isSelf"] and m["type"] == "text"]
        trace("done", sent=True, confirmed=bool(self_texts), store_ids=[m["id"] for m in fresh],
              echo_count=len(fresh), after_s=round(time.time() - sent_at, 1))
        return 0 if len(self_texts) == 1 else 2
    except Stop as e:
        trace("stopped", reason=str(e))
        return 1


if __name__ == "__main__":
    sys.exit(main())
