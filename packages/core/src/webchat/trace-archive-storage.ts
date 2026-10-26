import { traceArchiveSessionKey } from "./trace-archive-paths.js";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { getInstanceToken } from "../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../lib/rome-cloud-origin.js";
import type { ArchiveFile } from "./trace-archive-worker.js";

const uploadResponse = z.object({
  url: z.url(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  objectKey: z.string().min(1),
  expiresAt: z.string(),
});

export class TraceArchiveStorage {
  private notHosted = false;
  private abort = new AbortController();

  stop() {
    this.abort.abort();
  }
  constructor(
    private readonly options: {
      fetch?: typeof fetch;
      token?: () => string | null;
      origin?: () => string | null;
    } = {},
  ) {}

  private async request(method: string, route: string, body: unknown): Promise<Response | null> {
    const token = (this.options.token ?? getInstanceToken)();
    if (!token || this.notHosted) return null;
    const origin = (this.options.origin ?? getRomeCloudOrigin)();
    if (!origin) throw new Error("Trace archive Cloud origin unavailable");
    const response = await (this.options.fetch ?? fetch)(
      new URL(`/api/instance/trace-archives${route}`, origin),
      {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
      },
    );
    if (
      response.status === 403 &&
      (
        await response
          .clone()
          .json()
          .catch(() => null)
      )?.error === "not_hosted"
    ) {
      this.notHosted = true;
      return null;
    }
    if (!response.ok) throw new Error(`Trace archive Cloud request failed (${response.status})`);
    return response;
  }

  /** Returns null only for local instances, never for a transient Cloud failure. */
  async store(
    file: string,
    data: ArchiveFile,
    onRemoteTarget?: (location: string) => void,
  ): Promise<string | null> {
    const response = await this.request("POST", "/upload-url", {
      sessionId: traceArchiveSessionKey(data.manifest.sessionId),
      archiveId: data.manifest.archiveId,
      bytes: data.bytes,
      md5: data.md5,
    });
    if (!response) return null;
    const upload = uploadResponse.parse(await response.json());
    onRemoteTarget?.(`s3:${upload.objectKey}`);
    const stream = createReadStream(file);
    try {
      const put = await (this.options.fetch ?? fetch)(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        duplex: "half",
        redirect: "error",
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15 * 60_000)]),
      } as RequestInit);
      if (!put.ok) throw new Error(`Trace archive PUT failed (${put.status})`);
      await put.body?.cancel();
    } finally {
      stream.destroy();
    }
    return `s3:${upload.objectKey}`;
  }

  /** A missing token cannot confirm deletion of an object uploaded with an earlier token. */
  async deleteSession(sessionId: string, remoteRequired: boolean): Promise<void> {
    if (!remoteRequired) return;
    if (!(this.options.token ?? getInstanceToken)())
      throw new Error("Trace archive deletion awaits instance token");
    const response = await this.request("DELETE", "", {
      sessionId: traceArchiveSessionKey(sessionId),
    });
    if (!response) throw new Error("Trace archive remote deletion not confirmed");
    const result = await response.json().catch(() => null);
    if (!z.object({ deleted: z.number().int().nonnegative() }).safeParse(result).success) {
      throw new Error("Trace archive remote deletion not confirmed");
    }
  }
}
