import { afterEach, describe, expect, it } from "@rstest/core";
import {
  configureImApiTrace,
  imApiTraceSchema,
  traceImApi,
  traceImFetch,
  type ImApiTraceEvent,
} from "./api-trace.js";

afterEach(() => configureImApiTrace([]));

describe("IM API diagnostics", () => {
  it("validates platform selection and defaults to off", () => {
    expect(imApiTraceSchema.parse(undefined)).toEqual(["off"]);
    expect(imApiTraceSchema.parse("lark, discord")).toEqual(["lark", "discord"]);
    expect(imApiTraceSchema.parse("true")).toEqual(imApiTraceSchema.parse("all"));
    expect(imApiTraceSchema.parse(" true ")).toEqual(["all"]);
    expect(imApiTraceSchema.safeParse("typo").success).toBe(false);
  });

  it("does not inspect responses when disabled or filtered out", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["lark"], (event) => events.push(event));
    const original = { ok: true };
    expect(
      await traceImApi(
        "discord",
        "http",
        {},
        async () => original,
        () => {
          throw new Error("must not inspect");
        },
      ),
    ).toBe(original);
    expect(events).toEqual([]);
  });

  it("correlates and redacts requests and responses including nested JSON and URL credentials", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["all"], (event) => events.push(event));
    await traceImApi(
      "lark",
      "sdk",
      {
        url: "https://user:secret@example.com/bot123:secret/sendMessage?access_token=secret",
        headers: { Authorization: "Bearer secret" },
        body: {
          app_secret: "secret",
          aeskey: "wechat-encryption-material",
          upload_param: "wechat-upload-credential",
          content: '{"text":"hello","refresh_token":"nested-credential-value"}',
        },
      },
      async () => ({ tenant_access_token: "secret", code: 0, data: { message_id: "om_1" } }),
    );
    expect(events).toHaveLength(2);
    expect(events[0].exchangeId).toBe(events[1].exchangeId);
    expect(events[1]).toMatchObject({
      schemaVersion: 1,
      phase: "response",
      detail: { code: 0, data: { message_id: "om_1" } },
    });
    expect(JSON.stringify(events)).not.toContain('"secret"');
    expect(JSON.stringify(events)).not.toContain("Bearer secret");
    expect(JSON.stringify(events)).not.toContain("wechat-encryption-material");
    expect(JSON.stringify(events)).not.toContain("wechat-upload-credential");
    expect(JSON.stringify(events)).not.toContain("nested-credential-value");
    expect(typeof (events[0].detail as { body: { content: unknown } }).body.content).toBe("string");
    expect(JSON.stringify(events)).toContain("hello");
  });

  it("preserves primitive strings and identifiers while redacting encoded JSON containers", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["all"], (event) => events.push(event));
    const strings = [
      "100000000000000001",
      "100000000000000100",
      "1e3",
      "true",
      "null",
      '"hello"',
      " 123 ",
      "[invalid",
    ];
    const body = {
      strings,
      content: JSON.stringify({ message_id: strings[0], token: "nested-secret" }),
      items: '  [{"message_id":"100000000000000100","secret":"array-secret"}]',
    };
    expect(await traceImApi("discord", "http", body, async () => body)).toBe(body);
    for (const event of events) {
      const detail = event.detail as typeof body;
      expect(detail.strings).toEqual(strings);
      expect(JSON.parse(detail.content)).toEqual({ message_id: strings[0], token: "[redacted]" });
      expect(JSON.parse(detail.items)).toEqual([{ message_id: strings[1], secret: "[redacted]" }]);
    }
  });

  it("preserves response bodies and HTTP error status for callers", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["wechat"], (event) => events.push(event));
    const response = Response.json(
      { error: "limited" },
      { status: 429, headers: { "retry-after": "2", "set-cookie": "secret" } },
    );
    const request = traceImFetch("wechat", async () => response);
    expect(
      await request("https://example.com/send", { method: "POST", body: '{"text":"hi"}' }),
    ).toBe(response);
    expect(await response.json()).toEqual({ error: "limited" });
    expect(events[1]).toMatchObject({ detail: { status: 429, body: { error: "limited" } } });
    expect(JSON.stringify(events)).not.toContain('"secret"');
  });

  it.each([
    "object",
    "tuples",
    "Headers",
  ])("redacts %s headers without changing the request", async (form) => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["wechat"], (event) => events.push(event));
    const values = { Authorization: "Bearer fixture-secret", Cookie: "session=fixture-cookie" };
    const headers: HeadersInit =
      form === "tuples"
        ? Object.entries(values)
        : form === "Headers"
          ? new Headers(values)
          : values;
    const response = Response.json({ ok: true });
    const request = traceImFetch("wechat", async (_input, init) => {
      expect(init?.headers).toBe(headers);
      return response;
    });
    expect(await request("https://example.com/send", { headers })).toBe(response);
    expect(events[0].detail).toMatchObject({
      headers: { authorization: "[redacted]", cookie: "[redacted]" },
    });
    expect(JSON.stringify(events)).not.toContain("fixture-secret");
    expect(JSON.stringify(events)).not.toContain("fixture-cookie");
  });

  it("retains bounded, redacted exchange metadata when payloads exceed the limit", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["all"], (event) => events.push(event));
    const body = { first: "中".repeat(8000), second: "文".repeat(8000), token: "fixture-secret" };
    const result = { status: 429, code: 123, body };
    expect(
      await traceImApi(
        "lark",
        "sdk",
        {
          method: "POST",
          url: "https://example.com/messages?token=fixture-secret",
          body,
        },
        async () => result,
      ),
    ).toBe(result);
    expect(events[0].detail).toMatchObject({
      method: "POST",
      url: "https://example.com/messages?token=%5Bredacted%5D",
      omitted: "size limit",
    });
    expect(events[1].detail).toMatchObject({ status: 429, code: 123, omitted: "size limit" });
    for (const event of events) {
      expect(Buffer.byteLength(JSON.stringify(event.detail))).toBeLessThanOrEqual(32_768);
      expect(JSON.stringify(event.detail)).not.toContain("fixture-secret");
      expect(event.detail).not.toHaveProperty("body");
    }
    expect(events[0].exchangeId).toBe(events[1].exchangeId);
  });

  it("preserves errors and delivery results when diagnostic sinks fail", async () => {
    configureImApiTrace(["all"], () => {
      throw new Error("sink failure");
    });
    const error = new Error("request failure");
    await expect(
      traceImApi("discord", "http", {}, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await traceImApi("discord", "http", {}, async () => "ok")).toBe("ok");
  });

  it("omits large payloads and preserves binary responses", async () => {
    const events: ImApiTraceEvent[] = [];
    configureImApiTrace(["all"], (event) => events.push(event));
    const response = new Response(new Uint8Array([1, 2, 3]));
    await traceImFetch("discord", async () => response)("https://example.com/file", {
      body: "x".repeat(100_000),
    });
    expect(JSON.stringify(events).length).toBeLessThan(2000);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
