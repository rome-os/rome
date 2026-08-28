import { describe, expect, it } from "@rstest/core";
import { createFetchRecorder, FetchRecorderUnmatchedError } from "./fetch-recorder.js";

// Contract tests for the kit's outbound-HTTP fake: code under test receives
// `recorder.fetch` through a `fetch?: typeof fetch` seam, the test scripts the
// remote side with `when(...)`, and asserts the outbound contract via `calls`.

describe("fetchRecorder", () => {
  it("records the url, method, headers, and body of every request", async () => {
    const http = createFetchRecorder();
    http.when("POST", "https://api.example/things").reply(201, { id: "t1" });

    await http.fetch("https://api.example/things", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ name: "thing" }),
    });

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      url: "https://api.example/things",
      method: "POST",
      body: '{"name":"thing"}',
    });
    expect(http.calls[0].headers.get("authorization")).toBe("Bearer tok");
  });

  it("records a body-less request with body null", async () => {
    const http = createFetchRecorder();
    http.when("GET", "https://api.example/things").reply(200, []);

    await http.fetch("https://api.example/things");

    expect(http.calls[0].body).toBeNull();
  });

  it("replies with JSON for a non-string body and the scripted status", async () => {
    const http = createFetchRecorder();
    http.when("GET", "https://api.example/me").reply(200, { id: "u1" });

    const response = await http.fetch("https://api.example/me");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ id: "u1" });
  });

  it("replies with a string body verbatim", async () => {
    const http = createFetchRecorder();
    http.when("GET", "https://api.example/page").reply(502, "<html>bad gateway</html>");

    const response = await http.fetch("https://api.example/page");

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("<html>bad gateway</html>");
  });

  it("replies with a binary body as raw bytes, not JSON", async () => {
    const http = createFetchRecorder();
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    http.when("GET", "https://api.example/bundle.tgz").reply(200, bytes);

    const response = await http.fetch("https://api.example/bundle.tgz");

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).not.toBe("application/json");
  });

  it("accepts URL and Request inputs, normalizing to the same recorded shape", async () => {
    const http = createFetchRecorder();
    http.when("GET", "https://api.example/me").reply(200, {});

    await http.fetch(new URL("/me", "https://api.example"));
    await http.fetch(new Request("https://api.example/me"));

    expect(http.calls.map((c) => c.url)).toEqual([
      "https://api.example/me",
      "https://api.example/me",
    ]);
  });

  it("requires an exact URL match for string rules", async () => {
    const http = createFetchRecorder();
    http.when("GET", "https://api.example/me").reply(200, {});

    await expect(http.fetch("https://api.example/me/extra")).rejects.toThrow(
      FetchRecorderUnmatchedError,
    );
  });

  it("matches RegExp rules against the full URL", async () => {
    const http = createFetchRecorder();
    http.when("GET", /\/listings\/[^/]+$/).reply(200, { ok: true });

    const response = await http.fetch("https://api.example/listings/xiaohongshu");

    expect(response.status).toBe(200);
  });

  it("matches a /g RegExp rule on repeated identical requests", async () => {
    const http = createFetchRecorder();
    http.when("GET", /\/listings\/[^/]+$/g).reply(200, { ok: true });

    const first = await http.fetch("https://api.example/listings/xiaohongshu");
    const second = await http.fetch("https://api.example/listings/xiaohongshu");

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(http.unmatched).toHaveLength(0);
  });

  it("rejects an unmatched request and records it in unmatched", async () => {
    const http = createFetchRecorder();
    http.when("POST", "https://api.example/things").reply(201);

    await expect(http.fetch("https://api.example/things")).rejects.toThrow(
      /no rule matches GET https:\/\/api\.example\/things/,
    );
    expect(http.unmatched).toHaveLength(1);
    expect(http.calls).toHaveLength(1);
  });

  it("rejects with the signal's reason when called with an already-aborted signal", async () => {
    const http = createFetchRecorder();
    http.when("GET", "https://api.example/me").reply(200, {});
    const controller = new AbortController();
    const reason = new Error("aborted before send");
    controller.abort(reason);

    await expect(http.fetch("https://api.example/me", { signal: controller.signal })).rejects.toBe(
      reason,
    );
    // The attempt is still recorded so tests can assert it was issued.
    expect(http.calls).toHaveLength(1);
  });

  it("hangUntilAborted rejects with the abort reason once the caller aborts", async () => {
    const http = createFetchRecorder();
    http.when("GET", "https://api.example/slow").hangUntilAborted();
    const controller = new AbortController();

    const pending = http.fetch("https://api.example/slow", { signal: controller.signal });
    controller.abort(new Error("timed out"));

    await expect(pending).rejects.toThrow("timed out");
  });

  it("rejects with the scripted error for failWith (network-level failure)", async () => {
    const http = createFetchRecorder();
    const boom = new Error("ECONNREFUSED");
    http.when("GET", "https://api.example/me").failWith(boom);

    await expect(http.fetch("https://api.example/me")).rejects.toBe(boom);
    expect(http.unmatched).toHaveLength(0);
  });
});
