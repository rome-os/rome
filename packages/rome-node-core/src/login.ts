import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { cloudOrigin } from "./cloud.js";
import { devicePlatform, deviceSessionFromToken, type DeviceSession } from "./device-session.js";

export type { DeviceSession } from "./device-session.js";
export async function loginDevice(
  cloudUrl: string,
  name: string,
  signal: AbortSignal,
  onAuthorizationRequired: (url: string) => void,
): Promise<DeviceSession> {
  const cloud = new URL(cloudOrigin(cloudUrl));
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Authorization canceled."));
      return;
    }
    let redeeming = false;
    const server = createServer(async (request, response) => {
      const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method !== "GET" ||
        incoming.pathname !== "/callback" ||
        incoming.searchParams.get("state") !== state ||
        incoming.searchParams.get("iss") !== cloud.origin ||
        !incoming.searchParams.get("code") ||
        redeeming
      ) {
        response.writeHead(400).end("Invalid authorization callback");
        return;
      }
      redeeming = true;
      try {
        const result = await fetch(`${cloud.origin}/oauth2/token`, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          redirect: "error",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: "rome-computer",
            redirect_uri: redirectUri,
            code: incoming.searchParams.get("code")!,
            code_verifier: verifier,
            platform: devicePlatform(),
          }),
        });
        if (!result.ok) throw new Error("Token exchange rejected");
        const session = deviceSessionFromToken(await result.json(), cloud.origin);
        if (!session) throw new Error("Invalid token response");
        response
          .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
          .end("Device authorized. Return to Rome Node.");
        resolve(session);
      } catch {
        response
          .writeHead(400)
          .end("Device authorization failed. Return to the application to retry.");
        reject(new Error("Device authorization failed"));
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        server.close();
      }
    });
    let redirectUri: string;
    const abort = () => {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
      reject(new Error("Authorization canceled."));
    };
    const timer = setTimeout(() => {
      server.close();
      signal.removeEventListener("abort", abort);
      reject(new Error("Login timed out"));
    }, 5 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    server.on("error", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Loopback listener failed"));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return;
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const url = new URL("/oauth2/authorize", cloud);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: "rome-computer",
        redirect_uri: redirectUri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state,
        display_name: name,
      }).toString();
      try {
        onAuthorizationRequired(url.toString());
      } catch {
        abort();
      }
    });
  });
}
