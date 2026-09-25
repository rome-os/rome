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
        t0 = time.time()
        subprocess.run([XDO, "windowactivate", "--sync", chrome], env=XENV)
        t_x = time.time() - t0
        while d.ACTIVE in frame.states() and time.time() - t0 < 3:
            time.sleep(0.005)
        results.append({"trial": trial, "x_switch_ms": round(t_x * 1000), "atspi_inactive_ms": round((time.time() - t0) * 1000)})
        trace("lag", **results[-1])
    ms = sorted(r["atspi_inactive_ms"] for r in results)
    trace("lag.summary", trials=len(ms), min=ms[0], median=ms[len(ms) // 2], max=ms[-1])
    return 0


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("survey")
    s.add_argument("--contact", required=True)
    lg = sub.add_parser("lag")
    lg.add_argument("--trials", type=int, default=20)
    a = p.parse_args()
    return {"survey": survey, "lag": lag}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
