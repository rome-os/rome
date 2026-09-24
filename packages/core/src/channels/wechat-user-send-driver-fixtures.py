"""Drive the send driver against a scripted fake of the client's accessibility
tree, desktop, store and clock. Nothing here touches a real client."""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
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
                               "conversationName": chat, "isSelf": True, "type": "text", "text": text})
            self.seen += 1

    def chat(self, chat_id, timeout=120):
        self._sync()
        return [m for m in self.lines if m["conversationId"] == chat_id]

    def recent(self, since, timeout=120):
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

    def test_a_store_read_that_raises_after_return_is_no_echo_yet(self):
        client, desk, store, clock = rig()
        chat, fails = store.chat, [2]

        def flaky(chat_id, timeout=120):
            if client.sent and fails[0]:
                fails[0] -= 1
                raise subprocess.TimeoutExpired("wechat-user-helper.py", timeout)
            return chat(chat_id)
        store.chat = flaky
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")
        store.lines, store.seen, client.sent, fails[0] = [], 0, [], 10**6
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))

    def test_an_unexpected_error_after_return_still_answers_typed(self):
        client, desk, store, clock = rig()
        press = desk.press_return

        def press_then_raise():
            press()
            raise subprocess.TimeoutExpired("xdotool", 15)
        desk.press_return = press_then_raise
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.sent, [("File Transfer", "rome test")])

    def test_an_unexpected_error_after_typing_clears_the_input(self):
        client, desk, store, clock = rig()
        client.input.grab_focus = lambda: (_ for _ in ()).throw(LookupError("the node went away"))
        self.assertFails("not-ready", True, lambda: send(client, desk, store, clock))
        self.assertEqual((client.all_inputs()["File Transfer"], client.sent), ("", []))
        self.assertNotIn("Return", desk.events)

    def test_a_lookup_that_fails_before_return_clears_the_input(self):
        client, desk, store, clock = rig()
        extra = FakeNode(client, "text", "Li Wei", editable=True)
        set_text, once = client.input.set_text, [True]

        def type_then_split(s):
            set_text(s)
            if s == "rome test" and once.pop() if once else False:
                client.frame.kids.append(extra)  # a second input shows for a moment
        client.input.set_text = type_then_split
        self.assertFails("wrong-chat", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["File Transfer"], "")
        self.assertNotIn("Return", desk.events)
        client.frame.kids.remove(extra)
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")  # no draft left to block it

    def test_another_chats_draft_is_never_cleared(self):
        client, desk, store, clock = rig()
        client.input.value = "the guardian's own draft"  # in Li Wei, the chat open at the start
        set_text = client.input.set_text

        def type_then_switch(s):
            set_text(s)
            if s == "rome test":
                client.open("Li Wei")  # the chat changes under the typed body
        client.input.set_text = type_then_switch
        self.assertFails("not-ready", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["Li Wei"], "the guardian's own draft")
        self.assertNotIn("Return", desk.events)

    def test_main_answers_an_unexpected_error_as_json(self):
        for argv, answer in ((["send", "--chat", "filehelper", "--name", "File Transfer", "--text", "hi"],
                              {"ok": False, "code": "not-ready", "typed": False}),
                             (["check"], {"ready": False})):
            out = io.StringIO()
            with patch.object(d, "ready_client", side_effect=LookupError("gone")), \
                    patch.object(sys, "argv", ["driver", *argv]), redirect_stdout(out):
                d.main()
            self.assertEqual(json.loads(out.getvalue()), {**answer, "reason": "LookupError: gone"})

    def test_a_chat_open_in_its_own_window_is_not_a_search_result(self):
        client, desk, store, clock = rig()
        bubbles = [FakeNode(client, "list item", "File Transfer", box=(500, 100 + 70 * i, 300, 64))
                   for i in range(2)]
        client.app.kids.append(FakeNode(client, "frame", "Li Wei", [FakeNode(client, "list", "Messages", bubbles)]))
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_a_chat_the_store_names_otherwise_is_refused_before_anything(self):
        client, desk, store, clock = rig()
        store.lines.append({"id": "filehelper:1", "conversationId": "filehelper", "conversationName": "Li Wei",
                            "isSelf": False, "type": "text", "text": "hi"})
        self.assertFails("not-found", False, lambda: send(client, desk, store, clock))
        self.assertEqual((desk.events, client.all_inputs()["Li Wei"]), ([], ""))

    def test_a_chat_the_store_names_the_same_is_sent(self):
        client, desk, store, clock = rig()
        store.lines.append({"id": "filehelper:1", "conversationId": "filehelper",
                            "conversationName": "File Transfer", "isSelf": False, "type": "text", "text": "hi"})
        self.assertEqual(send(client, desk, store, clock), "filehelper:2")

    def test_the_echo_wait_keeps_to_its_budget_when_the_store_hangs(self):
        client, desk, store, clock = rig()
        chat, recent, returned_at = store.chat, store.recent, []

        def hang(read):
            def wrapped(*args, timeout=120):
                if not client.sent:
                    return read(*args)
                returned_at[:] = returned_at or [clock.now]
                clock.now += timeout  # a read that hangs until its timeout
                raise subprocess.TimeoutExpired("wechat-user-helper.py", timeout)
            return wrapped
        store.chat, store.recent = hang(chat), hang(recent)
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertLessEqual(clock.now - returned_at[0], d.ECHO_TIMEOUT_S + 5)

    def test_a_chat_switch_during_cleanup_leaves_the_other_draft(self):
        client, desk, store, clock = rig()
        client.input.value = "the guardian's own draft"  # in Li Wei, the chat open at the start
        failing, text = [], client.input.text

        def grab():
            failing.append(True)
            raise LookupError("the node went away")

        def text_then_switch():
            value = text()
            if failing and client.input.name == "File Transfer":
                client.open("Li Wei")  # the guardian switches chats mid-cleanup
            return value
        client.input.grab_focus, client.input.text = grab, text_then_switch
        self.assertFails("not-ready", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["Li Wei"], "the guardian's own draft")
        self.assertNotIn("Return", desk.events)

    def test_dry_run_reaches_the_input_and_clears_it(self):
        client, desk, store, clock = rig()
        self.assertIsNone(send(client, desk, store, clock, press_return=False))
        self.assertEqual((client.sent, client.all_inputs()["File Transfer"]), ([], ""))
        self.assertNotIn("Return", desk.events)


class ReadinessTests(unittest.TestCase):
    def test_echo_limits_match_the_reader(self):
        spec = importlib.util.spec_from_file_location("helper", HERE / "wechat-user-helper.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        self.assertEqual((d.MAX_TEXT, d.ENVELOPE_MARKERS), (helper.MAX_TEXT, helper.ENVELOPE_MARKERS))

    def test_the_main_window_is_found_by_either_title(self):
        tree = ('  0x1a "{}": ("wechat" "wechat")  880x640+0+0\n'
                '  0x2b "Chrome": ("google-chrome" "Google-chrome")  800x600+0+0\n')
        desk = d.Desktop()
        for title in ("Weixin", "微信"):
            desk._run = lambda *a, t=title: subprocess.CompletedProcess(a, 0, tree.format(t), "")
            self.assertEqual(desk.window(), "0x1a", title)
        desk._run = lambda *a: subprocess.CompletedProcess(a, 0, tree.format("Weixin") * 2, "")
        self.assertIsNone(desk.window())  # two main windows: none is trusted

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

    def run_driver(self, *args):
        """The driver with a PATH whose only pgrep finds no client, so no real
        client on this machine can answer."""
        with tempfile.TemporaryDirectory() as bin_dir:
            (Path(bin_dir) / "pgrep").write_text("#!/bin/sh\nexit 1\n")
            (Path(bin_dir) / "pgrep").chmod(0o755)
            out = subprocess.run([sys.executable, str(HERE / "wechat-user-send-driver.py"), *args],
                                 capture_output=True, text=True, env={**os.environ, "PATH": bin_dir})
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout)

    def test_check_reports_a_missing_client_without_touching_anything(self):
        self.assertEqual(self.run_driver("check"), {"ready": False, "reason": "the WeChat client is not running"})

    def test_send_refuses_a_bad_body_before_anything_else(self):
        for text in ("x" * 4001, " ", "see <msg>x</msg>", '<?xml version="1.0"?>'):
            answer = self.run_driver("send", "--chat", "filehelper", "--name", "File Transfer", "--text", text)
            self.assertEqual((answer["ok"], answer["code"], answer["typed"]), (False, "invalid", False), text)
        for chat, name in (("filehelper", " "), ("", "File Transfer"), (" ", "File Transfer")):
            answer = self.run_driver("send", "--chat", chat, "--name", name, "--text", "hi")
            self.assertEqual(answer["code"], "invalid", (chat, name))


if __name__ == "__main__":
    unittest.main(verbosity=2)
