import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChatMessage } from "./chat-types";
import { conciergePageOf, listSessionMessagePage, postSessionTurn } from "./chat-api";

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

const line = (id: string, minute: number): ChatMessage =>
  ({
    id,
    sessionId: "s1",
    turnId: null,
    role: "user",
    content: "[]",
    createdAt: new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString(),
  }) as ChatMessage;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("conciergePageOf", () => {
  it("flattens the main line, each thread's replies and the waiting replies into the messages the chat keeps", () => {
    const page = conciergePageOf({
      mainLine: [
        { message: line("m1", 5), thread: { replies: [line("r1", 6), line("r2", 7)] } },
        { message: line("m2", 8), thread: null },
      ],
      outside: [{ root: "old", title: "Trip", latestUnread: line("o1", 9) }],
      nextCursor: "c1",
      layout: [],
    });

    expect(page.messages.map((message) => message.id)).toEqual(["m1", "r1", "r2", "m2", "o1"]);
    expect(page.concierge?.body.map((message) => message.id)).toEqual(["m1", "r1", "r2", "m2"]);
    expect(page.nextCursor).toBe("c1");
    expect(page.layout).toEqual([]);
    // The oldest main-line message, not a reply nor a waiting thread's.
    expect(page.concierge?.oldestAt).toBe(Date.parse(line("m1", 5).createdAt));
    expect(page.concierge?.titles).toEqual(new Map([["old", "Trip"]]));
  });

  it("reads an empty page", () => {
    const page = conciergePageOf({ mainLine: [], outside: [], nextCursor: null });
    expect(page.messages).toEqual([]);
    expect(page.concierge?.oldestAt).toBeNull();
    expect("layout" in page).toBe(false);
  });
});

describe("listSessionMessagePage", () => {
  const stub = (...responses: Response[]) => {
    const fetchMock = rs.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(response);
    rs.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("asks for the Concierge paging and reads its answer", async () => {
    const fetchMock = stub(
      json({
        type: "concierge",
        mainLine: [{ message: line("m1", 1), thread: null }],
        outside: [],
        nextCursor: null,
        hasMore: false,
      }),
    );

    const page = await listSessionMessagePage("s1", {
      limit: 40,
      before: "c0",
      through: "m0",
      concierge: { fallbackLimit: 10 },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/chat/sessions/s1/messages?limit=40&type=concierge&before=c0&through=m0",
    );
    expect(page?.concierge).toBeDefined();
    expect(page?.messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("takes an answer by turns from a server that does not know the paging mode", async () => {
    stub(json({ messages: [line("m1", 1)], nextCursor: "t1" }));

    const page = await listSessionMessagePage("s1", {
      limit: 40,
      concierge: { fallbackLimit: 10 },
    });

    expect(page).toEqual({ messages: [line("m1", 1)], nextCursor: "t1" });
  });

  it("reads by turns again when the chat says it is not a Concierge chat", async () => {
    const fetchMock = stub(
      json({ error: "Not a Concierge chat", code: "not_concierge" }, 400),
      json({ messages: [line("m1", 1)], nextCursor: "t1" }),
    );

    const page = await listSessionMessagePage("s1", {
      limit: 40,
      concierge: { fallbackLimit: 10 },
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/chat/sessions/s1/messages?limit=40&type=concierge",
      "/api/chat/sessions/s1/messages?limit=10",
    ]);
    expect(page).toEqual({ messages: [line("m1", 1)], nextCursor: "t1" });
    expect(page?.concierge).toBeUndefined();
  });

  it("answers null for a chat that does not exist, and throws on any other refusal", async () => {
    stub(json({ error: "Session not found" }, 404));
    await expect(
      listSessionMessagePage("s1", { limit: 40, concierge: { fallbackLimit: 10 } }),
    ).resolves.toBeNull();

    stub(json({ error: "Invalid before cursor" }, 400));
    await expect(
      listSessionMessagePage("s1", { limit: 40, concierge: { fallbackLimit: 10 } }),
    ).rejects.toMatchObject({ status: 400, message: "Invalid before cursor" });
  });

  it("asks by turns, as it always did, without the option", async () => {
    const fetchMock = stub(json({ messages: [], nextCursor: null }));

    await listSessionMessagePage("s1", { limit: 10, before: "c1" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chat/sessions/s1/messages?limit=10&before=c1");
  });
});
