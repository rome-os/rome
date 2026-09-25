"""Send keys through the AT-SPI registry's DeviceEventController on the given a11y bus."""
import sys, time
sys.path.insert(0, "/tmp/a11y/py")
from jeepney import DBusAddress, new_method_call
from jeepney.io.blocking import open_dbus_connection
KEY_SYM = 3  # AtspiKeySynthType: keycode argument is a keysym
def keys(bus, keysyms):
    conn = open_dbus_connection(bus)
    dec = DBusAddress("/org/a11y/atspi/registry/deviceeventcontroller", "org.a11y.atspi.Registry",
                      "org.a11y.atspi.DeviceEventController")
    for ks in keysyms:
        r = conn.send_and_get_reply(new_method_call(dec, "GenerateKeyboardEvent", "isu", (ks, "", KEY_SYM)), timeout=5)
        print("GenerateKeyboardEvent", hex(ks), "->", r.header.message_type.name, r.body)
if __name__ == "__main__":
    keys(sys.argv[1], [int(k, 0) for k in sys.argv[2:]])
