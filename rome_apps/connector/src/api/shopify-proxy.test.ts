import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { readShopifyOAuthToken, shopifyGraphqlError, shopifyProxyCall } from "./shopify-proxy.js";

describe("readShopifyOAuthToken", () => {
  let tempDir: string;
  let file: string;
  const saved = process.env.ROME_SHOPIFY_TOKEN_FILE;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "rome-shopify-proxy-"));
    file = join(tempDir, "shopify-oauth-token");
    process.env.ROME_SHOPIFY_TOKEN_FILE = file;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.ROME_SHOPIFY_TOKEN_FILE;
    else process.env.ROME_SHOPIFY_TOKEN_FILE = saved;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when the token file does not exist (not connected)", async () => {
    expect(await readShopifyOAuthToken()).toBeNull();
  });

  it("parses the access token and the store's domain", async () => {
    writeFileSync(file, JSON.stringify({ accessToken: "shpat_x", shop: "Acme.myshopify.com" }));
    expect(await readShopifyOAuthToken()).toEqual({
      accessToken: "shpat_x",
      shop: "acme.myshopify.com",
    });
  });

  it("treats a file without a token or a store as not connected", async () => {
    writeFileSync(file, JSON.stringify({ accessToken: "shpat_x" }));
    expect(await readShopifyOAuthToken()).toBeNull();
    writeFileSync(file, JSON.stringify({ shop: "acme.myshopify.com" }));
    expect(await readShopifyOAuthToken()).toBeNull();
    writeFileSync(file, "not json");
    expect(await readShopifyOAuthToken()).toBeNull();
  });
});

describe("shopifyProxyCall", () => {
  afterEach(() => {
    rs.unstubAllGlobals();
  });

  it("sends the token in X-Shopify-Access-Token and never a caller's Authorization", async () => {
    const fetchMock = rs.fn(
      async (_url: URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: { shop: { name: "Acme" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    rs.stubGlobal("fetch", fetchMock);

    const res = await shopifyProxyCall({
      token: { accessToken: "shpat_x", shop: "acme.myshopify.com" },
      endpoint: "https://acme.myshopify.com/admin/api/2026-10/graphql.json",
      method: "POST",
      body: { query: "{ shop { name } }" },
      headers: { Authorization: "Bearer stolen", "X-Shopify-Access-Token": "other" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(String(url)).toBe("https://acme.myshopify.com/admin/api/2026-10/graphql.json");
    expect(headers.get("X-Shopify-Access-Token")).toBe("shpat_x");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({ query: "{ shop { name } }" });
    expect(res).toMatchObject({ status: 200, data: { data: { shop: { name: "Acme" } } } });
  });
});

describe("shopifyProxyCall redirects", () => {
  const servers: Server[] = [];

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  it("never follows a redirect, so the token can't reach another host", async () => {
    // A store answers with a redirect to an outside host (a merchant URL
    // redirect); the outside host records whatever reaches it.
    const received: IncomingHttpHeaders[] = [];
    const outside = await listen((req, res) => {
      received.push(req.headers);
      res.end("{}");
    });
    const store = await listen((_req, res) => {
      res.writeHead(302, { Location: `${outside}/collect` });
      res.end();
    });

    const res = await shopifyProxyCall({
      token: { accessToken: "shpat_secret", shop: "acme.myshopify.com" },
      endpoint: `${store}/admin/api/2026-10/graphql.json`,
      method: "GET",
    });

    expect(res.status).toBe(302);
    expect(received).toEqual([]);
  });
});

describe("shopifyGraphqlError", () => {
  it("reports a top-level errors array", () => {
    expect(shopifyGraphqlError({ errors: [{ message: "Throttled" }] })).toMatch(/Throttled/);
    expect(shopifyGraphqlError({ errors: "Invalid API key" })).toMatch(/Invalid API key/);
  });

  it("reports a mutation's userErrors", () => {
    const data = {
      data: {
        productUpdate: {
          product: null,
          userErrors: [{ field: ["title"], message: "Title can't be blank" }],
        },
      },
    };
    expect(shopifyGraphqlError(data)).toMatch(/Title can't be blank/);
  });

  it("passes a mutation with an empty userErrors list", () => {
    expect(
      shopifyGraphqlError({ data: { productUpdate: { product: { id: "1" }, userErrors: [] } } }),
    ).toBeNull();
  });

  it("passes a response with no errors", () => {
    expect(shopifyGraphqlError({ data: { shop: { name: "Acme" } } })).toBeNull();
    expect(shopifyGraphqlError({ data: {}, errors: [] })).toBeNull();
    expect(shopifyGraphqlError("plain text")).toBeNull();
  });
});
