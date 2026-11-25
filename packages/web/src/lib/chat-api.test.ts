import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  isUnreachableStatus,
  createSession,
  updateSessionModel,
  listSessionMessagePage,
  plainErrorText,
  postSessionTurn,
  postSessionTurnJson,
} from "./chat-api";

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// The page Cloudflare answers with while Rome behind it restarts.
const PROXY_ERROR_PAGE = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<html class="no-js" lang="en-US"><head><title>Bad gateway</title></head><body></body></html>`;

describe("error bodies that are not JSON", () => {
  it("keeps a proxy's HTML error page out of a refused send's message", async () => {
    rs.stubGlobal(
      "fetch",
      rs
        .fn()
        .mockResolvedValue(
          new Response(PROXY_ERROR_PAGE, { status: 502, headers: { "content-type": "text/html" } }),
        ),
    );

    await expect(postSessionTurnJson("session-1", { text: "hi" })).resolves.toEqual({
      ok: false,
      status: 502,
      message: "",
    });
  });

  it("keeps a plain-text error as the message", async () => {
    rs.stubGlobal(
      "fetch",
      rs.fn().mockResolvedValue(new Response("upstream timed out", { status: 504 })),
    );

    await expect(postSessionTurnJson("session-1", { text: "hi" })).resolves.toEqual({
      ok: false,
      status: 504,
      message: "upstream timed out",
    });
  });

  it("drops HTML whatever it starts with, and shortens plain text", () => {
    expect(plainErrorText(`  ${PROXY_ERROR_PAGE}`)).toBe("");
    expect(plainErrorText("<html><body>Error</body></html>")).toBe("");
    expect(plainErrorText("x".repeat(300))).toHaveLength(200);
  });

  it("refuses a listing with its status, not the page, when the proxy answers", async () => {
    rs.stubGlobal(
      "fetch",
      rs.fn().mockResolvedValue(new Response(PROXY_ERROR_PAGE, { status: 502 })),
    );

    await expect(listSessionMessagePage("session-1", { limit: 10 })).rejects.toThrow(
      "Request failed with status 502",
    );
  });

  it("tells the proxy's statuses from Rome's own", () => {
    for (const status of [502, 503, 504, 520, 522, 524, 530]) {
      expect(isUnreachableStatus(status)).toBe(true);
    }
    for (const status of [400, 404, 409, 500, 501, 505, 519, 531]) {
      expect(isUnreachableStatus(status)).toBe(false);
    }
  });
});

describe("listSessionMessagePage", () => {
  it("asks by turns, and reads the page", async () => {
    const fetchMock = rs
      .fn()
      .mockResolvedValueOnce(json({ messages: [], nextCursor: "t1", layout: null }));
    rs.stubGlobal("fetch", fetchMock);

    const page = await listSessionMessagePage("s1", { limit: 10, before: "c1" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chat/sessions/s1/messages?limit=10&before=c1");
    expect(page).toMatchObject({ messages: [], nextCursor: "t1" });
  });
});

describe("fixed model identity transport", () => {
  const identity = { providerId: "anthropic", modelId: "claude-opus-4-8[1m]" };
  function capture() {
    const fetch = rs.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "chat",
            turnId: "turn",
            sessionId: "chat",
            disposition: "started",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    rs.stubGlobal("fetch", fetch);
    return fetch;
  }
  it("sends a legacy selection as its fixed native identity, not an upstream alias", async () => {
    const fetch = capture();
    await updateSessionModel("chat", "claude-opus");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      largeModelSelection: "anthropic/claude-opus-4-8[1m]",
      modelSelection: identity,
    });
  });
  it("accepts an exact pair when creating or updating a chat", async () => {
    const fetch = capture();
    await createSession({ name: "Fixed", projectPath: "default", modelSelection: identity });
    await updateSessionModel("chat", identity);
    for (const [, options] of fetch.mock.calls)
      expect(JSON.parse(options.body)).toMatchObject({
        largeModelSelection: "anthropic/claude-opus-4-8[1m]",
        modelSelection: identity,
      });
  });
  it("does not overwrite conflicting JSON fields to make them appear consistent", async () => {
    const fetch = capture();
    await expect(
      postSessionTurnJson("chat", {
        largeModelSelection: "claude-sonnet",
        modelSelection: identity,
      }),
    ).rejects.toThrow("conflicting");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("serializes the identical pair for multipart sends without changing attachments", async () => {
    const fetch = capture();
    const body = new FormData();
    body.set("largeModelSelection", "claude-opus");
    body.set("text", "Keep my input");
    await postSessionTurn("chat", body);
    expect(fetch.mock.calls[0][1].body).toBe(body);
    expect(body.get("largeModelSelection")).toBe("anthropic/claude-opus-4-8[1m]");
    expect(JSON.parse(String(body.get("modelSelection")))).toEqual(identity);
    expect(body.get("text")).toBe("Keep my input");
  });
  it("does not turn an unknown draft into Auto or send it", async () => {
    const fetch = capture();
    await expect(updateSessionModel("chat", "unknown-old-choice")).rejects.toThrow("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});
