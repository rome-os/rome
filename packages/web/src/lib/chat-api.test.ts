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
      uploadListenersAttachedBeforeOpen = false;

      constructor() {
        FakeXMLHttpRequest.current = this;
      }

      open(method: string, url: string) {
        this.uploadListenersAttachedBeforeOpen = Boolean(
          this.upload.onprogress && this.upload.onload,
        );
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
    expect(request.uploadListenersAttachedBeforeOpen).toBe(true);
    expect(request.body).toBe(body);
    expect(body.has("inputId")).toBe(true);
  });

  it("measures upload progress over the attached files, not the fields sent around them", () => {
    class FakeXMLHttpRequest {
      static current: FakeXMLHttpRequest | null = null;
      readonly upload = {
        onprogress: null as ((event: ProgressEvent) => void) | null,
        onload: null as (() => void) | null,
      };
      withCredentials = false;
      body: FormData | null = null;
      constructor() {
        FakeXMLHttpRequest.current = this;
      }
      open() {}
      send(body: FormData) {
        this.body = body;
      }
    }

    rs.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const progress: Array<number | null> = [];
    const body = new FormData();
    body.set("text", "x".repeat(800));
    body.append("files", new File([new Uint8Array(100)], "a.bin"));
    body.set("workspace", "{}");
    void postSessionTurn("session-1", body, {
      onUploadProgress: (value) => progress.push(value),
    });
    const request = FakeXMLHttpRequest.current;
    if (!request?.body) throw new Error("XMLHttpRequest was not sent");

    // Files go last, so the file's bytes are the final 100 of the body.
    expect([...request.body.keys()].at(-1)).toBe("files");
    request.upload.onprogress?.({
      lengthComputable: true,
      loaded: 850,
      total: 1000,
    } as ProgressEvent);
    request.upload.onprogress?.({
      lengthComputable: true,
      loaded: 950,
      total: 1000,
    } as ProgressEvent);
    expect(progress).toEqual([0, 0.5]);
  });

  it("aborts the multipart request when the caller's signal fires", async () => {
    class AbortableXHR {
      static current: AbortableXHR | null = null;
      readonly upload = {
        onprogress: null as ((event: ProgressEvent) => void) | null,
        onload: null as (() => void) | null,
      };
      status = 0;
      responseText = "";
      withCredentials = false;
      aborted = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      constructor() {
        AbortableXHR.current = this;
      }
      open() {}
      send() {}
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
    }

    rs.stubGlobal("XMLHttpRequest", AbortableXHR);
    const controller = new AbortController();
    const resultPromise = postSessionTurn("session-1", new FormData(), {
      onUploadProgress: () => {},
      signal: controller.signal,
    });
    const request = AbortableXHR.current;
    if (!request) throw new Error("XMLHttpRequest was not created");

    controller.abort();
    expect(request.aborted).toBe(true);
    // Callers distinguish a user cancel from a transport failure by this name.
    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects without opening a request when the signal is already aborted", async () => {
    class NeverUsedXHR {
      static created = 0;
      readonly upload = { onprogress: null, onload: null };
      constructor() {
        NeverUsedXHR.created += 1;
      }
      open() {}
      send() {}
      abort() {}
    }

    rs.stubGlobal("XMLHttpRequest", NeverUsedXHR);
    await expect(
      postSessionTurn("session-1", new FormData(), {
        onUploadProgress: () => {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(NeverUsedXHR.created).toBe(0);
  });
});
