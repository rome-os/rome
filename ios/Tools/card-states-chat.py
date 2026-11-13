#!/usr/bin/env python3
"""Fills a chat with every card and line the app draws, from the main Chat's own
rows, for looking at the app against a dev stack. Test data only: it copies
rows inside the dev container's database and never touches a real instance.

  1. Make the chat in the app or with the API:
       POST /api/concierge/chats {"name": "zz-all-card-states"}  ->  its id
  2. Run this inside the dev container (never from the host, never on a live DB):
       docker exec -i rome-rome-1 python3 - <chat id> < ios/Tools/card-states-chat.py

It copies the task cards, question and approval cards, forwarded results and a
connect card of the main Chat (every state the stack holds), adds a model
switch of each kind, two stored model errors and cards for tasks that wait or
come later, and keeps the originals' times so a folded card finds its
question. Thread labels are not copied: a task belongs to one Concierge chat.
Run again any time: the copied rows go in once, and the other cards, too.
"""
import json
import sqlite3
import sys
import time
import uuid

DB = "/rome-home/.rome/default/rome.db"
chat_key = sys.argv[1]
db = sqlite3.connect(DB, timeout=30)
db.execute("pragma busy_timeout=30000")
chat = db.execute("select id from chats where key=?", (chat_key,)).fetchone()
if not chat:
    raise SystemExit("no such chat: " + chat_key)
cid = chat[0]
has_rows = db.execute("select count(*) from chat_messages where chat_id=?", (cid,)).fetchone()[0] > 0
main = db.execute("select id from chats where key='concierge'").fetchone()[0]


def wanted(parts):
    kinds = [p.get("type") for p in parts]
    forwarded = any(p.get("forwardedFrom") for p in parts if p.get("type") == "text")
    return "task_chat" in kinds or "connect_card" in kinds or forwarded


copied = 0
newest = 0
for row in ([] if has_rows else db.execute("select * from chat_messages where chat_id=? order by said_at, id", (main,)).fetchall()):
    parts = json.loads(row[8])
    if not wanted(parts):
        continue
    cur = db.execute(
        "insert into chat_messages(chat_id,key,thread_id,sender_account_id,sender_agent,sender_name,text,parts,reply_to_message_id,said_at,chat_thread_id,chat_thread_settled) values(?,?,?,?,?,?,?,?,?,?,?,?)",
        (cid, row[2], row[3], row[4], row[5], row[6], row[7], row[8], None, row[10], None, 0),
    )
    for link in db.execute("select session_id,turn_id,role,input_state from agent_turn_messages where message_id=?", (row[0],)).fetchall():
        db.execute("insert or ignore into agent_turn_messages(message_id,session_id,turn_id,role,input_state) values(?,?,?,?,?)", (cur.lastrowid, chat_key, link[1], link[2], link[3]))
    newest = max(newest, row[10])
    copied += 1


def add(parts):
    global newest
    newest = max(newest, int(time.time()) - 3600) + 60
    db.execute(
        "insert into chat_messages(chat_id,key,thread_id,sender_account_id,sender_agent,sender_name,text,parts,reply_to_message_id,said_at,chat_thread_id,chat_thread_settled) values(?,?,?,?,?,?,?,?,?,?,?,0)",
        (cid, str(uuid.uuid4()), None, "agent:core:concierge", "core:concierge", None, "", json.dumps(parts), None, newest, None),
    )


if not has_rows:
    add([{"type": "quota_switch", "from": "openai", "to": "anthropic", "reason": "quota", "fromModel": "gpt-6-luna", "model": "claude-sonnet-5-5"}])
    add([{"type": "quota_switch", "from": "anthropic", "to": "anthropic", "reason": "model_limit", "fromModel": "claude-opus-5-5[1m]", "model": "claude-sonnet-5-5"}])
    add([{"type": "error", "error": "Codex has reached its usage limit", "code": "model_provider_unavailable", "provider": "openai", "reason": "quota_exhausted"}])
    add([{"type": "error", "error": "All connected model providers have reached their usage limits", "code": "no_model_provider_available", "reason": "quota_exhausted"}])
    # Tasks that wait on their owner, and one that comes later, when the stack has them.
    for task in db.execute("select title, session_id from concierge_tasks where session_id is not null and state in ('needs_user') limit 2").fetchall():
        for show in ("task", "ask"):
            add([{"type": "task_chat", "chatId": task[1], "title": task[0], "show": show}])
    for task in db.execute("select title, session_id from concierge_tasks where session_id is not null and state='watching' limit 1").fetchall():
        add([{"type": "task_chat", "chatId": task[1], "title": task[0], "show": "task"}])


# The other cards, one row each, once: connect cards, cards drawn from data,
# routine drafts, cards only the web draws, and an app card a task asks.
def once(tag, parts):
    key = "zz-other-" + tag
    if db.execute("select 1 from chat_messages where chat_id=? and key=?", (cid, key)).fetchone():
        return
    global newest
    newest = max(newest, db.execute("select coalesce(max(said_at),0) from chat_messages where chat_id=?", (cid,)).fetchone()[0]) + 60
    db.execute(
        "insert into chat_messages(chat_id,key,thread_id,sender_account_id,sender_agent,sender_name,text,parts,reply_to_message_id,said_at,chat_thread_id,chat_thread_settled) values(?,?,?,?,?,?,?,?,?,?,?,0)",
        (cid, key, None, "agent:core:concierge", "core:concierge", None, "", json.dumps(parts), None, newest, None),
    )


def connect(service, label, icon, entry):
    return {"type": "connect_card", "service": service, "label": label, "icon": icon, "connect": entry}


composio = {"kind": "composio", "method": "POST", "path": "/api/apps/connector/connect", "body": {"provider": "gmail"}, "needsLogin": False, "login": {"method": "POST", "path": "/api/apps/connector/login/start"}}
once("connect", [
    connect("github", "GitHub", "brand:github", {"kind": "rome_oauth", "url": "https://romeos.cc/connect/github", "available": True, "unavailableReason": None}),
    connect("slack", "Slack", "brand:slack", {"kind": "rome_oauth", "url": None, "available": False, "unavailableReason": "Rome Cloud cannot connect Slack yet"}),
    connect("gmail", "Gmail", "glyph:gmail", composio),
    connect("notion", "Notion", "glyph:notion", {**composio, "needsLogin": True}),
    connect("stripe", "Stripe", "glyph:stripe", {"kind": "dashboard"}),
])


def ui(*components):
    return {"components": list(components)}


def comp(id_, kind, **props):
    return {"id": id_, "component": kind, **props}


once("widget-stats", [{"type": "widget", "toolUseId": "zz-w1", "appId": "meal-planner", "text": "Today's meals", "bind": {}, "ui": ui(
    comp("root", "Column", children=["title", "stats", "goal"]),
    comp("title", "Text", text="Today", variant="h3"),
    comp("stats", "Row", children=["kcal", "cups"], justify="spaceBetween"),
    comp("kcal", "Stat", label="Energy", value="1,420", unit="kcal"),
    comp("cups", "Stat", label="Water", value="5", unit="cups"),
    comp("goal", "Progress", label="Daily goal", value=1420, max=2000))}])
once("widget-buttons", [{"type": "widget", "toolUseId": "zz-w2", "appId": "meal-planner", "text": "Log water", "bind": {}, "ui": ui(
    comp("root", "Column", children=["title", "row"]),
    comp("title", "Text", text="Drink some water?", variant="h4"),
    comp("row", "Row", children=["yes", "no"]),
    comp("yes", "Button", child="yes-label", action={"event": {"name": "water"}}),
    comp("yes-label", "Text", text="One cup"),
    comp("no", "Button", child="no-label", action={"event": {"name": "skip"}}),
    comp("no-label", "Text", text="Not now"))}])
once("widget-list", [{"type": "widget", "toolUseId": "zz-w3", "appId": "meal-planner", "text": "A list", "bind": {}, "ui": ui(
    comp("root", "Column", children=["title", "items"]),
    comp("title", "Text", text="Shopping list", variant="h3"),
    comp("items", "Column", children=["a", "b", "c"]),
    comp("a", "Text", text="Oat milk"), comp("b", "Text", text="Rice"), comp("c", "Text", text="Green tea", variant="caption"))}])


def draft(key, trigger, watch, then):
    return {"type": "routine_draft_card", "toolUseId": "zz-" + key, "routineKey": "chat-routine:zz-" + key, "draft": {"name": key.title(), "sentence": "", "watchLabel": watch, "thenSummary": then, "trigger": {"type": trigger}, "actionName": "concierge:run_prompt", "args": {}}}


once("routines", [
    draft("schedule", "schedule", "Every Friday at 9:00 AM", "Sum up the week's reading in Chat"),
    draft("event", "event_bus", "Gmail · new email", "Tell you in one line"),
    draft("manual", "manual", "When you run it", "Write the weekly note"),
])
once("webonly", [
    {"type": "pending_interaction", "toolUseId": "zz-ai", "appId": "rome", "render": {"componentId": "ai-tools-card", "builtin": True}},
    {"type": "pending_interaction", "toolUseId": "zz-cs", "appId": "connector", "render": {"componentId": "connect-card", "props": {"toolkit": "gmail"}}},
    {"type": "pending_interaction", "toolUseId": "zz-login", "appId": "connector", "render": {"componentId": "login-card"}},
    {"type": "pending_interaction", "toolUseId": "zz-app", "appId": "habits", "render": {"componentId": "streak"}},
    {"type": "turn_recap", "turnId": "zz-turn", "content": "Done"},
    {"type": "poll_card", "question": "An unknown part"},
])
# A task whose open card is an app's own, answered in its task chat: "Open the task chat to answer".
task = db.execute("select session_id, title from concierge_tasks where session_id is not null and state='done' order by updated_at limit 1").fetchone()
if task:
    chat_row = db.execute("select chat_id from rome_sessions where id=?", (task[0],)).fetchone()
    if chat_row and not db.execute("select 1 from chat_messages where chat_id=? and key='zz-app-ask'", (chat_row[0],)).fetchone():
        db.execute(
            "insert into chat_messages(chat_id,key,thread_id,sender_account_id,sender_agent,sender_name,text,parts,reply_to_message_id,said_at,chat_thread_id,chat_thread_settled) values(?,?,?,?,?,?,?,?,?,?,?,0)",
            (chat_row[0], "zz-app-ask", None, "agent:core:concierge", "core:concierge", None, "", json.dumps([{"type": "pending_interaction", "toolUseId": "zz-app-ask", "appId": "habits", "render": {"kind": "inline", "componentId": "streak"}}]), None, int(time.time()), None),
        )
    for show in ("task", "ask"):
        once("app-ask-" + show, [{"type": "task_chat", "chatId": task[0], "title": task[1], "show": show}])

# Replies the Concierge began on its own: an automated message from before
# marks its turn (it is not drawn), and the reply under it says where it came from.
for kind, name in (("agent:core:main", "Flint"), ("routine:zz-routine", "Daily summary"), ("app:habits", "Habits")):
    key = "zz-other-source-" + kind
    if db.execute("select 1 from chat_messages where chat_id=? and key=?", (cid, key)).fetchone():
        continue
    turn = str(uuid.uuid4())
    newest = max(newest, db.execute("select coalesce(max(said_at),0) from chat_messages where chat_id=?", (cid,)).fetchone()[0]) + 60
    sent = db.execute(
        "insert into chat_messages(chat_id,key,thread_id,sender_account_id,sender_agent,sender_name,text,parts,reply_to_message_id,said_at,chat_thread_id,chat_thread_settled) values(?,?,?,?,?,?,?,?,?,?,?,0)",
        (cid, key, None, "automated::0::" + kind, None, name, "", json.dumps([{"type": "text", "content": "A scheduled check."}]), None, newest, None),
    ).lastrowid
    reply = db.execute(
        "insert into chat_messages(chat_id,key,thread_id,sender_account_id,sender_agent,sender_name,text,parts,reply_to_message_id,said_at,chat_thread_id,chat_thread_settled) values(?,?,?,?,?,?,?,?,?,?,?,0)",
        (cid, key + "-reply", None, "agent:core:concierge", "core:concierge", None, "", json.dumps([{"type": "text", "content": "Nothing needs you today."}]), None, newest + 1, None),
    ).lastrowid
    db.execute("insert or ignore into agent_turn_messages(message_id,session_id,turn_id,role,input_state) values(?,?,?,?,?)", (sent, chat_key, turn, "prompt", "consumed"))
    db.execute("insert or ignore into agent_turn_messages(message_id,session_id,turn_id,role,input_state) values(?,?,?,?,?)", (reply, chat_key, turn, "answer", None))

# A chat sees lines said since it was made.
first = db.execute("select min(said_at) from chat_messages where chat_id=?", (cid,)).fetchone()[0]
db.execute("update rome_sessions set created_at=? where id=?", (first - 3600, chat_key))
db.commit()
print("copied", copied, "cards; the other cards are in")
