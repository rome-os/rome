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
    def __init__(self, client, role, name="", kids=(), editable=False):
        self.client, self.role, self.name = client, role, name
        self.kids, self.editable = list(kids), editable
        self.shown, self.value, self.current = True, "", False

    def states(self):
        c = self.client
        if c.pending and self is c.list:  # one countdown per poll: a poll's walk reads this once
            c.pending[0] -= 1
            if c.pending[0] <= 0:
                c.set_rows(c.pending[1])
                c.pending = None
        st = {SHOWING} if self.shown else set()
        if self.editable:
            st.add(EDITABLE)
        if (self.client.focus is self or self.current) and self.client.seen_active():
            st.add(FOCUSED)
        if self.role == "frame" and self.client.seen_active():
            st.add(ACTIVE)
        return st

    def children(self):
        c = self.client
        if self is c.list and c.vanish:
            c.vanish -= 1
            raise LookupError("a row went away")
        return list(self.kids)

    def text(self): return self.value

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
    search popup: a header, local results, then web suggestions. Down and Up
    move the current result, skipping headers; the tree reports it `focused`
    only once a key has moved it."""

    def __init__(self, contacts=("File Transfer", "Li Wei"), open_chat="Li Wei"):
        self.active, self.stale, self.focus = True, False, None
        self.results = {name: [name] for name in contacts}
        self.headers = {"File Transfer": "Features"}
        self.pending, self.vanish, self.recent, self.stale_polls = None, 0, [], 3
        self.start_at = None  # a current row left over from an earlier query (seen live in round 3)
        self.misroute = {}  # result -> the chat that actually opens (None: a web window)
        self.search = FakeNode(self, "text", "Search", editable=True)
        self.chats = FakeNode(self, "list", "Chats")
        self.input = FakeNode(self, "text", open_chat, editable=True)
        self.drafts = {}
        self.frame = FakeNode(self, "frame", "Weixin", [self.search, self.chats, self.input])
        self.list = FakeNode(self, "list")
        self.popup = FakeNode(self, "filler", kids=[self.list])
        self.popup.shown = False
        self.app = FakeNode(self, "application", "wechat", [self.frame, self.popup])
        self.rows, self.cur = [], None  # [(name, kind)], index of the current row
        self.sent, self.leaked = [], []

    def seen_active(self):
        return self.active or self.stale  # AT-SPI keeps the old focus a moment after X moved

    def set_rows(self, rows):
        self.rows = rows
        self.list.kids = [FakeNode(self, "list item", n) for n, _ in rows]
        pickable = [i for i, (_, kind) in enumerate(rows) if kind != "header"]
        self.cur = pickable[0] if pickable else None  # current, but not reported until moved
        if self.start_at is not None and self.start_at < len(rows):
            self.cur = self.start_at

    def on_text(self, node):
        if node is not self.search:
            return
        q, live = node.value, bool(node.value) and self.focus is self.search
        local = self.results.get(q, [])
        rows = ([(self.headers.get(q, "Contacts"), "header")] + [(n, "local") for n in local] if local else []) \
            + [("Internet search results", "header"), (q, "web"), (f"{q} meaning", "web")]
        recent = [("Search Results", "header"), ("Recent Searches", "header")] + [(n, "web") for n in self.recent]
        self.set_rows(recent if live else [])
        self.popup.shown = live
        self.pending = [self.stale_polls, rows] if live else None

    def key(self, name):
        if not self.active:  # the key lands in whatever else holds X focus
            self.leaked.append(name)
            return
        if self.focus is self.search and self.popup.shown and self.cur is not None:
            if name in ("Down", "Up"):
                step = 1 if name == "Down" else -1
                i = self.cur + step
                while 0 <= i < len(self.rows) and self.rows[i][1] == "header":
                    i += step
                if 0 <= i < len(self.rows):
                    self.cur = i
                for k, node in enumerate(self.list.kids):
                    node.current = k == self.cur
            elif name == "Return":
                n, kind = self.rows[self.cur]
                target = self.misroute.get(n, n) if kind == "local" else None
                self.open_web() if target is None else self.open(target)
        elif name == "Return" and self.focus is self.input and self.input.value:
            self.sent.append((self.input.name, self.input.value))
            self.input.value = ""

    def open_web(self):
        # WeChat opens its web search in a separate window, which takes the front.
        self.close_popup()
        self.active = False

    def close_popup(self):
        self.search.value, self.popup.shown, self.pending = "", False, None
        self.set_rows([])

    def open(self, chat):
        self.drafts[self.input.name] = self.input.value
        self.input.name, self.input.value = chat, self.drafts.get(chat, "")
        self.close_popup()
        self.focus = self.input

    def all_inputs(self):
        return {**self.drafts, self.input.name: self.input.value}


class FakeDesktop:
    def __init__(self, client):
        self.client, self.events, self.can_activate = client, [], True

    def window(self): return "0x1"
    def x_active(self): return self.client.active

    def activate(self):
        self.events.append("activate")
        if self.can_activate:
            self.client.active = True

    def key(self, name):
        assert name in d.KEYS, name
        self.events.append(name)
        self.client.key(name)


class FakeStore:
    """The store as the reader reports it: the client's deliveries become
    self-sent lines after `lag` polls, stamped `skew` seconds behind the host."""

    def __init__(self, client, clock, lag=1, where=None, skew=0):
        self.client, self.clock, self.lag, self.skew = client, clock, lag, skew
        self.where = where or {"File Transfer": "filehelper"}
        self.lines, self.seen = [], 0

    def _sync(self):
        while self.seen < len(self.client.sent):
            if self.lag > 0:
                self.lag -= 1
                return
            chat, text = self.client.sent[self.seen]
            conv = self.where.get(chat, chat)
            self.lines.append({"id": f"{conv}:{len(self.lines) + 1}", "conversationId": conv,
                               "conversationName": chat, "isSelf": True, "type": "text", "text": text,
                               "timestamp": int(self.clock.now) - self.skew})
            self.seen += 1

    def chat(self, chat_id, timeout):
        self._sync()
        return [m for m in self.lines if m["conversationId"] == chat_id]

    def recent(self, since, timeout):
        self._sync()
        return [m for m in self.lines if m.get("timestamp", since) >= since]


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def time(self): return self.now
    def sleep(self, dt): self.now += dt


def rig(skew=0, **kw):
    client = FakeClient(**kw)
    clock = FakeClock()
    return client, FakeDesktop(client), FakeStore(client, clock, skew=skew), clock


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
        self.assertEqual(desk.events, ["Down", "Up", "Return", "Return"])

    def test_only_down_up_and_return_are_ever_pressed(self):
        self.assertEqual(d.KEYS, ("Down", "Up", "Return"))
        with self.assertRaises(ValueError):
            d.Desktop().key("Escape")
        source = (HERE / "wechat-user-send-driver.py").read_text()
        self.assertNotIn('"Escape"', source)
        for tool in ("xclip", "xsel", "mousemove", "click"):
            self.assertNotIn(tool, source)  # no clipboard, no pointer

    def test_an_earlier_identical_line_is_not_the_confirmation(self):
        client, desk, store, clock = rig()
        store.lines.append({"id": "filehelper:1", "conversationId": "filehelper", "isSelf": True,
                            "type": "text", "text": "rome test", "timestamp": 1})
        self.assertEqual(send(client, desk, store, clock), "filehelper:2")

    def test_a_recent_search_named_like_the_target_is_not_opened(self):
        client, desk, store, clock = rig()
        client.recent = ["File Transfer"]
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_a_long_lived_recent_search_panel_is_not_read_as_the_results(self):
        client, desk, store, clock = rig()
        client.recent, client.stale_polls = ["Li Wei"], 8  # the old panel stays for a while
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_a_current_row_left_on_a_web_suggestion_is_not_opened(self):
        client, desk, store, clock = rig(open_chat="File Transfer")
        client.results["Li Wei"] = ["Li Wei Senior"]  # the local hit is someone else
        client.start_at = 3  # the web suggestion named "Li Wei" is current from before
        self.assertFails("not-found", False, lambda: send(client, desk, store, clock, "wxid_li", "Li Wei"))
        self.assertTrue(client.active, "the web suggestion was opened")
        self.assertEqual(client.sent, [])

    def test_only_a_web_suggestion_by_that_name_is_not_found(self):
        client, desk, store, clock = rig(open_chat="File Transfer")
        client.results["File Transfer"] = []
        self.assertFails("not-found", False, lambda: send(client, desk, store, clock))
        self.assertTrue(client.active, "the web suggestion was opened")
        self.assertNotIn("Return", desk.events)
        self.assertEqual(client.search.value, "")

    def test_a_return_that_opens_a_web_window_is_the_wrong_chat_even_if_the_target_is_open(self):
        client, desk, store, clock = rig(open_chat="File Transfer")
        client.misroute["File Transfer"] = None
        self.assertFails("wrong-chat", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.input.value), ([], ""))

    def test_no_local_result_by_that_name(self):
        client, desk, store, clock = rig()
        client.results["File Transfer"] = ["File Transfer Assistant"]  # fuzzy, not equal
        self.assertFails("not-found", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.search.value, client.sent), ("", []))

    def test_two_local_results_with_that_name(self):
        client, desk, store, clock = rig()
        client.results["Li Wei"] = ["Li Wei", "Li Wei"]
        self.assertFails("ambiguous", False, lambda: send(client, desk, store, clock, "wxid_li", "Li Wei"))
        self.assertEqual((client.sent, desk.events), ([], []))

    def test_a_same_named_row_after_the_web_section_is_ambiguous(self):
        client, desk, store, clock = rig()
        on_text = client.on_text

        def with_a_later_section(node):
            on_text(node)
            if client.pending:  # e.g. a group of that name listed after "More"
                client.pending[1] = client.pending[1] + [("More", "header"), ("File Transfer", "local")]
        client.on_text = with_a_later_section
        self.assertFails("ambiguous", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.search.value), ([], ""))
        self.assertNotIn("Return", desk.events)

    def test_results_are_not_judged_on_the_web_suggestion_alone(self):
        client, desk, store, clock = rig()
        on_text, children, later, polls = client.on_text, client.list.children, [], [0]

        def web_first(node):
            on_text(node)
            if client.pending:  # the web section shows before the local ones load
                later.append(client.pending[1])
                client.pending = [client.pending[0], [r for r in later[0] if r[1] != "local"][1:]]

        def local_later():
            if later and client.rows and client.rows[0][0] == "Internet search results":
                polls[0] += 1
                if polls[0] >= 12:  # stable well past the settle window, then the rest
                    client.set_rows(later.pop())
            return children()
        client.on_text, client.list.children = web_first, local_later
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_a_same_named_row_that_loads_during_the_keys_is_ambiguous(self):
        client, desk, store, clock = rig()
        key = client.key

        def key_then_load(name):
            key(name)
            if name == "Up" and client.focus is client.search:  # a late section appears
                client.set_rows(client.rows + [("Group Chats", "header"), ("File Transfer", "local")])
                client.cur = 1
                for k, node in enumerate(client.list.kids):
                    node.current = k == 1
        client.key = key_then_load
        self.assertFails("ambiguous", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.search.value), ([], ""))
        self.assertNotIn("Return", desk.events)

    def test_a_slow_send_is_confirmed_by_the_store(self):
        client, desk, store, clock = rig()
        key = client.key

        def slow_return(name):
            if name == "Return" and client.focus is client.input and client.input.value:
                client.sent.append((client.input.name, client.input.value))  # sent, input not yet cleared
                return
            key(name)
        client.key, store.lag = slow_return, 3
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")
        self.assertEqual(client.all_inputs()["File Transfer"], "")  # the leftover copy is cleared

    def test_a_focus_loss_at_return_leaves_no_query_in_the_search_box(self):
        client, desk, store, clock = rig()
        key = client.key

        stolen = []

        def steal_after_up(name):
            key(name)
            if name == "Up" and client.focus is client.search:
                stolen.append(True)  # X focus moves before Return; the tree lags behind
        client.key = steal_after_up
        desk.x_active = lambda: client.active and not stolen
        self.assertFails("focus-lost", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.search.value), ([], ""))
        self.assertNotIn("Return", desk.events)

    def test_a_repeat_send_to_a_recently_searched_contact_waits_for_the_results(self):
        client, desk, store, clock = rig()
        client.recent, client.stale_polls = ["File Transfer"], 8  # listed by the earlier send's search
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")
        self.assertEqual(client.sent, [("File Transfer", "rome test")])

    def test_a_recent_panel_that_never_gives_way_is_not_acted_on(self):
        client, desk, store, clock = rig()
        client.recent, client.stale_polls = ["File Transfer"], 10**6
        self.assertFails("not-ready", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.search.value), ([], ""))
        self.assertFalse({"Down", "Up", "Return"} & set(desk.events))

    def test_a_lookup_error_after_return_is_not_read_as_a_closed_list(self):
        client, desk, store, clock = rig()
        key = client.key

        def return_then_unreadable(name):
            in_search = client.focus is client.search
            key(name)
            if name == "Return" and in_search:
                client.popup.shown, client.vanish = True, 10**6  # still up, but unreadable
        client.key = return_then_unreadable
        self.assertFails("wrong-chat", False, lambda: send(client, desk, store, clock))
        self.assertEqual(client.sent, [])

    def test_results_without_a_web_section_never_settle_and_are_not_ready(self):
        client, desk, store, clock = rig()
        on_text = client.on_text

        def offline(node):  # no web section: offline, or an interface whose header differs
            on_text(node)
            if client.pending:
                client.pending[1] = [r for r in client.pending[1]
                                     if r[1] != "web" and r[0] != "Internet search results"]
        client.on_text = offline
        with self.assertRaises(d.Failure) as caught:
            send(client, desk, store, clock)
        self.assertEqual((caught.exception.code, caught.exception.typed), ("not-ready", False))
        self.assertIn("no search results panel appeared", caught.exception.reason)
        self.assertIn("interface language", caught.exception.reason)
        self.assertEqual((client.sent, client.search.value), ([], ""))
        self.assertFalse({"Down", "Up", "Return"} & set(desk.events))

    def test_results_that_keep_changing_say_so(self):
        client, desk, store, clock = rig()
        children, polls = client.list.children, [0]

        def churning():  # a real results panel whose rows never stop changing
            kids = children()
            if client.rows and client.rows[0][0] != "Search Results":
                polls[0] += 1
                client.set_rows(client.rows[:-1] + [(f"File Transfer {polls[0]}", "web")])
            return kids
        client.list.children = churning
        with self.assertRaises(d.Failure) as caught:
            send(client, desk, store, clock)
        self.assertEqual(caught.exception.code, "not-ready")
        self.assertIn("kept changing", caught.exception.reason)
        self.assertNotIn("no search results panel", caught.exception.reason)
        self.assertEqual(client.sent, [])

    def test_any_error_while_choosing_leaves_no_query_behind(self):
        client, desk, store, clock = rig()
        states, reads = client.search.states, [0]

        def unreadable_mid_search():
            if client.search.value:
                reads[0] += 1
                if reads[0] > 3:
                    raise LookupError("the search box went away")
            return states()
        client.search.states = unreadable_mid_search
        self.assertFails("not-ready", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.search.value), ([], ""))

    def test_the_same_text_sent_elsewhere_does_not_hide_the_echo(self):
        client, desk, store, clock = rig()
        key = client.key

        def return_and_same_text_elsewhere(name):
            key(name)
            if name == "Return" and client.sent:  # "ok" sent to another chat from the phone
                store.lines.append({"id": "wxid_other:1", "conversationId": "wxid_other",
                                    "conversationName": "Li Wei", "isSelf": True, "type": "text",
                                    "text": "rome test", "createTime": int(clock.now)})
        client.key = return_and_same_text_elsewhere
        answer = send(client, desk, store, clock)
        self.assertEqual(answer, [m["id"] for m in store.lines if m["conversationId"] == "filehelper"][-1])

    def test_a_copy_elsewhere_with_no_echo_is_a_misdelivery(self):
        client, desk, store, clock = rig()
        store.where = {"File Transfer": "wxid_other"}
        self.assertFails("misdelivered", True, lambda: send(client, desk, store, clock))

    def test_a_chat_history_hit_does_not_count_as_a_second_result(self):
        client, desk, store, clock = rig()
        client.results["File Transfer"] = ["File Transfer", "File Transfer\n3 related messages"]
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_the_return_opens_another_chat(self):
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

    def test_a_focus_steal_before_a_key_is_caught_and_retried(self):
        client, desk, store, clock = rig()
        orig, steals = d.Driver.guard, [1]

        def steal_then_check(self, name, focused):
            if steals and name == "Down":
                steals.pop()
                client.active = False  # another client takes the front just before the key
            return orig(self, name, focused)
        with patch.object(d.Driver, "guard", steal_then_check):
            self.assertEqual(send(client, desk, store, clock), "filehelper:1")
        self.assertEqual(client.leaked, [])  # the check caught it: no key reached the other window
        self.assertIn("activate", desk.events)

    def test_a_steal_that_cannot_be_undone_stops_before_any_key(self):
        client, desk, store, clock = rig()
        desk.can_activate = False
        client.active = False
        self.assertFails("focus-lost", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.leaked, client.sent), ([], []))

    def test_at_spi_lag_alone_does_not_pass_the_front_check(self):
        client, desk, store, clock = rig()
        orig = d.Driver.type_body

        def steal(self, name, body):
            orig(self, name, body)
            client.active, client.stale = False, True  # AT-SPI still says focused and active
            desk.can_activate = False
        with patch.object(d.Driver, "type_body", steal):
            self.assertFails("focus-lost", True, lambda: send(client, desk, store, clock))
        self.assertEqual((client.leaked, client.all_inputs()["File Transfer"]), ([], ""))
        self.assertOnlyTarget(client)

    def test_a_minimized_window_gets_one_activate_request(self):
        client, desk, store, clock = rig()
        client.active = False
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")
        self.assertEqual(desk.events[0], "activate")

    def test_focus_lost_while_results_load_is_retried(self):
        client, desk, store, clock = rig()
        steals = [1]
        orig = client.on_text

        def flaky(node):
            orig(node)
            if node is client.search and node.value and steals:
                steals.pop()
                client.active = False
        client.on_text = flaky
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")
        self.assertEqual(client.leaked, [])

    def test_a_row_that_vanishes_mid_read_is_read_again(self):
        client, desk, store, clock = rig()
        client.vanish = 2
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
        client_key = client.key
        client.key = lambda name: None if client.focus is client.input else client_key(name)
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["File Transfer"], "")

    def test_an_echo_in_another_chat_is_a_misdelivery(self):
        client, desk, store, clock = rig()
        store.where = {"File Transfer": "wxid_other"}
        self.assertFails("misdelivered", True, lambda: send(client, desk, store, clock))

    def test_a_misdelivery_is_found_when_the_host_clock_runs_ahead(self):
        client, desk, store, clock = rig(skew=5)  # WeChat stamps lines 5 s behind the host
        store.where = {"File Transfer": "wxid_other"}
        self.assertFails("misdelivered", True, lambda: send(client, desk, store, clock))

    def test_a_store_read_that_raises_after_return_is_no_echo_yet(self):
        client, desk, store, clock = rig()
        chat, fails = store.chat, [2]

        def flaky(chat_id, timeout):
            if client.sent and fails[0]:
                fails[0] -= 1
                raise subprocess.TimeoutExpired("wechat-user-helper.py", timeout)
            return chat(chat_id, timeout)
        store.chat = flaky
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_an_unexpected_error_after_return_still_answers_typed(self):
        client, desk, store, clock = rig()
        key = desk.key

        def press_then_raise(name):
            key(name)
            if client.sent:
                raise subprocess.TimeoutExpired("xdotool", 15)
        desk.key = press_then_raise
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.sent, [("File Transfer", "rome test")])

    def test_an_unexpected_error_after_typing_clears_the_input(self):
        client, desk, store, clock = rig()
        client.input.grab_focus = lambda: (_ for _ in ()).throw(LookupError("the node went away"))
        self.assertFails("not-ready", True, lambda: send(client, desk, store, clock))
        self.assertEqual((client.all_inputs()["File Transfer"], client.sent), ("", []))

    def test_a_lookup_that_fails_before_return_clears_the_input(self):
        client, desk, store, clock = rig()
        extra = FakeNode(client, "text", "Li Wei", editable=True)
        set_text, once = client.input.set_text, [True]

        def type_then_split(s):
            set_text(s)
            if s == "rome test" and once:
                once.pop()
                client.frame.kids.append(extra)  # a second input shows for a moment
        client.input.set_text = type_then_split
        self.assertFails("wrong-chat", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["File Transfer"], "")
        self.assertEqual(client.sent, [])
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
        self.assertEqual(client.sent, [])

    def test_a_chat_switch_during_cleanup_leaves_the_other_draft(self):
        client, desk, store, clock = rig()
        client.input.value = "the guardian's own draft"
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

    def test_a_chat_open_in_its_own_window_is_not_a_search_result(self):
        client, desk, store, clock = rig()
        bubbles = [FakeNode(client, "list item", "File Transfer") for _ in range(2)]
        client.app.kids.insert(1, FakeNode(client, "frame", "Li Wei", [FakeNode(client, "list", "Messages", bubbles)]))
        self.assertEqual(send(client, desk, store, clock), "filehelper:1")

    def test_a_chat_the_store_names_otherwise_is_refused_before_anything(self):
        client, desk, store, clock = rig()
        store.lines.append({"id": "filehelper:1", "conversationId": "filehelper", "conversationName": "Li Wei",
                            "isSelf": False, "type": "text", "text": "hi", "timestamp": 1})
        self.assertFails("not-found", False, lambda: send(client, desk, store, clock))
        self.assertEqual(desk.events, [])

    def test_a_chat_the_store_names_the_same_is_sent(self):
        client, desk, store, clock = rig()
        store.lines.append({"id": "filehelper:1", "conversationId": "filehelper", "conversationName": "File Transfer",
                            "isSelf": False, "type": "text", "text": "hi", "timestamp": 1})
        self.assertEqual(send(client, desk, store, clock), "filehelper:2")

    def test_the_reads_before_the_send_share_one_deadline(self):
        client, desk, store, clock = rig()
        timeouts, start = [], clock.now

        def slow_chat(chat_id, timeout):
            timeouts.append(timeout)
            clock.now += 15  # a slow first read
            return []

        def hang(since, timeout):
            timeouts.append(timeout)
            clock.now += timeout  # a read that hangs until its timeout
            raise subprocess.TimeoutExpired("wechat-user-helper.py", timeout)
        store.chat, store.recent = slow_chat, hang
        self.assertFails("not-ready", False, lambda: send(client, desk, store, clock))
        self.assertEqual(timeouts, [d.PRESEND_TIMEOUT_S, d.PRESEND_TIMEOUT_S - 15])
        self.assertLessEqual(clock.now - start, d.PRESEND_TIMEOUT_S + 1)
        self.assertEqual(desk.events, [])

    def test_the_echo_wait_keeps_to_its_budget_when_the_store_hangs(self):
        client, desk, store, clock = rig()
        chat, recent, returned_at = store.chat, store.recent, []

        def hang(read):
            def wrapped(*args, timeout):
                if not client.sent:
                    return read(*args, timeout)
                returned_at[:] = returned_at or [clock.now]
                clock.now += timeout
                raise subprocess.TimeoutExpired("wechat-user-helper.py", timeout)
            return wrapped
        store.chat, store.recent = hang(chat), hang(recent)
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertLessEqual(clock.now - returned_at[0], d.ECHO_TIMEOUT_S + 5)

    def test_a_settled_target_below_another_result_is_ambiguous(self):
        client, desk, store, clock = rig(open_chat="File Transfer")
        client.results["Li Wei"] = ["Li Wei Zhang", "Li Wei"]  # ranked above the target, for good
        self.assertFails("ambiguous", False, lambda: send(client, desk, store, clock, "wxid_li", "Li Wei"))
        # Decided from the settled ranking: no key is pressed.
        self.assertEqual((client.sent, client.search.value, desk.events), ([], "", []))

    def test_focus_that_lands_off_a_correct_ranking_is_not_ready(self):
        client, desk, store, clock = rig()
        key = client.key

        def keys_then_focus_elsewhere(name):
            key(name)
            if name == "Up" and client.focus is client.search:  # the ranking is right; focus is not
                client.cur = next(i for i, (_, kind) in enumerate(client.rows) if kind == "web")
                for k, node in enumerate(client.list.kids):
                    node.current = k == client.cur
        client.key = keys_then_focus_elsewhere
        self.assertFails("not-ready", False, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.search.value), ([], ""))
        self.assertNotIn("Return", desk.events)

    def test_a_settled_target_in_a_nonlocal_section_is_ambiguous(self):
        client, desk, store, clock = rig(open_chat="File Transfer")
        client.headers["Li Wei"] = "More"  # listed, but in a section that holds no chat of ours
        self.assertFails("ambiguous", False, lambda: send(client, desk, store, clock, "wxid_li", "Li Wei"))
        self.assertEqual((client.sent, client.search.value), ([], ""))
        self.assertNotIn("Return", desk.events)

    def test_results_that_change_under_the_keys_are_still_not_ready(self):
        client, desk, store, clock = rig()
        key = client.key

        def reshuffle(name):
            key(name)
            if name == "Up":  # the list is rebuilt without the web section
                client.set_rows([r for r in client.rows if r[1] != "web"])
        client.key = reshuffle
        self.assertFails("not-ready", False, lambda: send(client, desk, store, clock))
        self.assertNotIn("Return", desk.events)

    def test_a_leftover_with_the_newline_return_added_is_cleared(self):
        client, desk, store, clock = rig()
        client_key = client.key

        def ctrl_enter_to_send(name):  # Return adds a line break instead of sending
            if name == "Return" and client.focus is client.input:
                client.input.value += "\n"
                return
            client_key(name)
        client.key = ctrl_enter_to_send
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertEqual((client.sent, client.all_inputs()["File Transfer"]), ([], ""))

    def test_a_longer_leftover_is_not_cleared(self):
        client, desk, store, clock = rig()
        client_key = client.key

        def guardian_kept_typing(name):
            if name == "Return" and client.focus is client.input:
                client.input.value += "\nand more"
                return
            client_key(name)
        client.key = guardian_kept_typing
        self.assertFails("no-echo", True, lambda: send(client, desk, store, clock))
        self.assertEqual(client.all_inputs()["File Transfer"], "rome test\nand more")

    def test_a_dry_run_never_presses_return_in_the_input(self):
        client, desk, store, clock = rig()
        driver = d.Driver(client.app, desk, store, clock)
        self.assertIsNone(driver.send("filehelper", "File Transfer", "rome test", press_return=False))
        with self.assertRaises(AssertionError):
            driver.press("File Transfer", "rome test")  # the dry run refuses the one Return that sends
        self.assertEqual((desk.events, client.sent), (["Down", "Up", "Return"], []))

    def test_a_dry_run_that_cannot_clear_the_input_says_so(self):
        client, desk, store, clock = rig()
        set_text = client.input.set_text
        client.input.set_text = lambda s: None if s == "" else set_text(s)  # the clear is lost
        self.assertFails("not-ready", True, lambda: send(client, desk, store, clock, press_return=False))
        self.assertEqual(client.sent, [])

    def test_dry_run_reaches_the_input_and_clears_it(self):
        client, desk, store, clock = rig()
        self.assertIsNone(send(client, desk, store, clock, press_return=False))
        self.assertEqual((client.sent, client.all_inputs()["File Transfer"]), ([], ""))
        self.assertEqual(desk.events, ["Down", "Up", "Return"])  # the Return opens the chat only


class ReadinessTests(unittest.TestCase):
    def test_echo_limits_match_the_reader(self):
        spec = importlib.util.spec_from_file_location("helper", HERE / "wechat-user-helper.py")
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        self.assertEqual((d.MAX_TEXT, d.ENVELOPE_MARKERS), (helper.MAX_TEXT, helper.ENVELOPE_MARKERS))

    def test_no_active_window_is_not_active(self):
        desk = d.Desktop()
        out = {"xprop": "_NET_ACTIVE_WINDOW:  not found.\n",
               "xwininfo": '  0x1a "Weixin": ("wechat" "wechat")  1280x800+0+0\n'}
        desk._run = lambda *a: subprocess.CompletedProcess(a, 0, out[a[0]], "")
        self.assertFalse(desk.x_active())
        out["xprop"] = "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1a\n"
        self.assertTrue(desk.x_active())

    def test_the_main_window_is_found_by_either_title(self):
        tree = ('  0x1a "{}": ("wechat" "wechat")  1280x800+0+0\n'
                '  0x2b "Chrome": ("google-chrome" "Google-chrome")  800x600+0+0\n')
        desk = d.Desktop()
        for title in ("Weixin", "微信"):
            desk._run = lambda *a, t=title: subprocess.CompletedProcess(a, 0, tree.format(t), "")
            self.assertEqual(desk.window(), "0x1a", title)
        desk._run = lambda *a: subprocess.CompletedProcess(a, 0, tree.format("Weixin") * 2, "")
        self.assertIsNone(desk.window())

    def test_a_signed_in_client_is_found(self):
        client, _, _, _ = rig()
        self.assertIs(d.main_frame(client.app), client.frame)

    def test_the_login_window_is_never_the_main_window(self):
        client, _, _, _ = rig()
        back = FakeNode(client, "push button", "Back")
        back.shown = False  # the login tool bar's hidden Back button
        client.frame.kids = [FakeNode(client, "tool bar", kids=[back]), FakeNode(client, "push button", "Enter Weixin")]
        with self.assertRaises(d.Failure) as caught:
            d.main_frame(client.app)
        self.assertEqual(caught.exception.code, "not-ready")

    def test_a_minimized_main_window_is_still_found(self):
        client, _, _, _ = rig()
        client.active = False  # minimized: not active, and its nodes still report showing
        self.assertIs(d.main_frame(client.app), client.frame)

    def run_driver(self, *args):
        """The driver with a PATH whose only pgrep finds no client."""
        with tempfile.TemporaryDirectory() as bin_dir:
            (Path(bin_dir) / "pgrep").write_text("#!/bin/sh\nexit 1\n")
            (Path(bin_dir) / "pgrep").chmod(0o755)
            return subprocess.run([sys.executable, str(HERE / "wechat-user-send-driver.py"), *args],
                                  capture_output=True, text=True, env={**os.environ, "PATH": bin_dir})

    def test_check_reports_a_missing_client_without_touching_anything(self):
        out = self.run_driver("check")
        self.assertEqual((out.returncode, json.loads(out.stdout)),
                         (0, {"ready": False, "reason": "the WeChat client is not running"}))

    def test_send_refuses_a_bad_body_before_anything_else(self):
        for text in ("x" * 4001, " ", "see <msg>x</msg>", '<?xml version="1.0"?>'):
            out = self.run_driver("send", "--chat", "filehelper", "--name", "File Transfer", "--text", text)
            answer = json.loads(out.stdout)
            self.assertEqual((answer["ok"], answer["code"], answer["typed"]), (False, "invalid", False), text)
        for chat, name in (("filehelper", " "), ("", "File Transfer"), (" ", "File Transfer")):
            self.assertEqual(json.loads(self.run_driver("send", "--chat", chat, "--name", name,
                                                        "--text", "hi").stdout)["code"], "invalid")

    def test_argparse_errors_exit_2_as_documented(self):
        out = self.run_driver("send", "--chat", "filehelper")
        self.assertEqual((out.returncode, out.stdout), (2, ""))
        self.assertIn("exit 2", d.__doc__)

    def main_with(self, client, desk, store, *argv):
        out = io.StringIO()
        ok = subprocess.CompletedProcess(["pgrep"], 0, "", "")
        with patch.object(d, "wechat_app", return_value=client.app), patch.object(d, "Desktop", return_value=desk), \
                patch.object(d, "Store", return_value=store), patch.object(d.subprocess, "run", return_value=ok), \
                patch.object(d, "time", FakeClock()), patch.object(sys, "argv", ["driver", *argv]), \
                redirect_stdout(out):
            d.main()
        return json.loads(out.getvalue())

    def test_check_is_ready_on_the_verified_english_interface(self):
        client, desk, store, _ = rig()
        self.assertEqual(self.main_with(client, desk, store, "check"), {"ready": True, "reason": "ready"})

    def test_check_is_not_ready_on_an_unverified_interface_language(self):
        client, desk, store, _ = rig()
        client.search.name, client.chats.name = "搜索", "聊天"  # the Chinese interface
        answer = self.main_with(client, desk, store, "check")
        self.assertFalse(answer["ready"])
        self.assertIn("interface language", answer["reason"])
        send_answer = self.main_with(client, desk, store, "send", "--chat", "filehelper",
                                     "--name", "File Transfer", "--text", "rome test")
        self.assertEqual((send_answer["ok"], send_answer["code"]), (False, "not-ready"))
        self.assertEqual((desk.events, client.sent), ([], []))

    def test_send_dry_run_flag_types_and_clears_without_sending(self):
        client, desk, store, clock = rig()
        answer = self.main_with(client, desk, store, "send", "--dry-run", "--chat", "filehelper",
                                "--name", "File Transfer", "--text", "rome test")
        self.assertEqual(answer, {"ok": True, "dryRun": True, "conversationId": "filehelper"})
        self.assertEqual((desk.events, client.sent, client.all_inputs()["File Transfer"]),
                         (["Down", "Up", "Return"], [], ""))

    def test_main_answers_an_unexpected_error_as_json(self):
        for argv, answer in ((["send", "--chat", "filehelper", "--name", "File Transfer", "--text", "hi"],
                              {"ok": False, "code": "not-ready", "typed": False}),
                             (["check"], {"ready": False})):
            out = io.StringIO()
            with patch.object(d, "ready_client", side_effect=LookupError("gone")), \
                    patch.object(sys, "argv", ["driver", *argv]), redirect_stdout(out):
                d.main()
            self.assertEqual(json.loads(out.getvalue()), {**answer, "reason": "LookupError: gone"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
