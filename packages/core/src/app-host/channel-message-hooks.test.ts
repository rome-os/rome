import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessageHookDeps } from "@rome-os/app-runtime";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelMessageHook } from "./app-actions-wiring.js";
import { ChannelMessageHooks } from "./channel-message-hooks.js";
import { bumpModuleEnvEpoch } from "../apps/actions/module-loader.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ArtifactRef } from "../apps/state.js";

const TEST_KEY = "CHANNEL_MESSAGE_RELOAD_PROBE";

/** What the probe hooks below write as they hear and register. */
type Heard = Array<{ app: string; event: string }>;

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env[TEST_KEY];
  delete (globalThis as { heard?: Heard }).heard;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function hookModule(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "channel-message-hooks-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "index.js"), body, "utf-8");
  return dir;
}

/** A hook that hears every message through `deps.messagesSaid`, noting each
 *  in `globalThis.heard` under `app`. */
function hearingHook(app: string): Promise<string> {
  return hookModule(`
export function createHook(deps) {
  let off;
  return {
    async register() {
      off = deps.messagesSaid.subscribe(async (event) => {
        globalThis.heard.push({ app: ${JSON.stringify(app)}, event: event.message.text });
      });
    },
    unregister() { off?.(); },
  };
}
`);
}

function artifact(ownerId: string, absolutePath: string): ArtifactRef {
  return {
    kind: "hook",
    publicName: "channel-message",
    aliases: [],
    ownerType: "app",
    ownerId,
    absolutePath,
  };
}

/** A catalog whose hooks are whatever `hooks` holds when it is asked. */
function catalogOf(hooks: ArtifactRef[]): Pick<AppCatalog, "listArtifacts"> {
  return { listArtifacts: (kind) => (kind === "hook" ? hooks : []) };
}

/** A messagesSaid that hands each said message to every subscriber. */
function messagesSaid() {
  const subscribers = new Set<(event: unknown) => Promise<void>>();
  return {
    subscribe(handler: (event: unknown) => Promise<void>) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    async decided() {},
    async say(text: string) {
      for (const handler of subscribers) await handler({ message: { text } });
    },
  };
}

function setup(hooks: ArtifactRef[], options: { mayLoad?: (appId: string) => boolean } = {}) {
  const heard: Heard = [];
  (globalThis as { heard?: Heard }).heard = heard;
  const said = messagesSaid();
  const failed: Array<[string, string]> = [];
  const hookSet = new ChannelMessageHooks({
    catalog: catalogOf(hooks),
    deps: { messagesSaid: said, channels: [] } as unknown as ChannelMessageHookDeps,
    onFailed: (appId, error) => failed.push([appId, error]),
    log: { warn: () => {} },
    ...options,
  });
  return { hooks: hookSet, said, heard, failed };
}

describe("ChannelMessageHooks", () => {
  it("loads every app's hook, and each hears every message", async () => {
    const t = setup([
      artifact("inbox", await hearingHook("inbox")),
      artifact("cos", await hearingHook("cos")),
    ]);

    await t.hooks.start();
    await t.said.say("the planner slipped");

    expect(t.hooks.size).toBe(2);
    expect(t.heard).toEqual([
      { app: "inbox", event: "the planner slipped" },
      { app: "cos", event: "the planner slipped" },
    ]);
  });

  it("keeps one app's hook live when another's fails to load or to register", async () => {
    const noFactory = await hookModule("export const nothing = 1;");
    const throwsOnRegister = await hookModule(`
export function createHook() {
  return { async register() { throw new Error("register exploded"); }, unregister() {} };
}
`);
    const t = setup([
      artifact("broken", noFactory),
      artifact("inbox", await hearingHook("inbox")),
      artifact("exploding", throwsOnRegister),
    ]);

    await t.hooks.start();
    await t.said.say("hello");

    expect(t.heard).toEqual([{ app: "inbox", event: "hello" }]);
    expect(t.failed.map(([appId]) => appId)).toEqual(["broken", "exploding"]);
    expect(t.failed[1][1]).toBe("register exploded");
  });

  it("stops only the removed app's hook, and starts an installed app's", async () => {
    const hooks = [
      artifact("inbox", await hearingHook("inbox")),
      artifact("cos", await hearingHook("cos")),
    ];
    const t = setup(hooks);
    await t.hooks.start();

    hooks.splice(1, 1);
    await t.hooks.follow("cos");
    await t.said.say("after removing cos");

    hooks.push(artifact("cos", await hearingHook("cos")));
    await t.hooks.follow("cos");
    await t.said.say("after installing cos again");

    expect(t.heard).toEqual([
      { app: "inbox", event: "after removing cos" },
      { app: "inbox", event: "after installing cos again" },
      { app: "cos", event: "after installing cos again" },
    ]);
  });

  it("loads an app's hook only while it may load", async () => {
    let inboxMayLoad = false;
    const t = setup(
      [artifact("inbox", await hearingHook("inbox")), artifact("cos", await hearingHook("cos"))],
      { mayLoad: (appId) => appId !== "inbox" || inboxMayLoad },
    );

    await t.hooks.start();
    await t.said.say("before");
    inboxMayLoad = true;
    await t.hooks.follow("inbox");
    await t.said.say("after");

    expect(t.heard).toEqual([
      { app: "cos", event: "before" },
      { app: "cos", event: "after" },
      { app: "inbox", event: "after" },
    ]);
  });

  it("recreates each hook on reload, so a module-scope env capture follows save and delete", async () => {
    const dir = await hookModule(`
const captured = process.env.${TEST_KEY} ?? "unset";
export function createHook(deps) {
  let off;
  return {
    async register() {
      off = deps.messagesSaid.subscribe(async () => { globalThis.heard.push({ app: "probe", event: captured }); });
    },
    unregister() { off?.(); },
  };
}
`);
    const t = setup([artifact("probe", dir)]);
    await t.hooks.start();

    process.env[TEST_KEY] = "v1";
    bumpModuleEnvEpoch();
    await t.hooks.reload();
    await t.said.say("x");

    delete process.env[TEST_KEY];
    bumpModuleEnvEpoch();
    await t.hooks.reload();
    await t.said.say("x");

    expect(t.heard.map((h) => h.event)).toEqual(["v1", "unset"]);
  });

  it("loads a hook that failed at boot for want of a key once the key is saved", async () => {
    const dir = await hookModule(`
if (!process.env.${TEST_KEY}) throw new Error("${TEST_KEY} is not set");
export function createHook(deps) {
  let off;
  return {
    async register() {
      off = deps.messagesSaid.subscribe(async () => { globalThis.heard.push({ app: "keyed", event: "heard" }); });
    },
    unregister() { off?.(); },
  };
}
`);
    const t = setup([artifact("keyed", dir)]);
    await t.hooks.start();
    expect(t.failed.map(([appId]) => appId)).toEqual(["keyed"]);

    process.env[TEST_KEY] = "v1";
    bumpModuleEnvEpoch();
    await t.hooks.reload();
    await t.said.say("x");

    expect(t.hooks.size).toBe(1);
    expect(t.heard).toEqual([{ app: "keyed", event: "heard" }]);
  });

  it("leaves one hook per app when a reload and a catalog change overlap", async () => {
    const hooks = [artifact("inbox", await hearingHook("inbox"))];
    const t = setup(hooks);
    await t.hooks.start();

    bumpModuleEnvEpoch();
    await Promise.all([t.hooks.reload(), t.hooks.follow("inbox"), t.hooks.reload()]);
    await t.said.say("once");

    expect(t.heard).toEqual([{ app: "inbox", event: "once" }]);
  });

  it("never brings back the hook of an app removed while a reload runs", async () => {
    const hooks = [artifact("cos", await hearingHook("cos"))];
    const t = setup(hooks);
    await t.hooks.start();

    bumpModuleEnvEpoch();
    const reloading = t.hooks.reload();
    hooks.splice(0, 1);
    await Promise.all([reloading, t.hooks.follow("cos")]);
    await t.said.say("after removal");

    expect(t.heard).toEqual([]);
  });

  it("clears an app's reported failure when the catalog changes it", async () => {
    const reset: string[] = [];
    const hooks = [artifact("broken", await hookModule("export const nothing = 1;"))];
    const t = setup(hooks);
    const withReset = new ChannelMessageHooks({
      catalog: catalogOf(hooks),
      deps: { messagesSaid: t.said, channels: [] } as unknown as ChannelMessageHookDeps,
      onFailed: () => {},
      onReset: (appId) => reset.push(appId),
      log: { warn: () => {} },
    });
    await withReset.start();

    hooks.splice(0, 1);
    await withReset.follow("broken");

    expect(reset).toEqual(["broken"]);
  });

  it("keeps a hook without unregister() in place rather than double-registering", async () => {
    const dir = await hookModule(`
export function createHook(deps) {
  return {
    async register() {
      deps.messagesSaid.subscribe(async () => { globalThis.heard.push({ app: "sticky", event: "heard" }); });
    },
  };
}
`);
    const t = setup([artifact("sticky", dir)]);
    await t.hooks.start();

    await t.hooks.reload();
    await t.hooks.follow("sticky");
    await t.said.say("x");

    expect(t.heard).toHaveLength(1);
  });

  it("restores the previous hook when the reloaded one fails to register", async () => {
    const dir = await hookModule(`
const attempt = (globalThis.attempts = (globalThis.attempts ?? 0) + 1);
export function createHook(deps) {
  let off;
  return {
    async register() {
      if (attempt > 1) throw new Error("register exploded");
      off = deps.messagesSaid.subscribe(async () => { globalThis.heard.push({ app: "probe", event: "first" }); });
    },
    unregister() { off?.(); },
  };
}
`);
    const t = setup([artifact("probe", dir)]);
    await t.hooks.start();

    bumpModuleEnvEpoch();
    await t.hooks.reload();
    await t.said.say("x");
    delete (globalThis as { attempts?: number }).attempts;

    expect(t.heard).toEqual([{ app: "probe", event: "first" }]);
  });

  it("has every live hook hear a channel added later", async () => {
    const withAdd = await hookModule(`
export function createHook() {
  return { async register() {}, async addChannels(c) { globalThis.heard.push({ app: "adds", event: c[0].name }); }, unregister() {} };
}
`);
    const reRegisters = await hookModule(`
export function createHook() {
  return { async register() { globalThis.heard.push({ app: "re", event: "register" }); }, unregister() {} };
}
`);
    const t = setup([artifact("adds", withAdd), artifact("re", reRegisters)]);
    await t.hooks.start();

    await t.hooks.addChannels([{ name: "feishu-2" }] as never);

    expect(t.heard).toEqual([
      { app: "re", event: "register" },
      { app: "adds", event: "feishu-2" },
      { app: "re", event: "register" },
    ]);
  });
});

describe("createChannelMessageHook", () => {
  it("names the migration when a hook still defines registerConnection", async () => {
    const legacy = await hookModule(`
export function createHook() {
  return { async register() {}, registerConnection() {}, unregister() {} };
}
`);
    const current = await hookModule(`
export function createHook() {
  return { async register() {}, unregister() {} };
}
`);
    const warn = rs.fn();

    await createChannelMessageHook(artifact("inbox", legacy), {} as ChannelMessageHookDeps, {
      warn,
    });
    await createChannelMessageHook(artifact("inbox", current), {} as ChannelMessageHookDeps, {
      warn,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "channel-message hook defines the removed registerConnection; subscribe through deps.channels in register()",
      { owner: "inbox" },
    );
  });

  it("tells a hook built against SDK 0.6 that deps.talkRouter is gone", async () => {
    const dir = await hookModule(`
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

    const hook = (await createChannelMessageHook(artifact("inbox", dir), {
      channels,
    } as ChannelMessageHookDeps)) as unknown as {
      listed: boolean;
      channels: unknown;
      register(): Promise<void>;
    };

    expect(hook.listed).toBe(false);
    expect(hook.channels).toBe(channels);
    await expect(hook.register()).rejects.toThrow(
      "deps.talkRouter was removed in @rome-os/app-runtime 0.7: a hook hears through deps.channels (channel.inbound.subscribe) and answers through channel.send",
    );
  });
});
