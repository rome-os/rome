// The WeChat personal-account connection: its conferral setup driven through
// the real SetupSession runtime, and its read-only Talk surfaces — both against
// a fake client runtime (no client, no python, no host script).
//
// Seams under test:
//   1. The setup coroutine — an already-ready account confers with no guardian
//      interaction; a fresh one installs, captures the keys while the guardian
//      scans, and confers once the store unlocks.
//   2. Read-only by construction: `send` throws, `directMessaging` answers null,
//      nothing is delivered into the agent pipeline.
//   3. The read surfaces map reader rows onto Talk's provider-neutral shapes.

import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId } from "@rome-os/app-runtime";
import type { InboundMessage } from "../types.js";
import type { WechatUserRuntime, WechatUserStatus } from "../../channels/wechat-user.js";
import { WechatUserStorePending } from "../../channels/wechat-user.js";
import { CredentialRejected } from "../errors.js";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import type { Credential, RuntimeKit, StreamFault, Talker } from "../types.js";
import { toWechatUserChannelMessage } from "../../channels/wechat-user-messages.js";
import {
  createWechatUserDescriptor,
  makeWechatUserSetup,
  WECHAT_USER_SERVICE,
  wechatUserGrantProfileSchema,
} from "./wechat-user.js";

/** A status as a test writes it; `display` and `desktopPath` default to
 *  WeChat's own desktop. */
type StatusInput = Omit<WechatUserStatus, "display" | "desktopPath" | "movePending"> &
  Partial<Pick<WechatUserStatus, "display" | "desktopPath" | "movePending">>;

const READY: StatusInput = {
  state: "ready",
  installed: true,
  running: true,
  loggedIn: true,
  keysReady: true,
  wxid: "wxid_guardian",
  pid: 42,
};

/**
 * A fake client runtime. `statuses` is consumed one per `status()` read and the
 * last entry repeats, so a test scripts the client walking through connecting.
 * Only the methods the setup and reader touch are implemented.
 */
function fakeRuntime(opts: {
  statuses: StatusInput[];
  /** What `wechat-cli sessions` answers. */
  sessions?: unknown;
  /** What the key capture does; it resolves at once by default. */
  onCapture?: (display: string) => Promise<void> | void;
  qr?: string | null;
}): WechatUserRuntime {
  const statuses = [...opts.statuses];
  const runtime = {
    desktopPathFor: rs.fn((display: string) =>
      display === ":100" ? "/desktop/wechat" : "/desktop",
    ),
    install: rs.fn(async () => {}),
    prepareSession: rs.fn(async () => {}),
    ensureDesktop: rs.fn(async () => ":100"),
    ensureAccessibility: rs.fn(async () => {}),
    repairDesktop: rs.fn(async () => {}),
    captureLoginQr: rs.fn(async () => opts.qr ?? null),
    captures: 0,
    holdCapture: rs.fn(function (this: { captures: number }) {
      this.captures += 1;
      return () => {
        this.captures -= 1;
      };
    }),
    start: rs.fn(async () => {}),
    stop: rs.fn(async () => {}),
    status: rs.fn(
      async (): Promise<WechatUserStatus> => ({
        display: ":100",
        desktopPath: "/desktop/wechat",
        movePending: false,
        ...(statuses.length > 1 ? statuses.shift()! : statuses[0]!),
      }),
    ),
    captureKeys: rs.fn(async (display: string, _signal?: AbortSignal) => {
      await opts.onCapture?.(display);
    }),
    bridgeCommand: rs.fn(async (args: string[]) => {
      if (args[0] === "sessions") return opts.sessions ?? [];
      return { messages: [], cursor: null };
    }),
  };
  return runtime as unknown as WechatUserRuntime;
}

function setupWith(runtime: WechatUserRuntime) {
  return {
    fn: makeWechatUserSetup({ runtime, pollIntervalMs: 1, qrPollIntervalMs: 1 }),
  };
}

describe("makeWechatUserSetup", () => {
  it("holds off ordinary launches from the install through the key capture", async () => {
    let heldDuringCapture = 0;
    const runtime = fakeRuntime({
      statuses: [
        { state: "absent", installed: false, running: false, loggedIn: false, keysReady: false },
        {
          state: "awaiting-keys",
          installed: true,
          running: true,
          loggedIn: true,
          keysReady: false,
        },
        READY,
      ],
      onCapture: () => {
        heldDuringCapture = held.captures;
      },
    });
    const held = runtime as unknown as { captures: number };
    let heldDuringPreparation = 0;
    runtime.prepareSession = rs.fn(async () => {
      heldDuringPreparation = held.captures;
    });
    const { fn } = setupWith(runtime);
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    // The page could otherwise start an ordinary client in the minutes between
    // the install and the capture, which the capture would then kill.
    expect(heldDuringPreparation).toBe(1);
    expect(heldDuringCapture).toBe(1);
    expect(held.captures).toBe(0);
  });

  it("confers with no guardian interaction when the account is already ready", async () => {
    const { fn } = setupWith(fakeRuntime({ statuses: [READY] }));
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    expect(commit).toHaveBeenCalledTimes(1);
    const conferral = commit.mock.calls[0][0];
    expect(conferral.credential.material).toEqual({
      custody: "rome-container",
      wxid: "wxid_guardian",
    });
    expect(wechatUserGrantProfileSchema.parse(conferral.profile).wxid).toBe("wxid_guardian");
    expect(conferral.summary?.body?.join(" ")).toContain("read-only");
  });

  it("resumes readable cached history without recapturing keys", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, state: "stopped", running: false }, READY],
    });
    const { fn } = setupWith(runtime);
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.captureKeys).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it("installs, then captures the keys on WeChat's own desktop", async () => {
    const runtime = fakeRuntime({
      statuses: [
        { state: "absent", installed: false, running: false, loggedIn: false, keysReady: false },
        // A legacy client still on the shared display when capture begins.
        {
          state: "awaiting-scan",
          installed: true,
          running: true,
          loggedIn: false,
          keysReady: false,
          pid: 42,
          display: ":99",
          desktopPath: "/desktop",
        },
        {
          state: "awaiting-keys",
          installed: true,
          running: true,
          loggedIn: true,
          keysReady: false,
          pid: 42,
          wxid: "wxid_guardian",
        },
        READY,
      ],
    });
    const { fn } = setupWith(runtime);
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    expect(runtime.install).toHaveBeenCalledTimes(1);
    expect(runtime.prepareSession).toHaveBeenCalledTimes(1);
    // The capture launches the client on WeChat's own desktop, so it must be
    // up first, and after the last status read: a legacy client still running
    // on the shared display would have pulled `display` back there.
    type Mocked = { mock: { invocationCallOrder: number[] } };
    const order = (fn: unknown) => (fn as Mocked).mock.invocationCallOrder;
    const capture = order(runtime.captureKeys)[0]!;
    const lastStatus = Math.max(...order(runtime.status).filter((at) => at < capture));
    expect(runtime.ensureDesktop).toHaveBeenCalledTimes(1);
    expect(order(runtime.ensureDesktop)[0]).toBeGreaterThan(lastStatus);
    expect(order(runtime.ensureDesktop)[0]).toBeLessThan(capture);
    // The capture launches the client under gdb, not the ordinary start.
    expect(runtime.start).not.toHaveBeenCalled();
    // The scan step polls the login window so the QR can be shown inline.
    // It screenshots, and links to, the display the capture launches on, not
    // the legacy client's that status() reported.
    expect(runtime.captureLoginQr).toHaveBeenCalled();
    for (const call of rs.mocked(runtime.captureLoginQr).mock.calls) expect(call[0]).toBe(":100");
    expect(runtime.captureKeys).toHaveBeenCalledTimes(1);
    expect(runtime.captureKeys).toHaveBeenCalledWith(":100", expect.any(AbortSignal));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("skips installation when the client is present but signed out", async () => {
    const runtime = fakeRuntime({
      statuses: [
        {
          state: "awaiting-scan",
          installed: true,
          running: true,
          loggedIn: false,
          keysReady: false,
          pid: 7,
        },
        {
          state: "awaiting-keys",
          installed: true,
          running: true,
          loggedIn: true,
          keysReady: false,
          pid: 7,
          wxid: "wxid_guardian",
        },
        READY,
      ],
    });
    const { fn } = setupWith(runtime);
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    expect(runtime.install).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.prepareSession).toHaveBeenCalledTimes(1);
  });

  it("does not confer when the message shard cannot be unlocked", async () => {
    const locked = { ...READY, state: "awaiting-keys" as const, keysReady: false };
    const runtime = fakeRuntime({
      statuses: [locked],
      onCapture: () => {
        throw new Error("the captured passphrase does not open this account");
      },
    });
    const { fn } = setupWith(runtime);
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(commit).not.toHaveBeenCalled();
  });

  it("fails rather than waits when the login had not created every shard", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, state: "awaiting-keys", keysReady: false }],
      onCapture: () => {
        throw new WechatUserStorePending("WeChat had not finished creating message/message_0.db");
      },
    });
    const { fn } = setupWith(runtime);
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(commit).not.toHaveBeenCalled();
  });

  it("links a resuming client to the desktop that shows it", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, state: "stopped", running: false }, READY],
    });
    let started!: () => void;
    rs.mocked(runtime.start).mockImplementation(
      () => new Promise<void>((resolve) => (started = resolve)),
    );
    const { fn } = setupWith(runtime);
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });
    await session.started();

    await rs.waitFor(() => expect(runtime.start).toHaveBeenCalled());
    const state = session.state;
    expect(state.status === "presenting" && state.view.title).toBe("Resuming WeChat");
    expect(state.status === "presenting" && state.view.links?.[0]?.url).toBe("/desktop/wechat");

    started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
  });

  it("sends a remembered account to the desktop instead of streaming a QR", async () => {
    const signedOut = { ...READY, state: "awaiting-scan" as const, keysReady: false };
    const runtime = fakeRuntime({
      statuses: [signedOut, signedOut, READY],
      qr: "data:image/png;base64,button",
    });
    let finishLogin!: () => void;
    rs.mocked(runtime.captureKeys).mockImplementation(
      () => new Promise<void>((resolve) => (finishLogin = resolve)),
    );
    const { fn } = setupWith(runtime);
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });
    await session.started();

    await rs.waitFor(() => expect(runtime.captureKeys).toHaveBeenCalled());
    const state = session.state;
    expect(state.status === "presenting" && state.view.title).toBe("Sign in to WeChat");
    expect(state.status === "presenting" && state.view.qr).toBeUndefined();
    // The sign-in button is on WeChat's own display, so the link goes there.
    expect(state.status === "presenting" && state.view.links?.[0]?.url).toBe("/desktop/wechat");
    expect(runtime.captureLoginQr).not.toHaveBeenCalled();

    finishLogin();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
  });
});

describe("toWechatUserChannelMessage", () => {
  it("attributes an authorless notice to the chat it arrived in", () => {
    const message = toWechatUserChannelMessage({
      id: "notifymessage:44",
      conversationId: "notifymessage",
      isGroup: false,
      senderId: "",
      isSelf: false,
      timestamp: 1789346665,
      type: "link",
      text: "[链接] 洗衣完成通知",
    });
    expect(message.senderId).toBe("notifymessage");
    expect(message.thread?.kind).toBe("dm");
  });

  it("carries the group name and sender through", () => {
    const message = toWechatUserChannelMessage({
      id: "45357963768@chatroom:8123",
      conversationId: "45357963768@chatroom",
      conversationName: "Karball",
      isGroup: true,
      senderId: "wxid_zhs",
      senderName: "曾华盛",
      isSelf: false,
      timestamp: 1789348325,
      type: "text",
      text: "哈喽",
    });
    expect(message.senderId).toBe("wxid_zhs");
    expect(message.senderDisplayName).toBe("曾华盛");
    expect(message.thread).toEqual({ kind: "group", name: "Karball" });
  });
});

describe("the WeChat personal Talker", () => {
  function buildTalker(
    runtime: WechatUserRuntime,
    fault: (err: StreamFault) => void = () => {},
    probeIntervalMs = 60_000,
  ) {
    const descriptor = createWechatUserDescriptor({ runtime, probeIntervalMs });
    const kit = {
      connectionId: "conn-wechat-user",
      persist: async () => {},
      registerIngress: () => () => {},
    } satisfies RuntimeKit;
    const credential: Credential = {
      material: { custody: "rome-container", wxid: "wxid_guardian" },
      expiresAt: "never",
    };
    const talker = descriptor.capabilities.talker!.build({ session: credential }, kit);
    const deliver = rs.fn();
    talker.start(deliver as unknown as (msg: InboundMessage) => void, fault);
    return {
      talker,
      deliver,
      degradation: () => descriptor.capabilities.talker!.degradation!(talker),
    };
  }

  it("resumes a stopped client even when the cached store is readable", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, running: false, pid: undefined }, READY],
    });
    const fault = rs.fn();
    const { talker } = buildTalker(runtime, fault);
    try {
      await rs.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
      expect(fault).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("turns accessibility on for a client that is already running", async () => {
    const runtime = fakeRuntime({ statuses: [READY] });
    rs.mocked(runtime.prepareSession).mockRejectedValue(new Error("dbus-daemon failed"));
    const { talker, degradation } = buildTalker(runtime);
    try {
      await rs.waitFor(() => expect(runtime.ensureAccessibility).toHaveBeenCalledTimes(1));
      await rs.waitFor(() => expect(degradation()).toBeNull());
      expect(runtime.prepareSession).not.toHaveBeenCalled();
      expect(runtime.start).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("repairs the desktop under a client that is already running", async () => {
    // A crashed websockify or Openbox would otherwise leave /desktop/wechat
    // broken until the client itself exits.
    const runtime = fakeRuntime({ statuses: [READY] });
    const { talker } = buildTalker(runtime);
    try {
      await rs.waitFor(() => expect(runtime.repairDesktop).toHaveBeenCalledTimes(1));
      expect(runtime.start).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("tells the guardian a client still on the shared desktop needs a restart to move", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, display: ":99", desktopPath: "/desktop", movePending: true }],
    });
    const { talker, degradation } = buildTalker(runtime);
    try {
      await rs.waitFor(() => expect(degradation()?.reason).toContain("shared desktop"));
      // There is no restart button: quitting WeChat on the shared desktop lets
      // the probe start it again on its own.
      expect(degradation()?.reason).toContain("quit WeChat at /desktop");
      expect(degradation()?.reason).toContain("/desktop/wechat");
      expect(runtime.start).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("leaves accessibility to start() for a client the probe restarts", async () => {
    const runtime = fakeRuntime({ statuses: [{ ...READY, running: false }, READY] });
    const { talker, degradation } = buildTalker(runtime);
    try {
      await rs.waitFor(() => expect(degradation()).toBeNull());
      expect(runtime.start).toHaveBeenCalledTimes(1);
      expect(runtime.prepareSession).not.toHaveBeenCalled();
      expect(runtime.ensureAccessibility).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("retries a failed client launch without rejecting the grant", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, state: "stopped", running: false }],
    });
    rs.mocked(runtime.start).mockRejectedValue(new Error("desktop unavailable"));
    const fault = rs.fn();
    const { talker, degradation } = buildTalker(runtime, fault, 5);
    try {
      await rs.waitFor(() =>
        expect(rs.mocked(runtime.start).mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      expect(degradation()?.reason).toContain("desktop unavailable");
      expect(fault).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("rejects a running login screen with no cached account", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, state: "awaiting-scan", loggedIn: false, keysReady: false }],
    });
    const fault = rs.fn();
    const { talker } = buildTalker(runtime, fault);
    try {
      await rs.waitFor(() => expect(fault).toHaveBeenCalledWith(expect.any(CredentialRejected)));
      expect(fault.mock.calls[0]![0].grant).toBe("session");
      expect(runtime.start).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("reports phone confirmation without restarting a running client", async () => {
    const runtime = fakeRuntime({ statuses: [{ ...READY, state: "awaiting-scan" }] });
    const fault = rs.fn();
    const { talker, degradation } = buildTalker(runtime, fault);
    try {
      await rs.waitFor(() => expect(degradation()?.reason).toContain("phone"));
      expect(runtime.start).not.toHaveBeenCalled();
      expect(fault).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("recovers a later crash and clears degradation after the client resumes", async () => {
    const runtime = fakeRuntime({ statuses: [READY, { ...READY, running: false }, READY] });
    const { talker, degradation } = buildTalker(runtime, undefined, 5);
    try {
      await rs.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1));
      await rs.waitFor(() => expect(degradation()).toBeNull());
    } finally {
      await talker.stop();
    }
  });

  it("drains an in-flight probe on stop without launching the client", async () => {
    const runtime = fakeRuntime({ statuses: [READY] });
    let resolve!: (status: WechatUserStatus) => void;
    rs.mocked(runtime.status).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { talker } = buildTalker(runtime, undefined, 1);
    const stopped = talker.stop();
    resolve({
      display: ":100",
      desktopPath: "/desktop/wechat",
      movePending: false,
      ...READY,
      running: false,
    });
    await stopped;
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.status).toHaveBeenCalledTimes(1);
  });

  it("is read-only: send throws, direct messaging is absent, nothing delivered", async () => {
    const { talker, deliver } = buildTalker(fakeRuntime({ statuses: [READY] }));

    await expect(talker.send("wxid_friend" as ConversationId, { text: "hi" })).rejects.toThrow(
      /read-only/,
    );
    expect(talker.feature("directMessaging")).toBeNull();
    expect(deliver).not.toHaveBeenCalled();

    await talker.stop();
  });

  it("lists conversations as provider-neutral descriptors", async () => {
    const runtime = fakeRuntime({
      statuses: [READY],
      sessions: [
        {
          username: "45357963768@chatroom",
          displayName: "Karball",
          type: "group",
          unread: 1,
          lastMessage: { content: "hi", createdAt: "2026-10-01T00:00:00.000Z" },
        },
        {
          username: "wxid_friend",
          displayName: "A Friend",
          type: "private",
          unread: 0,
          lastMessage: { content: "yo", createdAt: "2026-09-30T00:00:00.000Z" },
        },
        // A folded entry is a row in the session list, not a chat.
        { username: "brandsessionholder", displayName: "订阅号消息", type: "folded", unread: 0 },
      ],
    });
    const { talker } = buildTalker(runtime);

    const page = await talker.feature("directory")!.listConversations({ limit: 10 });
    expect(page.conversations).toEqual([
      {
        ref: { connectionId: "conn-wechat-user", conversationId: "45357963768@chatroom" },
        service: WECHAT_USER_SERVICE,
        kind: "group",
        displayName: "Karball",
      },
      {
        ref: { connectionId: "conn-wechat-user", conversationId: "wxid_friend" },
        service: WECHAT_USER_SERVICE,
        kind: "dm",
        displayName: "A Friend",
      },
    ]);

    await talker.stop();
  });

  // What was said is the channel's `messages`, read through the same reader
  // (wechat-user-messages.ts). The Talk offers only the directory.
  it("leaves history to the channel", async () => {
    const { talker } = buildTalker(fakeRuntime({ statuses: [READY] }));
    expect(talker.feature("history")).toBeNull();
    expect(
      createWechatUserDescriptor({ runtime: fakeRuntime({ statuses: [READY] }) }).capabilities
        .talker?.history,
    ).toBeUndefined();
    await talker.stop();
  });
});
