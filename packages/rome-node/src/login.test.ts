import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { loginDevice } from "./login.js";

const servers: Server[] = [];
afterEach(async () => {
  rs.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("browser authorization callback", () => {
  it("validates state and issuer and exchanges a PKCE verifier without logging the token", async () => {
    let exchanged: URLSearchParams | undefined;
    const token = `romedev_${"x".repeat(43)}`;
    const cloud = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      exchanged = new URLSearchParams(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: token, device_id: "authorized-device" }));
    });
    servers.push(cloud);
    await new Promise<void>((resolve) => cloud.listen(0, "127.0.0.1", resolve));
    const address = cloud.address();
    if (!address || typeof address === "string") throw new Error("Missing Cloud address");
    const origin = `http://127.0.0.1:${address.port}`;
    let printed = "";
    let open!: (url: URL) => void;
    const authorization = new Promise<URL>((resolve) => {
      open = resolve;
    });
    rs.spyOn(process.stderr, "write").mockImplementation((value) => {
      printed += String(value);
      const url = printed.split("\n").find((line) => line.startsWith("http://"));
      if (url) open(new URL(url));
      return true;
    });
    const controller = new AbortController();
    const login = loginDevice(origin, "Test computer", controller.signal);
    try {
      const auth = await authorization;
      const callback = new URL(auth.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({
        code: "one-use-code",
        state: "wrong",
        iss: origin,
      }).toString();
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      callback.searchParams.set("iss", "https://wrong.example");
      expect((await fetch(callback)).status).toBe(400);
      expect(exchanged).toBeUndefined();
      callback.searchParams.set("iss", origin);
      expect((await fetch(callback)).status).toBe(200);
      expect(await login).toEqual({ cloudUrl: origin, token, deviceId: "authorized-device" });
      expect(exchanged?.get("client_id")).toBe("rome-computer");
      expect(
        createHash("sha256").update(exchanged!.get("code_verifier")!).digest("base64url"),
      ).toBe(auth.searchParams.get("code_challenge"));
      expect(printed).not.toContain(token);
    } finally {
      controller.abort();
    }
  });
});
