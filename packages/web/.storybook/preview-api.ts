function pathnameOf(input: RequestInfo | URL): string | null {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined") {
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const pathname = pathnameOf(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    if (method === "GET" && pathname === "/api/onboard/draft") {
      return Promise.resolve(Response.json({ settings: {} }));
    }
    if (method === "GET" && pathname === "/api/ai-tools/status") {
      return Promise.resolve(
        Response.json({ claude: { loggedIn: false }, codex: { loggedIn: false } }),
      );
    }
    if (method === "GET" && pathname === "/api/ai-tools/anthropic-compatible-providers") {
      return Promise.resolve(Response.json({ providers: [], configured: null }));
    }
    if (pathname?.startsWith("/api/")) {
      return Promise.reject(
        new Error(`Blocked by the Storybook preview fetch guard: ${method} ${pathname}`),
      );
    }
    return realFetch(input, init);
  };
}
