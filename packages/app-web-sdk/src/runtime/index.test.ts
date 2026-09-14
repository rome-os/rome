// @rstest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";

import {
  fetchAppApi,
  getPortalContainer,
  isPreview,
  navigateRome,
  setMountContainer,
  startChat,
  type RomeAppBootstrap,
} from "./index";

const bootstrap: RomeAppBootstrap = {
  appId: "founder-scout",
  version: "1.0.0",
  routeBase: "/apps/founder-scout",
  routePath: "",
  apiBase: "/api/apps/founder-scout",
  assetBase: "/app-assets/founder-scout/1.0.0",
  shell: {
    locale: "en-US",
    theme: "light",
    themeName: "ember",
    mode: "embedded",
  },
};

beforeEach(() => {
  rs.stubGlobal("window", {
    __ROME_APP_BOOTSTRAP__: bootstrap,
  } as Window & typeof globalThis);
});

afterEach(() => {
  rs.unstubAllGlobals();
});

describe("fetchAppApi", () => {
  it("preserves query params instead of encoding them into the path", async () => {
    const fetchMock = rs.fn().mockResolvedValue(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    await fetchAppApi("repos?limit=50&cursor=abc");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/apps/founder-scout/repos?limit=50&cursor=abc",
      undefined,
    );
  });

  it("keeps behavior for plain paths without query params", async () => {
    const fetchMock = rs.fn().mockResolvedValue(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    await fetchAppApi("repos");

    expect(fetchMock).toHaveBeenCalledWith("/api/apps/founder-scout/repos", undefined);
  });

  it("supports query-only paths", async () => {
    const fetchMock = rs.fn().mockResolvedValue(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    await fetchAppApi("?limit=50&cursor=abc");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/apps/founder-scout?limit=50&cursor=abc",
      undefined,
    );
  });

  it("normalizes query strings via URLSearchParams encoding", async () => {
    const fetchMock = rs.fn().mockResolvedValue(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    await fetchAppApi("repos?q=hello world&tag=a+b&emoji=🦊");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/apps/founder-scout/repos?q=hello+world&tag=a+b&emoji=%F0%9F%A6%8A",
      undefined,
    );
  });
});

describe("getPortalContainer", () => {
  afterEach(() => setMountContainer(null));

  it("has no container before the app is mounted", () => {
    expect(getPortalContainer()).toBeUndefined();
  });

  it("hands back the mount node once the app is mounted", () => {
    const node = {} as unknown as HTMLElement;
    setMountContainer(node);
    expect(getPortalContainer()).toBe(node);
  });

  it("clears the container after unmount", () => {
    setMountContainer({} as unknown as HTMLElement);
    setMountContainer(null);
    expect(getPortalContainer()).toBeUndefined();
  });
});

describe("isPreview", () => {
  it("is false for a real host mount", () => {
    expect(isPreview()).toBe(false);
  });

  it("is true when the shell mode is preview", () => {
    rs.stubGlobal("window", {
      __ROME_APP_BOOTSTRAP__: {
        ...bootstrap,
        shell: { ...bootstrap.shell, mode: "preview" },
      },
    } as unknown as Window & typeof globalThis);
    expect(isPreview()).toBe(true);
  });

  it("defaults to false before bootstrap is available", () => {
    rs.stubGlobal("window", {} as Window & typeof globalThis);
    expect(isPreview()).toBe(false);
  });
});

describe("navigateRome", () => {
  function stubNavHost() {
    const dispatchEvent = rs.fn();
    rs.stubGlobal("window", {
      __ROME_APP_BOOTSTRAP__: bootstrap,
      dispatchEvent,
      location: { origin: "http://localhost" },
    } as unknown as Window & typeof globalThis);
    return { dispatchEvent };
  }

  function stubIframeNavHost() {
    const dispatchEvent = rs.fn();
    const postMessage = rs.fn();
    rs.stubGlobal("window", {
      __ROME_APP_BOOTSTRAP__: bootstrap,
      dispatchEvent,
      parent: { postMessage },
      location: { origin: "http://localhost" },
    } as unknown as Window & typeof globalThis);
    return { dispatchEvent, postMessage };
  }

  function dispatchedNavigateDetail(
    dispatchEvent: ReturnType<typeof rs.fn>,
  ): { path?: string; state?: unknown } | undefined {
    const event = dispatchEvent.mock.calls
      .map(([evt]) => evt as CustomEvent<{ path?: string; state?: unknown }>)
      .find((evt) => evt.type === "rome:host-navigate");
    return event?.detail;
  }

  function dispatchedPath(dispatchEvent: ReturnType<typeof rs.fn>): string | undefined {
    return dispatchedNavigateDetail(dispatchEvent)?.path;
  }

  it.each([
    ["people", "/people"],
    ["projects", "/projects"],
    ["routines", "/routines"],
    ["desktop", "/desktop"],
    ["apps", "/apps"],
  ] as const)("resolves the %s route to %s", (path, expected) => {
    const { dispatchEvent } = stubNavHost();
    navigateRome({ path });
    expect(dispatchedPath(dispatchEvent)).toBe(expected);
  });

  it("forwards chat navigation to the parent window from an iframe", () => {
    const { dispatchEvent, postMessage } = stubIframeNavHost();

    navigateRome({
      path: "chat",
      sessionId: "session-123",
      widgets: [{ type: "app", appId: "workflow-studio", route: "preview" }],
    });

    expect(dispatchedPath(dispatchEvent)).toBe("/chat/session-123");
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "rome:host-navigate",
        detail: {
          path: "/chat/session-123",
          state: {
            widgets: [{ type: "app", appId: "workflow-studio", route: "preview" }],
          },
        },
      },
      "http://localhost",
    );
  });

  it("resolves and forwards an opaque Rome session from an iframe", () => {
    const { dispatchEvent, postMessage } = stubIframeNavHost();
    const session = {
      _romeSessionId: "action:exec-1:code-review-expert",
      _type: "action" as const,
      futureRoutingField: "preserved",
    };

    navigateRome({ path: "session", session });

    expect(dispatchedPath(dispatchEvent)).toBe("/sessions/action%3Aexec-1%3Acode-review-expert");
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "rome:host-navigate",
        detail: { path: "/sessions/action%3Aexec-1%3Acode-review-expert" },
      },
      "http://localhost",
    );
  });

  it("routes a webchat Rome session to chat", () => {
    const { dispatchEvent } = stubNavHost();

    navigateRome({
      path: "session",
      session: { _romeSessionId: "chat-session-1", _type: "webchat" },
    });

    expect(dispatchedPath(dispatchEvent)).toBe("/chat/chat-session-1");
  });

  it("rejects an invalid opaque Rome session", () => {
    stubNavHost();

    expect(() =>
      navigateRome({
        path: "session",
        session: {} as { _romeSessionId: string; _type: "action" },
      }),
    ).toThrow("contains no valid Rome session id");
  });

  it("rejects an invalid opaque Rome session type", () => {
    stubNavHost();

    expect(() =>
      navigateRome({
        path: "session",
        session: {
          _romeSessionId: "session-1",
          _type: "unknown",
        } as unknown as { _romeSessionId: string; _type: "action" },
      }),
    ).toThrow("contains no valid Rome session type");
  });

  it("includes widgets when navigating to an existing chat from the top window", () => {
    const { dispatchEvent } = stubNavHost();

    navigateRome({
      path: "chat",
      sessionId: "session-123",
      widgets: [{ type: "app", appId: "workflow-studio", route: "preview" }],
    });

    expect(dispatchedNavigateDetail(dispatchEvent)).toEqual({
      path: "/chat/session-123",
      state: {
        widgets: [{ type: "app", appId: "workflow-studio", route: "preview" }],
      },
    });
  });

  it("forwards chat/new navigation state to the parent window from an iframe", () => {
    const { postMessage } = stubIframeNavHost();

    navigateRome({
      path: "chat/new",
      draft: "Review this",
      skill: "weekly-review",
      agentName: "planner",
      projectPath: "demo/project",
      widgets: [{ type: "projects", selectedPath: "projects/demo/project/README.md" }],
    });

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "rome:host-navigate",
        detail: {
          path: "/chat",
          state: {
            draft: "Review this",
            skill: "weekly-review",
            agentName: "planner",
            projectPath: "demo/project",
            widgets: [{ type: "projects", selectedPath: "projects/demo/project/README.md" }],
          },
        },
      },
      "http://localhost",
    );
  });

  it("includes draft controls and widgets when navigating to chat/new from the top window", () => {
    const { dispatchEvent } = stubNavHost();

    navigateRome({
      path: "chat/new",
      draft: "Review this",
      skill: "weekly-review",
      agentName: "planner",
      projectPath: "demo/project",
      widgets: [{ type: "projects", selectedPath: "projects/demo/project/README.md" }],
    });

    expect(dispatchedNavigateDetail(dispatchEvent)).toEqual({
      path: "/chat",
      state: {
        draft: "Review this",
        skill: "weekly-review",
        agentName: "planner",
        projectPath: "demo/project",
        widgets: [{ type: "projects", selectedPath: "projects/demo/project/README.md" }],
      },
    });
  });

  it("does not forward non-chat navigation to the parent window from an iframe", () => {
    const { dispatchEvent, postMessage } = stubIframeNavHost();

    navigateRome({ path: "settings", tab: "connections" });

    expect(dispatchedPath(dispatchEvent)).toBe("/settings/connections");
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("startChat", () => {
  function stubChatHost() {
    const dispatchEvent = rs.fn();
    rs.stubGlobal("window", {
      __ROME_APP_BOOTSTRAP__: bootstrap,
      dispatchEvent,
    } as unknown as Window & typeof globalThis);
    return { dispatchEvent };
  }

  function stubIframeChatHost() {
    const dispatchEvent = rs.fn();
    const postMessage = rs.fn();
    rs.stubGlobal("window", {
      __ROME_APP_BOOTSTRAP__: bootstrap,
      dispatchEvent,
      parent: { postMessage },
      location: { origin: "http://localhost" },
    } as unknown as Window & typeof globalThis);
    return { dispatchEvent, postMessage };
  }

  function mockChatFetch() {
    const fetchMock = rs
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "session-123" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("passes projectPath when creating the session", async () => {
    stubChatHost();
    const fetchMock = mockChatFetch();

    await startChat({
      message: "Start here",
      projectPath: "demo/nested",
      agentName: "planner",
      navigate: false,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ agentName: "planner", projectPath: "demo/nested" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/chat/sessions/session-123/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ text: "Start here" }),
    });
  });

  it("omits projectPath when no project is requested", async () => {
    stubChatHost();
    const fetchMock = mockChatFetch();

    await startChat({ message: "Start anywhere", navigate: false });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/chat/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ agentName: null }),
    });
  });

  it("stores widget layout before posting the first turn, then navigates from the top window", async () => {
    const { dispatchEvent } = stubChatHost();
    const fetchMock = rs
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "session-123" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    await startChat({
      message: "Start with context",
      widgets: [
        { type: "app", appId: "workflow-studio", route: "preview", params: { tab: "plan" } },
        { type: "projects", selectedPath: "projects/demo/project/README.md" },
      ],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chat/sessions/session-123/layout",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
      }),
    );
    const layoutBody = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      layout: Array<Record<string, unknown>>;
    };
    expect(layoutBody.layout).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        type: "app",
        targetId: "workflow-studio",
        route: "preview",
        params: { tab: "plan" },
        order: 1,
      }),
      expect.objectContaining({
        id: expect.any(String),
        type: "projects",
        selectedPath: "projects/demo/project/README.md",
        order: 2,
      }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/chat/sessions/session-123/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ text: "Start with context" }),
    });
    const navigate = dispatchEvent.mock.calls
      .map(([evt]) => evt as CustomEvent)
      .find((evt) => evt.type === "rome:host-navigate");
    expect(navigate?.detail).toEqual({ path: "/chat/session-123" });
  });

  it("stores widget layout and forwards navigation to the parent when started inside an iframe", async () => {
    const { postMessage } = stubIframeChatHost();
    const fetchMock = rs
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "session-123" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    await startChat({
      message: "Start with context",
      widgets: [{ type: "app", appId: "workflow-studio", route: "preview" }],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/chat/sessions/session-123/layout",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
      }),
    );
    const layoutBody = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      layout: Array<Record<string, unknown>>;
    };
    expect(layoutBody.layout).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        type: "app",
        targetId: "workflow-studio",
        route: "preview",
        order: 1,
      }),
    ]);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "rome:host-navigate",
        detail: { path: "/chat/session-123" },
      },
      "http://localhost",
    );
  });

  it("navigates only after the first-turn POST settles, so the chat page's history fetch sees the user message", async () => {
    const { dispatchEvent } = stubChatHost();
    let resolveTurnPost!: (res: Response) => void;
    const fetchMock = rs
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "session-123" }))
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveTurnPost = resolve;
        }),
      );
    rs.stubGlobal("fetch", fetchMock);

    const pending = startChat({ message: "Start here" });
    await rs.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const navigated = () =>
      dispatchEvent.mock.calls.some(([evt]) => (evt as CustomEvent).type === "rome:host-navigate");
    expect(navigated()).toBe(false);

    resolveTurnPost(new Response(null, { status: 200 }));
    await pending;
    expect(navigated()).toBe(true);
  });

  it("still navigates when the first-turn POST fails", async () => {
    const { dispatchEvent } = stubChatHost();
    const fetchMock = rs
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "session-123" }))
      .mockRejectedValueOnce(new Error("network down"));
    rs.stubGlobal("fetch", fetchMock);

    const { sessionId } = await startChat({ message: "Start here" });

    expect(sessionId).toBe("session-123");
    const navigate = dispatchEvent.mock.calls
      .map(([evt]) => evt as CustomEvent)
      .find((evt) => evt.type === "rome:host-navigate");
    expect(navigate?.detail).toEqual({ path: "/chat/session-123" });
  });
});
