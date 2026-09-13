import json
import os
from pathlib import Path


class WebSocketTimeoutException(Exception):
    pass


class Connection:
    def __init__(self):
        self.pending = []
        self.commands = []
        self.scenario = os.environ["CDP_SCENARIO"]
        self.idle_reads = 0
        self.new_page_sent = False
        self.auto_attached_sessions = set()
        self.late_frame_sent = False

    def attached(self, target_id, session_id, waiting=False, target_type="page", parent=None):
        event = {
            "method": "Target.attachedToTarget",
            "params": {
                "sessionId": session_id,
                "targetInfo": {"targetId": target_id, "type": target_type},
                "waitingForDebugger": waiting,
            },
        }
        if parent is not None:
            event["sessionId"] = parent
        return event

    def send(self, raw):
        message = json.loads(raw)
        self.commands.append(message)
        method = message["method"]
        session_id = message.get("sessionId")
        result = {}
        if method == "Target.setAutoAttach":
            self.auto_attached_sessions.add(session_id)
            if session_id is None and self.scenario != "empty":
                self.pending.append(self.attached("existing", "session-existing"))
            elif self.scenario == "nested-iframes":
                children = {
                    "session-existing": "existing-frame",
                    "session-existing-frame": "existing-nested-frame",
                }
                if session_id in children:
                    child = children[session_id]
                    self.pending.append(self.attached(
                        child, "session-" + child, False, "iframe", session_id
                    ))
        elif method == "Target.getTargets":
            result = {
                "targetInfos": [] if self.scenario == "empty" else [
                    {"targetId": "existing", "type": "page"}
                ]
            }
        elif method == "Target.createTarget":
            result = {"targetId": "created"}
            self.pending.append(self.attached("created", "session-created", True))
        elif method == "Target.attachToTarget":
            result = {"sessionId": "session-manual"}
            self.pending.append(self.attached(message["params"]["targetId"], "session-manual"))
        elif (
            self.scenario == "command-timeout"
            and message.get("sessionId") == "session-new"
            and method == "Emulation.setLocaleOverride"
        ):
            self.pending.append(WebSocketTimeoutException("CDP response timed out"))
            return
        elif (
            self.scenario == "nested-iframes"
            and method == "Runtime.runIfWaitingForDebugger"
            and session_id in self.auto_attached_sessions
        ):
            children = {"session-new": "new-frame", "session-new-frame": "new-nested-frame"}
            if session_id in children:
                child = children[session_id]
                self.pending.append(self.attached(
                    child, "session-" + child, True, "iframe", session_id
                ))
        self.pending.append({"id": message["id"], "result": result})

    def recv(self):
        if self.pending:
            message = self.pending.pop(0)
            if isinstance(message, Exception):
                raise message
            return json.dumps(message)
        if self.scenario in {"idle", "command-timeout", "nested-iframes"} and self.idle_reads < 2:
            self.idle_reads += 1
            raise WebSocketTimeoutException("no browser events")
        if not self.new_page_sent:
            self.new_page_sent = True
            return json.dumps(self.attached("new", "session-new", True))
        if (
            self.scenario == "nested-iframes"
            and not self.late_frame_sent
            and "session-existing-frame" in self.auto_attached_sessions
        ):
            self.late_frame_sent = True
            return json.dumps(self.attached(
                "late-nested-frame", "session-late-nested-frame", True,
                "iframe", "session-existing-frame"
            ))
        return ""

    def close(self):
        Path(os.environ["CDP_TRACE_FILE"]).write_text(json.dumps(self.commands))


def create_connection(url, timeout):
    return Connection()
