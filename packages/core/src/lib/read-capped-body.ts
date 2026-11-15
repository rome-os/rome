// A request body read with a size cap.

/**
 * The request body as text, or undefined once it passes `max` bytes. Reads
 * the stream, so a chunked body with no Content-Length stops at the cap too.
 */
export async function readCappedBody(request: Request, max: number): Promise<string | undefined> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
