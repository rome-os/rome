"""PROTOTYPE: a stand-in for at-spi-bus-launcher, which this image lacks and
whose config path (/usr/share/defaults/at-spi2) is not writable here.

It starts a private accessibility bus under /tmp/a11y and claims org.a11y.Bus
on the session bus, answering IsEnabled=true. Qt's AT-SPI bridge watches the
session bus for that name, so an already running WeChat connects to the new
bus on its own: no restart, no environment change.

    python3 a11y_bus.py --background   # set up, start, and detach
    python3 a11y_bus.py                # run in the foreground
Stop it with: pkill -f a11y_bus.py; pkill -f 'dbus-daemon --config-file=/tmp/a11y'
"""
import os
import subprocess
import sys
import time
import urllib.request
import zipfile

KIT = os.path.dirname(os.path.abspath(__file__))
WORK = "/tmp/a11y"
BUS_PATH = f"{WORK}/bus"
A11Y_ADDR = f"unix:path={BUS_PATH}"
DEB = "https://deb.debian.org/debian/pool/main/a/at-spi2-core/at-spi2-core_2.46.0-5_amd64.deb"
JEEPNEY = ("https://files.pythonhosted.org/packages/b2/a3/e137168c9c44d18eff0376253da9f1e9234d0239e0ee230d2fee6cea8e55/"
           "jeepney-0.9.0-py3-none-any.whl")


def setup():
    os.makedirs(f"{WORK}/services", exist_ok=True)
    registryd = f"{WORK}/root/usr/libexec/at-spi2-registryd"
    if not os.path.exists(registryd):
        urllib.request.urlretrieve(DEB, f"{WORK}/at-spi2-core.deb")
        subprocess.run(["dpkg-deb", "-x", f"{WORK}/at-spi2-core.deb", f"{WORK}/root"], check=True)
    if not os.path.exists(f"{WORK}/py/jeepney"):
        urllib.request.urlretrieve(JEEPNEY, f"{WORK}/jeepney.whl")
        zipfile.ZipFile(f"{WORK}/jeepney.whl").extractall(f"{WORK}/py")
    with open(f"{KIT}/accessibility.conf") as src, open(f"{WORK}/accessibility.conf", "w") as dst:
        dst.write(src.read())
    with open(f"{WORK}/services/org.a11y.atspi.Registry.service", "w") as f:
        f.write(f"[D-BUS Service]\nName=org.a11y.atspi.Registry\nExec={registryd}\n")


def serve():
    sys.path.insert(0, f"{WORK}/py")
    from jeepney import MessageType, HeaderFields, new_method_return, new_error
    from jeepney.io.blocking import open_dbus_connection
    from jeepney.bus_messages import message_bus

    if not os.path.exists(BUS_PATH):
        subprocess.Popen(["dbus-daemon", f"--config-file={WORK}/accessibility.conf", "--nofork", "--print-address"],
                         stdout=open(f"{WORK}/dbus-daemon.log", "w"), stderr=subprocess.STDOUT,
                         start_new_session=True)
        for _ in range(50):
            if os.path.exists(BUS_PATH):
                break
            time.sleep(0.1)
    conn = open_dbus_connection(bus="SESSION")
    reply = conn.send_and_get_reply(message_bus.RequestName("org.a11y.Bus", 4))  # DO_NOT_QUEUE
    print("RequestName org.a11y.Bus ->", reply.body, "a11y bus", A11Y_ADDR, flush=True)
    if reply.body[0] != 1:
        sys.exit("org.a11y.Bus is already owned")
    props = {"IsEnabled": ("b", True), "ScreenReaderEnabled": ("b", False)}
    while True:
        msg = conn.receive()
        h = msg.header
        if h.message_type != MessageType.method_call:
            continue
        iface, member = h.fields.get(HeaderFields.interface), h.fields.get(HeaderFields.member)
        print(time.strftime("%H:%M:%S"), "call", h.fields.get(HeaderFields.sender), iface, member, msg.body,
              flush=True)
        if member == "GetAddress":
            conn.send(new_method_return(msg, "s", (A11Y_ADDR,)))
        elif iface == "org.freedesktop.DBus.Properties" and member == "Get":
            conn.send(new_method_return(msg, "v", (props.get(msg.body[1], ("b", False)),)))
        elif iface == "org.freedesktop.DBus.Properties" and member == "GetAll":
            conn.send(new_method_return(msg, "a{sv}", (props,)))
        elif iface == "org.freedesktop.DBus.Peer" and member == "Ping":
            conn.send(new_method_return(msg))
        else:
            conn.send(new_error(msg, "org.freedesktop.DBus.Error.UnknownMethod", "s", (f"{iface}.{member}",)))


if __name__ == "__main__":
    setup()
    if "--background" in sys.argv:
        running = subprocess.run(["pgrep", "-f", "a11y_bus.py$"], capture_output=True, text=True).stdout.split()
        if running:
            print("already running:", running)
            sys.exit(0)
        subprocess.Popen([sys.executable, os.path.abspath(__file__)], stdout=open(f"{WORK}/a11y_bus.log", "a"),
                         stderr=subprocess.STDOUT, start_new_session=True,
                         env={**os.environ, "DBUS_SESSION_BUS_ADDRESS": os.environ.get(
                             "DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/999/bus")})
        time.sleep(2)
        print(open(f"{WORK}/a11y_bus.log").read()[-400:])
    else:
        serve()
