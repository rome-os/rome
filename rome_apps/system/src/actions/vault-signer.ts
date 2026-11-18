import { request } from "node:http";

/** The vault lives in the signer, reached over the unix socket Rome passes to its action workers. */
const NO_SIGNER_MESSAGE = "The vault needs the signer, which is not running on this instance.";

export function signerRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const socketPath = process.env.ROME_SIGNER_SOCKET?.trim();
  if (!socketPath) return Promise.reject(new Error(NO_SIGNER_MESSAGE));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode ?? 502,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch {
          reject(new Error(NO_SIGNER_MESSAGE));
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => reject(new Error(NO_SIGNER_MESSAGE)));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
