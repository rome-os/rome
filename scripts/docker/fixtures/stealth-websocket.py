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

    def attached(self, target_id, session_id, waiting=False):
        return {
            "method": "Target.attachedToTarget",
            "params": {
                "sessionId": session_id,
                "targetInfo": {"targetId": target_id, "type": "page"},
                "waitingForDebugger": waiting,
            },
        }

    def send(self, raw):
        message = json.loads(raw)
        self.commands.append(message)
        method = message["method"]
        result = {}
        if method == "Target.setAutoAttach" and self.scenario != "empty":
            self.pending.append(self.attached("existing", "session-existing"))
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
        self.pending.append({"id": message["id"], "result": result})

    def recv(self):
        if self.pending:
            message = self.pending.pop(0)
            if isinstance(message, Exception):
                raise message
            return json.dumps(message)
        if self.scenario in {"idle", "command-timeout"} and self.idle_reads < 2:
            self.idle_reads += 1
            raise WebSocketTimeoutException("no browser events")
        if not self.new_page_sent:
            self.new_page_sent = True
            return json.dumps(self.attached("new", "session-new", True))
        return ""

    def close(self):
        Path(os.environ["CDP_TRACE_FILE"]).write_text(json.dumps(self.commands))


def create_connection(url, timeout):
    return Connection()
