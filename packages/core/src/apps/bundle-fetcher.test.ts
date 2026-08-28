import { describe, expect, it } from "@rstest/core";
import { createBundleFetcher } from "./bundle-fetcher.js";
import type { AppstoreSource } from "./lockfile.js";

const REGISTRY = "https://rome-cloud.example.com";

function source(listingId: string, version = "0.0.1"): AppstoreSource {
  return {
    mode: "appstore",
    listingId,
    version,
    contentHash: "0".repeat(64),
  };
}

describe("createBundleFetcher", () => {
  it("derives the bundle URL from a logical (unscoped) listingId", async () => {
    const calls: string[] = [];
    const payload = Buffer.from("hello-bundle");
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => REGISTRY,
      fetch: async (input) => {
        calls.push(typeof input === "string" ? input : input.toString());
        return new Response(payload, { status: 200 });
      },
    });
    const out = await fetcher(source("xiaohongshu", "1.2.3"));
    expect(out.equals(payload)).toBe(true);
    expect(calls).toEqual([`${REGISTRY}/api/store/listings/xiaohongshu/versions/1.2.3/bundle`]);
  });

  it("derives the bundle URL from a scoped (@handle/slug) listingId", async () => {
    const calls: string[] = [];
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => REGISTRY,
      fetch: async (input) => {
        calls.push(typeof input === "string" ? input : input.toString());
        return new Response(Buffer.from("ok"), { status: 200 });
      },
    });
    await fetcher(source("@ray/inbox", "0.9.0"));
    expect(calls).toEqual([`${REGISTRY}/api/store/listings/@ray/inbox/versions/0.9.0/bundle`]);
  });

  it("normalises a legacy listingId-as-bundle-URL into the logical id", async () => {
    const calls: string[] = [];
    const legacy = "https://old.example.com/api/store/listings/xiaohongshu/versions/0.0.1/bundle";
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => REGISTRY,
      fetch: async (input) => {
        calls.push(typeof input === "string" ? input : input.toString());
        return new Response(Buffer.from("ok"), { status: 200 });
      },
    });
    await fetcher(source(legacy));
    // The legacy origin in the URL is ignored — the configured registry origin wins.
    expect(calls).toEqual([`${REGISTRY}/api/store/listings/xiaohongshu/versions/0.0.1/bundle`]);
  });

  it("rejects an unparseable listingId-shaped URL", async () => {
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => REGISTRY,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });
    await expect(fetcher(source("javascript://not-a-bundle-path"))).rejects.toThrow(
      /neither a logical id nor a recognisable Rome Cloud URL/,
    );
  });

  it("fails fast when no registry origin is configured", async () => {
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => null,
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });
    await expect(fetcher(source("xiaohongshu"))).rejects.toThrow(
      /registry origin is not configured/,
    );
  });

  it("surfaces non-2xx HTTP responses as errors", async () => {
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => REGISTRY,
      fetch: async () => new Response("forbidden", { status: 403 }),
    });
    await expect(fetcher(source("xiaohongshu"))).rejects.toThrow(/HTTP 403/);
  });

  it("surfaces transport errors", async () => {
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => REGISTRY,
      fetch: async () => {
        throw new TypeError("Network unreachable");
      },
    });
    await expect(fetcher(source("xiaohongshu"))).rejects.toThrow(/Network unreachable/);
  });

  it("times out a hanging fetch", async () => {
    const fetcher = createBundleFetcher({
      registryOriginResolver: () => REGISTRY,
      fetch: (_, init) =>
        new Promise((_, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
      timeoutMs: 25,
    });
    await expect(fetcher(source("xiaohongshu"))).rejects.toThrow(/timed out after 25ms/);
  });
});
