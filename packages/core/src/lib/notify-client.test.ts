import { describe, expect, it, rs } from "@rstest/core";
import { NOT_HOSTED_REMEMBERED_MS, NotifyClient } from "./notify-client.js";

function client(opts: { token?: string | null; origin?: string | null; fetchImpl: typeof fetch }) {
  return new NotifyClient({
    getToken: () => (opts.token === undefined ? "romeinst_test" : opts.token),
    getOrigin: () => (opts.origin === undefined ? "https://romeos.cc" : opts.origin),
    fetchImpl: opts.fetchImpl,
    timeoutMs: 50,
  });
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stalledRes(status: number) {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status },
  );
  return { response, wasCancelled: () => cancelled };
}

describe("NotifyClient.send", () => {
  it("returns no_token when no instance token is present", async () => {
    const c = client({ token: null, fetchImpl: rs.fn() });
    expect(await c.send()).toEqual({ kind: "no_token" });
  });

  it("returns unconfigured when the Rome Cloud origin is unset", async () => {
    const c = client({ origin: null, fetchImpl: rs.fn() });
    expect(await c.send()).toEqual({ kind: "unconfigured" });
  });

  it("sends a Bearer POST to /api/notify and returns ok with counts", async () => {
    // Type the mock args as Parameters<typeof fetch> so mock.calls[0]
    // destructures to [input, init?] and typechecks (test files are compiled).
    const fetchImpl = rs.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonRes(200, { attempted: 2, sent: 1, failed: 1 }),
    );
    const out = await client({ fetchImpl }).send();
    expect(out).toEqual({ kind: "ok", attempted: 2, sent: 1, failed: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://romeos.cc/api/notify");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer romeinst_test");
    // A zero-argument send carries no HTTP body — byte-identical to the
    // pre-cutover request, so the broker still applies its default alert.
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
  });

  it("sends no body for send({}) with no content field", async () => {
    const fetchImpl = rs.fn(async (..._a: Parameters<typeof fetch>) =>
      jsonRes(200, { attempted: 1, sent: 1, failed: 0 }),
    );
    await client({ fetchImpl }).send({});
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
  });

  it("sends a custom body as JSON with a Content-Type header", async () => {
    const fetchImpl = rs.fn(async (..._a: Parameters<typeof fetch>) =>
      jsonRes(200, { attempted: 1, sent: 1, failed: 0 }),
    );
    const out = await client({ fetchImpl }).send({ body: "Build failed" });
    expect(out).toEqual({ kind: "ok", attempted: 1, sent: 1, failed: 0 });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ body: "Build failed" }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer romeinst_test");
  });

  it("sends a system push's level and chatId beside its body", async () => {
    const fetchImpl = rs.fn(async (..._a: Parameters<typeof fetch>) =>
      jsonRes(200, { attempted: 1, sent: 1, failed: 0 }),
    );
    await client({ fetchImpl }).send({ body: "PR merged", level: "passive", chatId: "chat-1" });
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      body: "PR merged",
      level: "passive",
      chatId: "chat-1",
    });
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("names a visitor recipient, and sends none for the guardian", async () => {
    const fetchImpl = rs.fn(async (..._a: Parameters<typeof fetch>) =>
      jsonRes(200, { attempted: 1, sent: 1, failed: 0, recipient: "acct-v" }),
    );
    expect(await client({ fetchImpl }).send({ body: "hi", recipient: "acct-v" })).toEqual({
      kind: "ok",
      attempted: 1,
      sent: 1,
      failed: 0,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      body: "hi",
      recipient: "acct-v",
    });
    await client({ fetchImpl }).send({ body: "hi" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({ body: "hi" });
  });

  it("maps a 200 that does not echo the visitor recipient to outcome_unknown", async () => {
    for (const echoed of [undefined, "someone-else"]) {
      const c = client({
        fetchImpl: rs.fn(async () =>
          jsonRes(200, { attempted: 1, sent: 1, failed: 0, recipient: echoed }),
        ),
      });
      expect(await c.send({ body: "hi", recipient: "acct-v" })).toEqual({
        kind: "outcome_unknown",
      });
    }
  });

  it("maps a 200 that says the instance is not hosted to not_hosted, for any recipient", async () => {
    const notHosted = { attempted: 0, sent: 0, failed: 0, reason: "not_hosted" };
    const c = client({ fetchImpl: rs.fn(async () => jsonRes(200, notHosted)) });
    expect(await c.send({ body: "hi" })).toEqual({ kind: "not_hosted" });
    expect(await c.send({ body: "hi", recipient: "acct-v" })).toEqual({ kind: "not_hosted" });
  });

  it("remembers not_hosted for an hour, or until the instance token changes", async () => {
    let now = 0;
    let token = "romeinst_a";
    const fetchImpl = rs.fn(async () =>
      jsonRes(200, { attempted: 0, sent: 0, failed: 0, reason: "not_hosted" }),
    );
    const c = new NotifyClient({
      getToken: () => token,
      getOrigin: () => "https://romeos.cc",
      fetchImpl,
      timeoutMs: 50,
      now: () => now,
    });
    expect(await c.send({ body: "1" })).toEqual({ kind: "not_hosted" });
    now += NOT_HOSTED_REMEMBERED_MS - 1;
    expect(await c.send({ body: "2" })).toEqual({ kind: "not_hosted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 1;
    await c.send({ body: "3" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Re-enrollment mints a new token, which asks again at once.
    token = "romeinst_b";
    await c.send({ body: "4" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps an older Rome Cloud's zero counts, which carry no reason, as ok", async () => {
    const c = client({
      fetchImpl: rs.fn(async () => jsonRes(200, { attempted: 0, sent: 0, failed: 0 })),
    });
    expect(await c.send({ body: "hi" })).toEqual({ kind: "ok", attempted: 0, sent: 0, failed: 0 });
  });

  it("maps an older Rome Cloud's 400 for an unknown recipient field to outcome_unknown", async () => {
    const c = client({ fetchImpl: rs.fn(async () => jsonRes(400, { error: "invalid_request" })) });
    expect(await c.send({ body: "hi", recipient: "acct-v" })).toEqual({ kind: "outcome_unknown" });
  });

  it("maps a 403 recipient_not_allowed to its own outcome, and any other 403 to reenroll", async () => {
    const refused = client({
      fetchImpl: rs.fn(async () => jsonRes(403, { error: "recipient_not_allowed" })),
    });
    expect(await refused.send({ body: "hi", recipient: "acct-v" })).toEqual({
      kind: "recipient_not_allowed",
    });
    const revoked = client({
      fetchImpl: rs.fn(async () => jsonRes(403, { error: "instance_revoked" })),
    });
    expect(await revoked.send({ body: "hi", recipient: "acct-v" })).toEqual({ kind: "reenroll" });
  });

  it("forwards an empty-string body verbatim (Rome Cloud owns the fallback)", async () => {
    const fetchImpl = rs.fn(async (..._a: Parameters<typeof fetch>) =>
      jsonRes(200, { attempted: 1, sent: 1, failed: 0 }),
    );
    await client({ fetchImpl }).send({ body: "" });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ body: "" }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("forwards a whitespace-only body unchanged (never client-trimmed/dropped)", async () => {
    // The client must not trim or blank-drop; Rome Cloud is the sole normalization
    // authority. Guards against a future `content?.body?.trim()`-style regression.
    const fetchImpl = rs.fn(async (..._a: Parameters<typeof fetch>) =>
      jsonRes(200, { attempted: 1, sent: 1, failed: 0 }),
    );
    await client({ fetchImpl }).send({ body: "   " });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.body).toBe(JSON.stringify({ body: "   " }));
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
  });

  it("maps a broker 400 (rejected body) to outcome_unknown, no new SendOutcome member", async () => {
    const c = client({
      fetchImpl: rs.fn(async () => jsonRes(400, { error: "invalid_request" })),
    });
    expect(await c.send({ body: "bad" })).toEqual({ kind: "outcome_unknown" });
  });

  it("maps Rome Cloud 401 to reenroll", async () => {
    const stalled = stalledRes(401);
    const c = client({
      fetchImpl: rs.fn(async () => stalled.response),
    });
    expect(await c.send()).toEqual({ kind: "reenroll" });
    expect(stalled.wasCancelled()).toBe(true);
  });

  it("maps Rome Cloud 403 to reenroll", async () => {
    const c = client({
      fetchImpl: rs.fn(async () => jsonRes(403, { error: "instance_revoked" })),
    });
    expect(await c.send()).toEqual({ kind: "reenroll" });
  });

  it("maps a 5xx to outcome_unknown", async () => {
    const stalled = stalledRes(502);
    const c = client({ fetchImpl: rs.fn(async () => stalled.response) });
    expect(await c.send()).toEqual({ kind: "outcome_unknown" });
    expect(stalled.wasCancelled()).toBe(true);
  });

  it("maps a network error to outcome_unknown", async () => {
    const c = client({
      fetchImpl: rs.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    expect(await c.send()).toEqual({ kind: "outcome_unknown" });
  });

  it("throws for an invalid origin before dispatching a request", async () => {
    const fetchImpl = rs.fn();
    const c = client({ origin: "https://[invalid", fetchImpl });

    await expect(c.send()).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a request timeout (abort fired) to outcome_unknown", async () => {
    // fetch that never resolves on its own; the 50ms AbortController must abort it.
    const fetchImpl = rs.fn((..._args: Parameters<typeof fetch>) => {
      const signal = (_args[1] as RequestInit).signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    expect(await client({ fetchImpl }).send()).toEqual({ kind: "outcome_unknown" });
  });

  it("maps a malformed 200 body to outcome_unknown", async () => {
    const c = client({ fetchImpl: rs.fn(async () => jsonRes(200, { ok: true })) });
    expect(await c.send()).toEqual({ kind: "outcome_unknown" });
  });

  it("maps an inconsistent 200 body (sent+failed !== attempted) to outcome_unknown", async () => {
    const c = client({
      fetchImpl: rs.fn(async (..._a: Parameters<typeof fetch>) =>
        jsonRes(200, { attempted: 0, sent: 1, failed: 0 }),
      ),
    });
    expect(await c.send()).toEqual({ kind: "outcome_unknown" });
  });

  it("maps a negative count to outcome_unknown", async () => {
    const c = client({
      fetchImpl: rs.fn(async (..._a: Parameters<typeof fetch>) =>
        jsonRes(200, { attempted: 2, sent: -1, failed: 3 }),
      ),
    });
    expect(await c.send()).toEqual({ kind: "outcome_unknown" });
  });

  it("maps a non-integer count to outcome_unknown", async () => {
    const c = client({
      fetchImpl: rs.fn(async (..._a: Parameters<typeof fetch>) =>
        jsonRes(200, { attempted: 2, sent: 1.5, failed: 0.5 }),
      ),
    });
    expect(await c.send()).toEqual({ kind: "outcome_unknown" });
  });

  // Timeout budget: a legitimate slow fan-out (Rome Cloud awaits up to
  // ~100s of sequential APNs sends) must complete, not be aborted. Uses the real
  // 120s default (not the 50ms test override) with fake timers.
  it("does not abort a slow-but-valid ~100s fetch (under the 120s HTTP budget)", async () => {
    rs.useFakeTimers();
    try {
      const fetchImpl = rs.fn((..._a: Parameters<typeof fetch>) => {
        // Honor the abort signal so a *too-short* budget flips the outcome: if
        // the timeout fired before 100s this rejects → outcome_unknown and the
        // ok assertion below fails. Without this the test would pass even with a
        // 30s budget, proving nothing about the 120s floor.
        const signal = (_a[1] as RequestInit).signal;
        return new Promise<Response>((resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          setTimeout(() => resolve(jsonRes(200, { attempted: 1, sent: 1, failed: 0 })), 100_000);
        });
      });
      const c = new NotifyClient({
        getToken: () => "romeinst_test",
        getOrigin: () => "https://romeos.cc",
        fetchImpl,
      });
      const p = c.send();
      await rs.advanceTimersByTimeAsync(100_000); // < 120s: the abort must NOT fire
      expect(await p).toEqual({ kind: "ok", attempted: 1, sent: 1, failed: 0 });
    } finally {
      rs.useRealTimers();
    }
  });
});
