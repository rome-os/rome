"""Drive the send driver against a scripted fake of the client's accessibility
tree, desktop, store and clock. Nothing here touches a real client."""
import importlib.util
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("driver", HERE / "wechat-user-send-driver.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

SHOWING, FOCUSED, EDITABLE, ACTIVE = d.SHOWING, d.FOCUSED, d.EDITABLE, d.ACTIVE


class FakeNode:
    def __init__(self, client, role, name="", kids=(), editable=False, box=(0, 0, 10, 10), on_click=None):
        self.client, self.role, self.name = client, role, name
        self.kids, self.editable, self.box, self.on_click = list(kids), editable, box, on_click
        self.shown, self.value = True, ""

    def states(self):
        st = {SHOWING} if self.shown else set()
        if self.editable:
            st.add(EDITABLE)
        if self.client.focus is self and self.client.seen_active():
            st.add(FOCUSED)
        if self.role == "frame" and self.client.seen_active():
            st.add(ACTIVE)
        return st

    def children(self):
        if self.client.pending and self is self.client.popup:
            self.client.pending[0] -= 1
            if self.client.pending[0] <= 0:
                self.kids, self.client.pending = self.client.pending[1], None
        return list(self.kids)
    def text(self): return self.value
    def extents(self): return self.box

    def set_text(self, s):
        self.value = s
        self.client.on_text(self)

    def grab_focus(self):
        # Like Qt: GrabFocus answers regardless, but focus only lands while the
        # window is in front.
        if self.client.active:
            self.client.focus = self


class FakeClient:
    """A signed-in client with a chat list, a search box, one open chat, and a
    results popup that lists whatever `results` holds for the query."""

    def __init__(self, contacts=("File Transfer", "Li Wei"), open_chat="Li Wei"):
        self.active, self.stale, self.focus = True, False, None
        self.results = {name: [name] for name in contacts}
        self.pending = None  # [polls until the real results replace recent searches, items]
        self.recent = []  # names in the "Recent Searches" panel shown first
        self.misroute = {}  # clicked result -> the chat that actually opens
        self.search = FakeNode(self, "text", "Search", editable=True)
        self.back = FakeNode(self, "push button", "Back", box=(0, 0, 20, 20), on_click=self.leave_narrow)
        self.chats = FakeNode(self, "list", "Chats")
        self.input = FakeNode(self, "text", open_chat, editable=True)
        self.drafts = {}
        self.frame = FakeNode(self, "frame", "Weixin", [self.search, self.chats, self.back, self.input])
        self.popup = FakeNode(self, "filler")
        self.popup.shown = False
        self.app = FakeNode(self, "application", "wechat", [self.frame, self.popup])
        self.back.shown = False
        self.sent = []  # (chat, text) the fake client delivered

    def seen_active(self):
        # AT-SPI keeps reporting the old focus for a moment after X moved.
        return self.active or self.stale

    def narrow(self):
        self.search.shown = self.chats.shown = False
        self.back.shown = True

    def leave_narrow(self):
        self.search.shown = self.chats.shown = True
        self.back.shown = False

    def row(self, name, y, h, on_click):
        return FakeNode(self, "list item", name, box=(100, y, 200, h), on_click=on_click)

    def on_text(self, node):
        if node is not self.search:
            return
        q, live = node.value, bool(node.value) and self.focus is self.search
        local = [self.row(n, 100 + 70 * i, 64, lambda n=n: self.open(self.misroute.get(n, n)))
                 for i, n in enumerate(self.results.get(q, []))]
        # Every query also lists a web suggestion named after itself.
        web = [self.row(q, 100 + 70 * len(local), 34, self.open_web)]
        recent = [self.row(n, 100 + 40 * i, 38, self.open_web) for i, n in enumerate(self.recent)]
        self.popup.kids, self.popup.shown = (recent, live) if live else ([], False)
        self.pending = [3, local + web] if live else None

    def open_web(self):
        # WeChat opens its web search in a separate window, which takes the front.
        self.search.value, self.popup.kids, self.popup.shown = "", [], False
        self.active = False

    def open(self, chat):
        self.drafts[self.input.name] = self.input.value
        self.input.name, self.input.value = chat, self.drafts.get(chat, "")
        self.search.value, self.popup.kids, self.popup.shown = "", [], False
        self.focus = self.input

    def all_inputs(self):
        return {**self.drafts, self.input.name: self.input.value}


class FakeDesktop:
    def __init__(self, client):
        self.client, self.events = client, []

    def window(self): return "0x1"
    def viewable(self): return True
    def x_active(self): return self.client.active

    def raise_window(self):
        self.events.append("raise")
        self.client.active = True

    def click(self, x, y):
        self.events.append(("click", x, y))
        for node in walk(self.client.app):
            x0, y0, w, h = node.box
            if node.on_click and node.shown and x0 <= x < x0 + w and y0 <= y < y0 + h:
                node.on_click()
                return

    def press_return(self):
        self.events.append("Return")
        c = self.client
        if c.focus is c.input and c.active and c.input.value:
            c.sent.append((c.input.name, c.input.value))
            c.input.value = ""


def walk(node):
    yield node
    for kid in node.kids:
        yield from walk(kid)


class FakeStore:
    """The store as the reader reports it: the client's deliveries become
    self-sent lines after `lag` polls."""

    def __init__(self, client, lag=1, where=None):
        self.client, self.lag, self.where = client, lag, where or {"File Transfer": "filehelper"}
        self.lines = []
        self.seen = 0

    def _sync(self):
        while self.seen < len(self.client.sent):
            if self.lag > 0:
                self.lag -= 1
                return
            chat, text = self.client.sent[self.seen]
            conv = self.where.get(chat, chat)
            self.lines.append({"id": f"{conv}:{len(self.lines) + 1}", "conversationId": conv,
                               "isSelf": True, "type": "text", "text": text})
            self.seen += 1

    def chat(self, chat_id):
        self._sync()
        return [m for m in self.lines if m["conversationId"] == chat_id]

    def recent(self, since):
        self._sync()
        return list(self.lines)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def time(self): return self.now
    def sleep(self, dt): self.now += dt


def rig(**kw):
    client = FakeClient(**kw)
    desk = FakeDesktop(client)
    clock = FakeClock()
    store = FakeStore(client)
    return client, desk, store, clock


def send(client, desk, store, clock, chat="filehelper", name="File Transfer", body="rome test", **kw):
    return d.Driver(client.app, desk, store, clock).send(chat, name, body, **kw)


class SendTests(unittest.TestCase):
    def assertFails(self, code, typed, fn):
        with self.assertRaises(d.Failure) as caught:
            fn()
        self.assertEqual((caught.exception.code, caught.exception.typed), (code, typed), caught.exception.reason)

    def assertOnlyTarget(self, client, name="File Transfer"):
        others = {k: v for k, v in client.all_inputs().items() if k != name and v}
        self.assertEqual(others, {}, "text left in another chat's input")

    def test_sends_and_answers_the_store_id(self):
        client, desk, store, clock = rig()
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")
        self.assertEqual(client.sent, [("File Transfer", "rome test")])
        self.assertEqual([e for e in desk.events if not isinstance(e, tuple)].count("Return"), 1)

    def test_only_return_is_ever_pressed(self):
        client, desk, store, clock = rig()
        send(client, desk, store, clock)
        self.assertEqual({e for e in desk.events if isinstance(e, str)} - {"raise"}, {"Return"})
        source = (HERE / "wechat-user-send-driver.py").read_text()
        self.assertNotIn('"Escape"', source)
        self.assertNotIn("xclip", source)  # the clipboard is never touched
        self.assertNotIn("xsel", source)

    def test_an_earlier_identical_line_is_not_the_confirmation(self):
        client, desk, store, clock = rig()
        store.lines.append({"id": "filehelper:1", "conversationId": "filehelper", "isSelf": True,
                            "type": "text", "text": "rome test"})
        self.assertEqual(send(client, desk, store, clock), "filehelper:2")

    def test_a_recent_search_named_like_the_target_is_not_clicked(self):
        client, desk, store, clock = rig()
        client.recent = ["File Transfer"]
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_only_a_web_suggestion_by_that_name_is_not_found(self):
        client, desk, store, clock = rig(open_chat="File Transfer")
        client.results["File Transfer"] = []
        self.assertFails("not-found", False, lambda: send(client, desk, store, clock))
        self.assertTrue(client.active, "the web suggestion was clicked")

    def test_a_click_that_opens_a_web_window_is_the_wrong_chat_even_if_the_target_is_open(self):
        client, desk, store, clock = rig(open_chat="File Transfer")
        client.misroute["File Transfer"] = None
        client.open = lambda chat: client.open_web() if chat is None else FakeClient.open(client, chat)
        self.assertFails("wrong-chat", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.input.value), ([], ""))

    def test_no_result_by_that_name(self):
        client, desk, store, clock = rig()
        client.results["File Transfer"] = ["File Transfer Assistant"]  # fuzzy, not equal
        self.assertFails("not-found", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.search.value, client.sent), ("", []))
        self.assertNotIn("Return", desk.events)

    def test_two_results_with_that_name(self):
        client, desk, store, clock = rig(contacts=("Li Wei", "File Transfer"))
        client.results["Li Wei"] = ["Li Wei", "Li Wei"]
        self.assertFails("ambiguous", False, lambda: send(client, desk, store, clock, "wxid_li", "Li Wei"))
        self.assertEqual(client.sent, [])

    def test_a_chat_history_hit_does_not_count_as_a_second_result(self):
        client, desk, store, clock = rig()
        client.results["File Transfer"] = ["File Transfer\n3 related messages", "File Transfer"]
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_the_click_opens_another_chat(self):
        client, desk, store, clock = rig()
        client.misroute["File Transfer"] = "Li Wei"
        self.assertFails("wrong-chat", False, lambda: send(client, desk, store, clock))
        self.assertEqual(client.sent, [])
        self.assertOnlyTarget(client)

    def test_a_draft_in_the_target_is_left_alone(self):
        client, desk, store, clock = rig()
        client.drafts["File Transfer"] = "half a thought"
        self.assertFails("not-ready", False, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["File Transfer"], "half a thought")

    def test_focus_lost_before_the_click(self):
        client, desk, store, clock = rig()
        orig = d.Driver.result

        def steal(self, box, name):
            hit = orig(self, box, name)
            client.active = False  # Chrome takes the front
            desk.raise_window = lambda: desk.events.append("raise")  # and keeps it
            return hit
        with patch.object(d.Driver, "result", steal):
            self.assertFails("focus-lost", False, lambda: send(client, desk, store, clock))
        self.assertFalse(any(isinstance(e, tuple) for e in desk.events))
        self.assertEqual(client.sent, [])

    def test_at_spi_lag_alone_does_not_pass_the_front_check(self):
        client, desk, store, clock = rig()
        orig = d.Driver.type_body

        def steal(self, name, body):
            box = orig(self, name, body)
            client.active, client.stale = False, True  # AT-SPI still says focused and active
            return box
        with patch.object(d.Driver, "type_body", steal):
            self.assertFails("focus-lost", True, lambda: send(client, desk, store, clock))
        self.assertNotIn("Return", desk.events)
        self.assertEqual(client.all_inputs()["File Transfer"], "")  # cleared
        self.assertOnlyTarget(client)

    def test_focus_lost_while_results_load_is_retried(self):
        client, desk, store, clock = rig()
        steals = {"n": 1}
        orig = client.on_text

        def flaky(node):
            orig(node)
            if node is client.search and node.value and steals["n"]:
                steals["n"] -= 1
                client.active = False
        client.on_text = flaky
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_a_narrow_window_goes_back_to_the_list(self):
        client, desk, store, clock = rig()
        client.narrow()
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_leftover_search_text_is_replaced(self):
        client, desk, store, clock = rig()
        client.search.value = "zzqx"
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_no_echo_within_the_window(self):
        client, desk, store, clock = rig()
        store.lag = 10**6
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertGreaterEqual(clock.now - 1000, d.ECHO_TIMEOUT_S)

    def test_return_that_does_not_send_clears_the_input(self):
        client, desk, store, clock = rig()
        desk.press_return = lambda: desk.events.append("Return")  # e.g. Ctrl+Enter sends
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["File Transfer"], "")

    def test_an_echo_in_another_chat_is_a_misdelivery(self):
        client, desk, store, clock = rig()
        store.where = {"File Transfer": "wxid_other"}
        self.assertFails("misdelivered", True, lambda: send(client, desk, store, clock))

    def test_dry_run_reaches_the_input_and_clears_it(self):
        client, desk, store, clock = rig()
        self.assertIsNone(send(client, desk, store, clock, press_return=False))
        self.assertEqual((client.sent, client.all_inputs()["File Transfer"]), ([], ""))
        self.assertNotIn("Return", desk.events)


class ReadinessTests(unittest.TestCase):
    def test_signed_in_client_is_ready(self):
        client, desk, _, _ = rig()
        d.readiness(client.app, desk)

    def test_no_chat_list_is_not_ready(self):
        client, desk, _, _ = rig()
        client.frame.kids = [client.search, client.input]  # the login or lock view
        with self.assertRaises(d.Failure) as caught:
            d.readiness(client.app, desk)
        self.assertEqual(caught.exception.code, "not-ready")

    def test_a_minimized_window_is_still_ready(self):
        client, desk, _, _ = rig()
        client.frame.shown = False
        desk.viewable = lambda: False
        d.readiness(client.app, desk)

    def test_check_reports_a_missing_client_without_touching_anything(self):
        env = {**os.environ, "PATH": str(HERE / "no-such-bin") + ":/usr/bin:/bin"}
        out = subprocess.run([sys.executable, str(HERE / "wechat-user-send-driver.py"), "check"],
                             capture_output=True, text=True, env=env)
        self.assertEqual(json.loads(out.stdout)["ready"], False, out.stderr)

    def test_send_refuses_a_body_over_the_limit_before_anything_else(self):
        out = subprocess.run([sys.executable, str(HERE / "wechat-user-send-driver.py"), "send",
                              "--chat", "filehelper", "--name", "File Transfer", "--text", "x" * 4001],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)
        self.assertEqual(out.stdout, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
