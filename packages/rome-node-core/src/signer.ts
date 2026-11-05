import { request } from "node:http";
import { isRecord } from "./actions.js";

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** True for a compact JWS of at most 2048 characters, the shape Rome Cloud accepts. */
export function isJwt(value: string): boolean {
  return value.length <= 2048 && JWT_SHAPE.test(value);
}

export class SignerError extends Error {
  constructor(readonly code: "signer_unavailable" | "rate_limited") {
    super(
      code === "rate_limited"
        ? "The signer is rate limited."
        : "The signing service is not running.",
    );
  }
}

function signerCall(socketPath: string, method: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", () => reject(new SignerError("signer_unavailable")));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            return;
          } catch {}
        }
        reject(new SignerError(res.statusCode === 429 ? "rate_limited" : "signer_unavailable"));
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => reject(new SignerError("signer_unavailable")));
    req.end();
  });
}

/** Asks the signer for a fresh token. Tokens live 60 seconds, so request one per Cloud call. */
export async function requestSignerToken(socketPath: string): Promise<string> {
  const body = await signerCall(socketPath, "POST", "/v1/token");
  if (!isRecord(body) || typeof body.token !== "string" || !isJwt(body.token))
    throw new SignerError("signer_unavailable");
  return body.token;
}

/** Returns the thumbprint of the signer's key. */
export async function signerHealth(socketPath: string): Promise<{ jkt: string }> {
  const body = await signerCall(socketPath, "GET", "/v1/health");
  if (!isRecord(body) || body.ok !== true || typeof body.jkt !== "string")
    throw new SignerError("signer_unavailable");
  return { jkt: body.jkt };
}
