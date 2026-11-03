import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessageHookDeps } from "@rome-os/app-runtime";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChannelMessageHookFromCatalog,
  createChannelMessageHookReloader,
  createNoopChannelMessageHook,
} from "./app-actions-wiring.js";
import { bumpModuleEnvEpoch } from "./module-loader.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ChannelMessageHook } from "../hooks/types.js";

const TEST_KEY = "CHANNEL_MESSAGE_RELOAD_PROBE";

type ProbeHook = ChannelMessageHook & { secret: string; registered: boolean };

function catalogWithHookDir(dir: string): AppCatalog {
  return {
    listArtifacts: (kind: string) =>
      kind === "hook"
        ? [{ publicName: "channel-message", absolutePath: dir, ownerId: "inbox" }]
        : [],
  } as unknown as AppCatalog;
}

describe("createChannelMessageHookReloader", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete process.env[TEST_KEY];
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeHookModule(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "channel-message-reload-"));
    tempDirs.push(dir);
    await writeFile(join(dir, "index.js"), body, "utf-8");
    return dir;
  }

  it("recreates the hook so a module-scope env capture follows save and delete", async () => {
    const dir = await writeHookModule(`
const captured = process.env.${TEST_KEY} ?? "unset";
export function createHook() {
  return {
    secret: captured,
    registered: false,
    async register() { this.registered = true; },
    unregister() {},
  };
}
`);

    // Boot failed for want of the key: the live hook is the noop placeholder.
    let current: ChannelMessageHook = createNoopChannelMessageHook();
    const reload = createChannelMessageHookReloader({
      catalog: catalogWithHookDir(dir),
      deps: {} as ChannelMessageHookDeps,
      getCurrent: () => current,
      setCurrent: (hook) => {
        current = hook;
      },
    });

    // Save: the key goes live, the refresh recreates the hook against it.
    process.env[TEST_KEY] = "v1";
    bumpModuleEnvEpoch();
    await reload();
    expect((current as ProbeHook).secret).toBe("v1");
    expect((current as ProbeHook).registered).toBe(true);

    // Delete: the recreated hook no longer sees the removed value.
    delete process.env[TEST_KEY];
    bumpModuleEnvEpoch();
    await reload();
    expect((current as ProbeHook).secret).toBe("unset");
  });

  it("keeps a hook without unregister() in place rather than double-registering", async () => {
    const dir = await writeHookModule(`
export function createHook() {
  return { async register() {} };
}
`);
    const previous = {
      async register() {},
    } as ChannelMessageHook;
    let current: ChannelMessageHook = previous;
    const onSkip = rs.fn();
    const reload = createChannelMessageHookReloader({
      catalog: catalogWithHookDir(dir),
      deps: {} as ChannelMessageHookDeps,
      getCurrent: () => current,
      setCurrent: (hook) => {
        current = hook;
      },
      onSkip,
    });

    await reload();
    expect(current).toBe(previous);
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("restores and re-registers the previous hook when the fresh one fails to register", async () => {
    const dir = await writeHookModule(`
export function createHook() {
  return {
    async register() { throw new Error("register exploded"); },
    unregister() {},
  };
}
`);
    const previous = {
      register: rs.fn(async () => {}),
      unregister: rs.fn(),
    };
    let current: ChannelMessageHook = previous;
    const reload = createChannelMessageHookReloader({
      catalog: catalogWithHookDir(dir),
      deps: {} as ChannelMessageHookDeps,
      getCurrent: () => current,
      setCurrent: (hook) => {
        current = hook;
      },
    });

    await expect(reload()).rejects.toThrow("register exploded");
    expect(current).toBe(previous);
    expect(previous.unregister).toHaveBeenCalledOnce();
    expect(previous.register).toHaveBeenCalledOnce();
  });
  it("names the migration when a loaded hook still defines registerConnection", async () => {
    const legacy = await writeHookModule(`
export function createHook() {
  return { async register() {}, registerConnection() {}, unregister() {} };
}
`);
    const current = await writeHookModule(`
export function createHook() {
  return { async register() {}, unregister() {} };
}
`);
    const warn = rs.fn();

    await createChannelMessageHookFromCatalog(
      catalogWithHookDir(legacy),
      {} as ChannelMessageHookDeps,
      { warn },
    );
    await createChannelMessageHookFromCatalog(
      catalogWithHookDir(current),
      {} as ChannelMessageHookDeps,
      { warn },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "channel-message hook defines the removed registerConnection; subscribe through deps.channels in register()",
      { owner: "inbox" },
    );
  });

  it("tells a hook built against SDK 0.6 that deps.talkRouter is gone", async () => {
    const dir = await writeHookModule(`
export function createHook(deps) {
  return {
    listed: Object.keys(deps).includes("talkRouter"),
    channels: deps.channels,
    async register() {
      deps.talkRouter.subscribe("c-1", async () => {});
    },
  };
}
`);
    const channels = [] as ChannelMessageHookDeps["channels"];

    const hook = (await createChannelMessageHookFromCatalog(catalogWithHookDir(dir), {
      channels,
    } as ChannelMessageHookDeps)) as ChannelMessageHook & { listed: boolean; channels: unknown };

    expect(hook.listed).toBe(false);
    expect(hook.channels).toBe(channels);
    await expect(hook.register()).rejects.toThrow(
      "deps.talkRouter was removed in @rome-os/app-runtime 0.7: a hook hears through deps.channels (channel.inbound.subscribe) and answers through channel.send",
    );
  });
});
