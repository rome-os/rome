import { beforeEach, describe, expect, it, rs } from "@rstest/core";

const electron = rs.hoisted(() => {
  const shortcuts = new Map<string, () => void>();
  const windows: FakeWindow[] = [];
  const nextLoad = { fails: false };
  class FakeWindow {
    visible = false;
    loads: string[] = [];
    webContents = { setWindowOpenHandler() {}, on() {} };
    constructor() {
      windows.push(this);
    }
    static getAllWindows() {
      return windows;
    }
    loadURL(url: string) {
      this.loads.push(url);
      if (!nextLoad.fails) return Promise.resolve();
      nextLoad.fails = false;
      return Promise.reject(new Error("offline"));
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return false;
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    size = [420, 560];
    getSize() {
      return this.size;
    }
    setSize(width: number, height: number) {
      this.size = [width, height];
    }
    setPosition() {}
    setTitle() {}
    setVisibleOnAllWorkspaces() {}
    on() {}
    destroy() {}
  }
  return { shortcuts, windows, nextLoad, FakeWindow };
});

rs.mock("electron", () => ({
  app: { on: rs.fn(), hide: rs.fn() },
  BrowserWindow: electron.FakeWindow,
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      electron.shortcuts.set(accelerator, callback);
      return true;
    },
    isRegistered: (accelerator: string) => electron.shortcuts.has(accelerator),
    unregister: (accelerator: string) => electron.shortcuts.delete(accelerator),
  },
  net: { fetch: rs.fn() },
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
  shell: { openExternal: rs.fn() },
}));
rs.mock("./selection", () => ({ readSelectedText: rs.fn() }));
rs.mock("../app-shims/identity", () => ({ fetchAppIdentity: rs.fn() }));
rs.mock("../lifecycle", () => ({ isQuitting: () => false }));
rs.mock("../logger", () => ({
  createLogger: () => ({ info: rs.fn(), warn: rs.fn() }),
}));

import { fetchAppIdentity } from "../app-shims/identity";
import { readSelectedText } from "./selection";
import { setupShareShortcut } from "./index";
import { SHARE_SHORTCUT_ACCELERATOR, SHARE_SHORTCUT_KEY } from "./state";

const TARGET = {
  appId: "what-does-it-mean",
  name: "Clear Translate",
  url: "https://ray.romeos.cc/full/apps/what-does-it-mean",
  param: "text",
};

const settings = {
  read: (key: string) => (key === SHARE_SHORTCUT_KEY ? JSON.stringify(TARGET) : null),
  write: () => {},
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function press(): Promise<void> {
  electron.shortcuts.get(SHARE_SHORTCUT_ACCELERATOR)?.();
  await flush();
}

function selecting(text: string | null) {
  rs.mocked(readSelectedText).mockResolvedValue(text);
}

beforeEach(() => {
  rs.resetAllMocks();
  electron.shortcuts.clear();
  electron.windows.length = 0;
  electron.nextLoad.fails = false;
});

describe("setupShareShortcut", () => {
  it("opens the chosen app with the selection, but loads only once the Rome is reachable", async () => {
    let ready = () => {};
    setupShareShortcut(settings, () => new Promise<void>((resolve) => (ready = resolve)));
    selecting("serendipity");
    await press();
    const [panel] = electron.windows;
    expect(panel.visible).toBe(true);
    expect(panel.loads).toEqual([]);
    ready();
    await flush();
    expect(panel.loads).toEqual([`${TARGET.url}?text=serendipity`]);
  });

  it("reopens the page as it was left, but loads again after a failed load", async () => {
    setupShareShortcut(settings, async () => {});
    selecting(null);
    await press();
    const [panel] = electron.windows;
    panel.hide();
    await press();
    expect(panel.loads).toEqual([TARGET.url]);

    panel.hide();
    selecting("serendipity");
    electron.nextLoad.fails = true;
    await press();
    panel.hide();
    selecting(null);
    await press();
    expect(panel.loads).toEqual([TARGET.url, `${TARGET.url}?text=serendipity`, TARGET.url]);
  });

  it("closes the panel when pressed again with the same text or nothing selected", async () => {
    setupShareShortcut(settings, async () => {});
    selecting("serendipity");
    await press();
    const [panel] = electron.windows;
    expect(panel.visible).toBe(true);
    await press();
    expect(panel.visible).toBe(false);
    expect(panel.loads).toHaveLength(1);

    await press();
    selecting(null);
    await press();
    expect(panel.visible).toBe(false);
  });

  it("loads new text into the open panel", async () => {
    setupShareShortcut(settings, async () => {});
    selecting("serendipity");
    await press();
    selecting("温故知新");
    await press();
    const [panel] = electron.windows;
    expect(panel.visible).toBe(true);
    expect(panel.loads.map((url) => new URL(url).searchParams.get("text"))).toEqual([
      "serendipity",
      "温故知新",
    ]);
  });

  it("ignores a press while the previous one is still reading the selection", async () => {
    setupShareShortcut(settings, async () => {});
    let answer = (_text: string) => {};
    rs.mocked(readSelectedText).mockReturnValue(
      new Promise<string | null>((resolve) => (answer = resolve)),
    );
    electron.shortcuts.get(SHARE_SHORTCUT_ACCELERATOR)?.();
    electron.shortcuts.get(SHARE_SHORTCUT_ACCELERATOR)?.();
    answer("serendipity");
    await flush();
    expect(readSelectedText).toHaveBeenCalledOnce();
    expect(electron.windows[0].loads).toHaveLength(1);
  });
});

describe("refreshing the saved app", () => {
  function store() {
    let value: string | null = JSON.stringify(TARGET);
    return {
      read: (key: string) => (key === SHARE_SHORTCUT_KEY ? value : null),
      write: (_key: string, next: string) => {
        value = next;
      },
      saved: () => (value ? JSON.parse(value) : null),
    };
  }
  const identity = (shareTarget: unknown) =>
    ({ name: "Clear Translate", url: TARGET.url, icon: null, shareTarget }) as never;

  it("picks up a new page and size the app moved its share target to", async () => {
    const settings = store();
    rs.mocked(fetchAppIdentity).mockResolvedValue(
      identity({ url: `${TARGET.url}/quick`, param: "text", width: 380, height: 460 }),
    );
    setupShareShortcut(settings, async () => {});
    await flush();
    expect(fetchAppIdentity).toHaveBeenCalledWith(
      expect.any(Function),
      "https://ray.romeos.cc",
      TARGET.appId,
    );
    expect(settings.saved()).toEqual({
      ...TARGET,
      url: `${TARGET.url}/quick`,
      width: 380,
      height: 460,
    });
  });

  it("turns the key off when the app no longer takes shared text", async () => {
    const settings = store();
    rs.mocked(fetchAppIdentity).mockResolvedValue(identity(null));
    setupShareShortcut(settings, async () => {});
    await flush();
    expect(settings.saved()).toBeNull();
    expect(electron.shortcuts.has(SHARE_SHORTCUT_ACCELERATOR)).toBe(false);
  });

  it("keeps the saved app when the Rome can't be read", async () => {
    const settings = store();
    rs.mocked(fetchAppIdentity).mockRejectedValue(new Error("offline"));
    setupShareShortcut(settings, async () => {});
    await flush();
    expect(settings.saved()).toEqual(TARGET);
    expect(electron.shortcuts.has(SHARE_SHORTCUT_ACCELERATOR)).toBe(true);
  });

  it("moves an open panel to the app's new page and size when the app changes after launch", async () => {
    const settings = store();
    rs.mocked(fetchAppIdentity).mockResolvedValue(identity({ url: TARGET.url, param: "text" }));
    setupShareShortcut(settings, async () => {});
    await flush();
    // The app moves its target to a compact page after launch, before the first press.
    rs.mocked(fetchAppIdentity).mockResolvedValue(
      identity({ url: `${TARGET.url}/quick`, param: "text", width: 380, height: 460 }),
    );
    selecting("serendipity");
    await press();
    await flush();
    const [panel] = electron.windows;
    expect(panel.size).toEqual([380, 460]);
    expect(panel.loads.at(-1)).toBe(`${TARGET.url}/quick?text=serendipity`);
    expect(settings.saved()).toMatchObject({ url: `${TARGET.url}/quick`, width: 380 });
  });
});
