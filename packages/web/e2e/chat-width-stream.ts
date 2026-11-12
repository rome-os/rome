import type { Page } from "@playwright/test";

declare global {
  interface Window {
    chatWidthStream: {
      ready: boolean;
      push(text: string): void;
      finish(): void;
    };
  }
}

/** 测试只模拟读取与 SSE，不发送真实 turn，未声明的写入必须失败。 */
export async function installWidthStream(page: Page) {
  await page.context().route("**/api/**", (route) => {
    if (["GET", "HEAD"].includes(route.request().method())) return route.continue();
    return route.fulfill({ status: 503, json: { error: "Synthetic write rejection" } });
  });
  await page.addInitScript(() => {
    const sessionId = "mock-chat-long-answers";
    const turnId = "width-turn";
    const originalFetch = window.fetch.bind(window);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let text = "";
    const encode = (event: string, data: unknown) =>
      new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    window.chatWidthStream = {
      ready: false,
      push(value) {
        text = value;
        controller!.enqueue(encode("assistant_text", { blockIx: 0, text }));
      },
      finish() {
        finished = true;
        controller!.enqueue(encode("done", {}));
        controller!.close();
      },
    };
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.origin)
        .pathname;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (path.startsWith("/api/") && !["GET", "HEAD"].includes(method)) {
        return path.endsWith("/read")
          ? Response.json({ success: true })
          : Response.json({ error: "Synthetic write rejection" }, { status: 503 });
      }
      if (path === `/api/chat/sessions/${sessionId}/turns`) {
        return Response.json(
          finished
            ? []
            : [
                {
                  turnId,
                  streamId: turnId,
                  startedAt: "2026-06-01T10:00:00.000Z",
                  status: "running",
                },
              ],
        );
      }
      if (path === `/api/chat/turns/${turnId}/stream`) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              window.chatWidthStream.ready = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      const response = await originalFetch(input, init);
      if (finished && path === `/api/chat/sessions/${sessionId}/messages`) {
        const body = await response.json();
        const saved = {
          id: "width-answer",
          sessionId,
          turnId,
          role: "assistant",
          content: JSON.stringify([{ type: "text", blockIx: 0, content: text }]),
          createdAt: "2026-06-01T10:00:01.000Z",
        };
        return Response.json(
          Array.isArray(body) ? [...body, saved] : { ...body, messages: [...body.messages, saved] },
        );
      }
      return response;
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method, url, ...args) {
      if (!["GET", "HEAD"].includes(method.toUpperCase())) {
        throw new Error("Unexpected XHR write: " + url);
      }
      return Reflect.apply(open, this, [method, url, ...args]);
    } as typeof open;
  });
}
