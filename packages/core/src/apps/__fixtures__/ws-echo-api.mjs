// Test fixture: a minimal app API module that accepts a WebSocket upgrade on
// `/live` and echoes messages back. Plain `.mjs` so the dispatcher's raw
// `import()` loads it without a TS transform.
//
// It reads the host upgrade bridge off the request symbol directly — exactly
// what `@rome-os/app-runtime`'s `upgradeWebSocket` does internally (that helper
// is unit-tested separately in app-runtime-sdk). Inlining it here keeps the
// fixture free of a bare-specifier import, which the test runner's dynamic-import
// wrapper stalls on.
const WS_UPGRADE_ACCEPT = Symbol.for("rome-os.app-runtime.ws.accept");

export function createApiHandler() {
  return {
    async handle(req) {
      const accept = req[WS_UPGRADE_ACCEPT];
      if (req.path[0] === "live" && typeof accept === "function") {
        return accept({
          open: (ws) => ws.send("ready"),
          message: (ws, data) => ws.send(`echo:${data}`),
          close: () => {},
        });
      }
      // A path that does NOT accept the upgrade — the host must reject with 426.
      return Response.json({ ok: true });
    },
  };
}
