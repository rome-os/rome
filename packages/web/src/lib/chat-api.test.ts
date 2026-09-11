import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { postSessionTurn } from "./chat-api";

afterEach(() => {
  rs.unstubAllGlobals();
});

describe("postSessionTurn", () => {
  it("preserves structured model resolution errors from the server", async () => {
    rs.stubGlobal(
      "fetch",
      rs.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Selected model provider is unavailable: Codex",
            code: "model_provider_unavailable",
            provider: "openai",
            reason: "not_logged_in",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(postSessionTurn("session-1", new FormData())).resolves.toEqual({
      ok: false,
      status: 409,
      message: "Selected model provider is unavailable: Codex",
      code: "model_provider_unavailable",
      provider: "openai",
      reason: "not_logged_in",
    });
  });

  it("reports multipart upload progress through XMLHttpRequest", async () => {
    class FakeXMLHttpRequest {
      static current: FakeXMLHttpRequest | null = null;

      readonly upload = {
        onprogress: null as ((event: ProgressEvent) => void) | null,
        onload: null as (() => void) | null,
      };
      status = 0;
      responseText = "";
      withCredentials = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      method = "";
      url = "";
      body: Document | XMLHttpRequestBodyInit | null = null;

      constructor() {
        FakeXMLHttpRequest.current = this;
      }

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }

      send(body: Document | XMLHttpRequestBodyInit | null) {
        this.body = body;
      }
    }

    rs.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const progress: Array<number | null> = [];
    const body = new FormData();
    const resultPromise = postSessionTurn("session-1", body, {
      onUploadProgress: (value) => progress.push(value),
    });
    const request = FakeXMLHttpRequest.current;
    expect(request).not.toBeNull();
    if (!request) throw new Error("XMLHttpRequest was not created");

    request.upload.onprogress?.({
      lengthComputable: true,
      loaded: 25,
      total: 100,
    } as ProgressEvent);
    request.upload.onload?.();
    request.status = 200;
    request.responseText = JSON.stringify({ turnId: "turn-1" });
    request.onload?.();

    await expect(resultPromise).resolves.toEqual({ ok: true, data: { turnId: "turn-1" } });
    expect(progress).toEqual([0.25, 1]);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/chat/sessions/session-1/turns");
    expect(request.withCredentials).toBe(true);
    expect(request.body).toBe(body);
    expect(body.has("inputId")).toBe(true);
  });
});
