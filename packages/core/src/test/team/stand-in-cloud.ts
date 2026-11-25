// A stand-in for Rome Cloud's two visitor-grant endpoints, on a loopback port.
// `/instance/authorize` plays the browser already signed in to Rome Cloud as
// `account`: it issues a code bound to the PKCE challenge and redirects back.
// `/api/account/session` redeems the code for that account only when the
// verifier matches the challenge. Every other path answers 503.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { allowVerifierServer } from "./network.js";

export interface CloudAccount {
  accountId: string;
  email: string;
}

export interface StandInCloud {
  origin: string;
  /** The account the next authorize signs in as. */
  signInAs(account: CloudAccount): void;
  close(): Promise<void>;
}

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function startStandInCloud(): Promise<StandInCloud> {
  let account: CloudAccount | null = null;
  const codes = new Map<string, { challenge: string; account: CloudAccount }>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    if (req.method === "GET" && url.pathname === "/instance/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (!account || !redirectUri || !state || !challenge) {
        res.writeHead(400).end();
        return;
      }
      const code = randomBytes(16).toString("base64url");
      codes.set(code, { challenge, account });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/account/session") {
      const body = await readJson(req);
      const code = typeof body?.code === "string" ? body.code : "";
      const verifier = typeof body?.code_verifier === "string" ? body.code_verifier : "";
      const grant = codes.get(code);
      codes.delete(code);
      if (!grant || challengeOf(verifier) !== grant.challenge) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          accountId: grant.account.accountId,
          email: grant.account.email,
          favorViewerToken: `favor-${grant.account.accountId}`,
          avatarUrl: null,
        }),
      );
      return;
    }
    res.writeHead(503).end();
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => res.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stand-in cloud has no port");
  const disallow = allowVerifierServer(address.port);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    signInAs(next) {
      account = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        disallow();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
