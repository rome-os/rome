#!/usr/bin/env python3
"""Launch the WeChat client under gdb and capture the store passphrase.

Runs directly inside the Rome container (Rome spawns it as a local subprocess),
so client and databases are plain container paths. The passphrase is derived
once during the first login; launching arms the breakpoint before any code runs
and re-arms it after every exec (new_objfile), so that first login is caught
without a second. Results go to a file (gdb's stdout is buffered and lost on
terminate) and also print on stdout as `PASSPHRASE <hex>`.
"""
import os
import subprocess
import signal
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wcdb_key_tool as tool  # noqa: E402

WECHAT = "/opt/wechat/wechat"
# HOME must match the store the Rome runtime reads.
HOME = os.environ["HOME"]
RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR", "/run/user/%d" % os.getuid())

GDB_SCRIPT = r"""
set pagination off
set non-stop off
set follow-fork-mode parent
set detach-on-fork on
handle SIGPWR SIG32 SIG33 SIG34 SIG35 SIG36 SIG37 SIG38 SIG39 SIG40 nostop noprint pass
handle SIG41 SIG42 SIG43 SIG44 SIG45 SIG46 SIG47 SIG48 nostop noprint pass
handle SIGXCPU SIGXFSZ SIGWINCH nostop noprint pass
handle SIGSEGV SIGBUS SIGILL SIGFPE nostop noprint pass
python
import gdb

HOOK_VA = {hook_va}
RESULT = "{result}"
_bp = {{"cur": None}}

def emit(s):
    with open(RESULT, "a") as f:
        f.write(s + "\n")
        f.flush()

class CaptureBreakpoint(gdb.Breakpoint):
    def stop(self):
        try:
            rsi = int(gdb.parse_and_eval("$rsi"))
            rdx = int(gdb.parse_and_eval("$rdx"))
            if rsi and rdx == 32:
                raw = gdb.selected_inferior().read_memory(rsi, 32).tobytes()
                emit("WECHAT_PASSPHRASE=" + raw.hex())
                gdb.execute("detach"); gdb.execute("quit"); return True
            if rsi:
                size_val = int(gdb.parse_and_eval("*(unsigned long long*)($rsi+16)"))
                if size_val == 32:
                    key_ptr = int(gdb.parse_and_eval("*(unsigned long long*)($rsi+8)"))
                    if key_ptr:
                        raw = gdb.selected_inferior().read_memory(key_ptr, 32).tobytes()
                        emit("WECHAT_PASSPHRASE=" + raw.hex())
                        gdb.execute("detach"); gdb.execute("quit"); return True
        except Exception as e:
            emit("CAPTURE_ERROR=" + str(e))
        return False

def wechat_base(pid):
    for line in open("/proc/%d/maps" % pid):
        parts = line.split()
        if len(parts) >= 6 and parts[5].endswith("/wechat"):
            return int(parts[0].split("-")[0], 16)
    return None

def arm(_evt=None):
    inf = gdb.selected_inferior()
    if not inf or not inf.pid:
        return
    base = wechat_base(inf.pid)
    if base is None:
        return
    addr = base + HOOK_VA
    try:
        inf.read_memory(addr, 4)
    except Exception:
        return
    if _bp["cur"] is not None:
        try: _bp["cur"].delete()
        except Exception: pass
    _bp["cur"] = CaptureBreakpoint("*%d" % addr)
    emit("BP_SET=0x%X base=0x%X" % (addr, base))

gdb.events.new_objfile.connect(arm)
emit("GDB_READY")
end
starti
python arm()
continue
quit
"""


def capture(directory):
    result_file = os.path.join(directory, "capture.result")
    gdb_log = os.path.join(directory, "gdb.log")
    open(result_file, "x").close()
    hook_va = tool.find_hook_offset(WECHAT)
    with open(result_file, "a") as f:
        f.write("hook_va=0x%X\n" % hook_va)
        f.flush()

    with tempfile.NamedTemporaryFile("w", suffix=".gdb", dir=directory, delete=False) as f:
        f.write(GDB_SCRIPT.format(hook_va=hook_va, result=result_file))
        script_path = f.name

    env = {
        **os.environ, "DISPLAY": os.environ.get("DISPLAY", ":99"), "HOME": HOME,
        "QT_QPA_PLATFORM": "xcb", "LIBGL_ALWAYS_SOFTWARE": "1",
        "XDG_RUNTIME_DIR": RUNTIME_DIR,
        "DBUS_SESSION_BUS_ADDRESS": "unix:path=%s/bus" % RUNTIME_DIR,
    }
    timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    # Own the client from birth: no client may already be running, or gdb would
    # not be the one that launched it and would miss the first-login derivation.
    subprocess.run(["pkill", "-x", "wechat"], capture_output=True)
    subprocess.run(["pkill", "-x", "WeChatAppEx"], capture_output=True)
    time.sleep(3)

    proc = subprocess.Popen(
        ["gdb", "-q", "--nx", "-batch", "-x", script_path, "--args", WECHAT],
        stdout=open(gdb_log, "w"), stderr=subprocess.STDOUT, env=env, cwd="/opt/wechat",
    )
    try:
        return wait_for_capture(proc, result_file, timeout)
    finally:
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def wait_for_capture(proc, result_file, timeout):
    deadline = time.time() + timeout
    passphrase = None
    while time.time() < deadline and proc.poll() is None:
        for line in open(result_file):
            if line.startswith("WECHAT_PASSPHRASE="):
                passphrase = line.split("=", 1)[1].strip()
        if passphrase:
            break
        time.sleep(2)
    if proc.poll() is None:
        proc.terminate()
    # gdb writes the passphrase and exits in the same instant it fires, so the
    # poll loop can end (proc gone) before its next read. Read the file once more
    # before giving up — the value is durable on disk even when the race is lost.
    if passphrase is None:
        for line in open(result_file):
            if line.startswith("WECHAT_PASSPHRASE="):
                passphrase = line.split("=", 1)[1].strip()
    if passphrase:
        print("PASSPHRASE " + passphrase)
        return
    print("ERROR no passphrase captured", file=sys.stderr)
    sys.exit(5)


def main():
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise SystemExit(5)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    # The staged driver already lives in a private directory under /run.
    with tempfile.TemporaryDirectory(prefix="capture-", dir=os.path.dirname(__file__)) as directory:
        capture(directory)


if __name__ == "__main__":
    main()
