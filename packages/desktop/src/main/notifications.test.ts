import { beforeEach, describe, expect, it, rs } from "@rstest/core";

const logs = rs.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));
rs.mock("./logger", () => ({
  createLogger: () => ({
    error: rs.fn(),
    info: (message: string) => logs.info.push(message),
    warn: (message: string) => logs.warn.push(message),
  }),
}));

import {
  chatPathFor,
  resetFailureLogForTests,
  showDesktopNotification,
  type NativeNotification,
  type NotifiableWindow,
  type NotificationDeps,
} from "./notifications";

const ORIGIN = "https://ray.romeos.cc";
const base = { title: "Rome", body: "Your report is ready", instanceId: "inst-1" };

class FakeNotification implements NativeNotification {
  listeners = new Map<string, (...args: never[]) => void>();
  shown = false;
  constructor(readonly options: { title: string; body: string; silent: boolean }) {}
  on(event: string, listener: (...args: never[]) => void) {
    this.listeners.set(event, listener);
    return this;
  }
  show() {
    this.shown = true;
  }
  emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.(...(args as never[]));
  }
}

function fakeWindow(state: { visible?: boolean; focused?: boolean; url?: string } = {}) {
  const window = {
    destroyed: false,
    visible: state.visible ?? true,
    focused: state.focused ?? true,
    url: state.url ?? `${ORIGIN}/message`,
    scripts: [] as string[],
    loaded: [] as string[],
    failScript: false,
    isDestroyed() {
      return this.destroyed;
    },
    isVisible() {
      return this.visible;
    },
    isFocused() {
      return this.focused;
    },
    webContents: {
      getURL: () => window.url,
      executeJavaScript: async (code: string) => {
        if (window.failScript) throw new Error("no page");
        window.scripts.push(code);
      },
    },
    loadURL: async (url: string) => {
      window.loaded.push(url);
    },
  };
  return window satisfies NotifiableWindow & Record<string, unknown>;
}

function setup(
  options: { window?: ReturnType<typeof fakeWindow> | null; openId?: string | null } = {},
) {
  const window = options.window === undefined ? fakeWindow() : options.window;
  const created: FakeNotification[] = [];
  const shown: string[] = [];
  const deps: NotificationDeps = {
    mainWindow: () => window,
    openInstance: () =>
      options.openId === null ? null : { id: options.openId ?? "inst-1", origin: ORIGIN },
    showMainWindow: async () => {
      shown.push("show");
      return window;
    },
    createNotification: (o) => {
      const n = new FakeNotification(o);
      created.push(n);
      return n;
    },
  };
  return { deps, created, shown, window };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  logs.info.length = 0;
  logs.warn.length = 0;
  resetFailureLogForTests();
});

describe("showDesktopNotification", () => {
  it("does nothing while the Rome window is visible and focused", () => {
    const { deps, created } = setup();
    showDesktopNotification(base, deps);
    expect(created).toEqual([]);
    expect(logs.info).toEqual(["Desktop notification skipped: the Rome window is in front"]);
  });

  it.each([
    ["not focused", { focused: false }],
    ["hidden", { visible: false }],
    ["hidden and not focused", { visible: false, focused: false }],
  ])("shows it when the window is %s", (_name, state) => {
    const { deps, created } = setup({ window: fakeWindow(state) });
    showDesktopNotification(base, deps);
    expect(created).toHaveLength(1);
    expect(created[0].shown).toBe(true);
  });

  it("shows it when there is no window or it was destroyed", () => {
    const destroyed = fakeWindow();
    destroyed.destroyed = true;
    for (const window of [null, destroyed]) {
      const { deps, created } = setup({ window });
      showDesktopNotification(base, deps);
      expect(created).toHaveLength(1);
    }
  });

  it("rings only for the active level", () => {
    const { deps, created } = setup({ window: null });
    showDesktopNotification({ ...base, level: "active" }, deps);
    showDesktopNotification({ ...base, level: "passive" }, deps);
    showDesktopNotification(base, deps);
    expect(created.map((n) => n.options.silent)).toEqual([false, true, true]);
    expect(created[0].options).toEqual({ title: "Rome", body: base.body, silent: false });
  });

  it("never logs the body", () => {
    const { deps, created } = setup({ window: null });
    showDesktopNotification({ ...base, body: "secret-body-text" }, deps);
    created[0].emit("failed", {}, "not allowed");
    expect([...logs.info, ...logs.warn].join("\n")).not.toContain("secret-body-text");
    expect(logs.info).toEqual(["Desktop notification shown"]);
  });

  it("logs a failure to show once and does not retry", () => {
    const { deps, created } = setup({ window: null });
    showDesktopNotification(base, deps);
    showDesktopNotification(base, deps);
    created[0].emit("failed", {}, "not signed");
    created[1].emit("failed", {}, "not signed");
    expect(logs.warn).toHaveLength(1);
    expect(created).toHaveLength(2);
  });
});

describe("clicking a notification", () => {
  it("opens the chat on the open instance with a soft navigation", async () => {
    const window = fakeWindow({ visible: false });
    const { deps, created, shown } = setup({ window });
    showDesktopNotification({ ...base, chatId: "chat_1-A" }, deps);
    created[0].emit("click");
    await settle();
    expect(shown).toEqual(["show"]);
    expect(window.scripts).toHaveLength(1);
    expect(window.scripts[0]).toContain('"rome:host-navigate"');
    expect(window.scripts[0]).toContain('path:"/chat/chat_1-A"');
    expect(window.loaded).toEqual([]);
  });

  it("opens the main chat when there is no chat id", async () => {
    const window = fakeWindow({ focused: false });
    const { deps, created } = setup({ window });
    showDesktopNotification(base, deps);
    created[0].emit("click");
    await settle();
    expect(window.scripts[0]).toContain('path:"/message"');
  });

  it("loads the URL when the window is not on the instance or the page fails", async () => {
    const away = fakeWindow({ focused: false, url: "file:///app/startup.html" });
    let s = setup({ window: away });
    showDesktopNotification({ ...base, chatId: "c1" }, s.deps);
    s.created[0].emit("click");
    await settle();
    expect(away.scripts).toEqual([]);
    expect(away.loaded).toEqual([`${ORIGIN}/chat/c1`]);

    const broken = fakeWindow({ focused: false });
    broken.failScript = true;
    s = setup({ window: broken });
    showDesktopNotification({ ...base, chatId: "c1" }, s.deps);
    s.created[0].emit("click");
    await settle();
    expect(broken.loaded).toEqual([`${ORIGIN}/chat/c1`]);
  });

  it("only shows the window for another instance or when none is open", async () => {
    for (const openId of ["inst-2", null]) {
      const window = fakeWindow({ focused: false });
      const { deps, created, shown } = setup({ window, openId });
      showDesktopNotification({ ...base, chatId: "c1" }, deps);
      created[0].emit("click");
      await settle();
      expect(shown).toEqual(["show"]);
      expect(window.scripts).toEqual([]);
      expect(window.loaded).toEqual([]);
    }
  });

  it("does not navigate for a chat id that is not a plain id", async () => {
    for (const chatId of ['x"});alert(1);//', "../admin", "a/b", "a".repeat(129), "a b"]) {
      const window = fakeWindow({ focused: false });
      const { deps, created, shown } = setup({ window });
      showDesktopNotification({ ...base, chatId }, deps);
      created[0].emit("click");
      await settle();
      expect(shown).toEqual(["show"]);
      expect(window.scripts).toEqual([]);
      expect(window.loaded).toEqual([]);
    }
  });

  it("survives the window being gone", async () => {
    const { deps, created } = setup({ window: null });
    showDesktopNotification(base, deps);
    created[0].emit("click");
    await settle();
    expect(logs.warn).toEqual([]);
  });
});

describe("chatPathFor", () => {
  it("builds the chat route and guards the id", () => {
    expect(chatPathFor(undefined)).toBe("/message");
    expect(chatPathFor("abc_DEF-123")).toBe("/chat/abc_DEF-123");
    expect(chatPathFor("a".repeat(128))).toBe(`/chat/${"a".repeat(128)}`);
    expect(chatPathFor("a".repeat(129))).toBeNull();
    expect(chatPathFor("")).toBeNull();
    expect(chatPathFor("a?b")).toBeNull();
  });
});
