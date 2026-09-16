// The WeChat personal-account connection: its conferral setup driven through
// the real SetupSession runtime, and its read-only Talk surfaces — both against
// a fake client runtime (no client, no python, no host script).
//
// Seams under test:
//   1. The setup coroutine — an already-ready account confers with no guardian
//      interaction; a fresh one installs, waits for the scan, recovers the key
//      via the injected root-script step, and confers once the store unlocks.
//   2. Read-only by construction: `send` throws, `directMessaging` answers null,
//      nothing is delivered into the agent pipeline.
//   3. The read surfaces map reader rows onto Talk's provider-neutral shapes.

import { describe, expect, it, rs } from "@rstest/core";
import type { ConversationId, InboundMessage } from "@rome-os/app-runtime";
import type { WechatUserRuntime, WechatUserStatus } from "../../channels/wechat-user.js";
import { WechatUserStorePending } from "../../channels/wechat-user.js";
import { CredentialRejected } from "../errors.js";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import type { Credential, RuntimeKit, StreamFault, Talker } from "../types.js";
import {
  createWechatUserDescriptor,
  makeWechatUserSetup,
  toWechatUserInboundMessage,
  WECHAT_USER_SERVICE,
  wechatUserGrantProfileSchema,
} from "./wechat-user.js";

const READY: WechatUserStatus = {
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
  statuses: WechatUserStatus[];
  readerJson?: unknown;
  onDerive?: (passphrase: string) => void;
  qr?: string | null;
}): WechatUserRuntime {
  const statuses = [...opts.statuses];
  const runtime = {
    install: rs.fn(async () => {}),
    installReader: rs.fn(async () => {}),
    prepareSession: rs.fn(async () => {}),
    captureLoginQr: rs.fn(async () => opts.qr ?? null),
    start: rs.fn(async () => {}),
    stop: rs.fn(async () => {}),
    status: rs.fn(async () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!)),
    readerCommand: rs.fn(async (args: string[]) => {
      if (args[0] === "derive") {
        opts.onDerive?.(args[2] ?? "");
        return { derived: 1 };
      }
      return opts.readerJson ?? { conversations: [] };
    }),
  };
  return runtime as unknown as WechatUserRuntime;
}

function setupWith(
  runtime: WechatUserRuntime,
  recoverPassphrase = rs.fn(async (_signal: AbortSignal) => "a".repeat(64)),
) {
  const stageDriver = rs.fn(async () => {});
  return {
    fn: makeWechatUserSetup({
      runtime,
      recoverPassphrase,
      stageDriver,
      pollIntervalMs: 1,
      qrPollIntervalMs: 1,
    }),
    recoverPassphrase,
    stageDriver,
  };
}

describe("makeWechatUserSetup", () => {
  it("rejects missing host execution before installing the client", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, installed: false, keysReady: false, state: "absent" }],
    });
    const fn = createWechatUserDescriptor({ runtime }).auth.session.setup!;
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(runtime.install).not.toHaveBeenCalled();
    expect(runtime.installReader).not.toHaveBeenCalled();
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
    const { fn, recoverPassphrase, stageDriver } = setupWith(runtime);
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(recoverPassphrase).not.toHaveBeenCalled();
    expect(stageDriver).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it("installs, launches under gdb to capture the passphrase, then derives it once", async () => {
    const runtime = fakeRuntime({
      statuses: [
        { state: "absent", installed: false, running: false, loggedIn: false, keysReady: false },
        {
          state: "awaiting-scan",
          installed: true,
          running: true,
          loggedIn: false,
          keysReady: false,
          pid: 42,
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
    const { fn, recoverPassphrase, stageDriver } = setupWith(runtime);
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));

    expect(runtime.install).toHaveBeenCalledTimes(1);
    expect(runtime.installReader).toHaveBeenCalledTimes(1);
    expect(runtime.prepareSession).toHaveBeenCalledTimes(1);
    // The client is launched by recovery under gdb, not started the ordinary way.
    expect(runtime.start).not.toHaveBeenCalled();
    expect(stageDriver).toHaveBeenCalledTimes(1);
    // The scan step polls the login window so the QR can be shown inline.
    expect(runtime.captureLoginQr).toHaveBeenCalled();
    expect(recoverPassphrase).toHaveBeenCalledTimes(1);
    expect(runtime.readerCommand).toHaveBeenCalledWith(
      ["derive", "--passphrase", "a".repeat(64)],
      expect.anything(),
    );
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
    expect(runtime.installReader).toHaveBeenCalledTimes(1);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.prepareSession).toHaveBeenCalledTimes(1);
  });

  it("does not confer when the message shard cannot be unlocked", async () => {
    const locked = { ...READY, state: "awaiting-keys" as const, keysReady: false };
    const runtime = fakeRuntime({
      statuses: [locked],
      onDerive: () => {
        throw new Error("message/message_0.db has no valid key");
      },
    });
    const { fn } = setupWith(runtime);
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps the captured passphrase while the client creates message shards", async () => {
    let attempts = 0;
    const runtime = fakeRuntime({
      statuses: [{ ...READY, state: "awaiting-keys", keysReady: false }, READY],
      onDerive: () => {
        if (++attempts === 1)
          throw new WechatUserStorePending("Message database is not available yet");
      },
    });
    const { fn, recoverPassphrase } = setupWith(runtime);
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn, commit });
    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(attempts).toBe(2);
    expect(recoverPassphrase).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("sends a remembered account to the desktop instead of streaming a QR", async () => {
    const signedOut = { ...READY, state: "awaiting-scan" as const, keysReady: false };
    const runtime = fakeRuntime({
      statuses: [signedOut, signedOut, READY],
      qr: "data:image/png;base64,button",
    });
    let finishLogin!: (passphrase: string) => void;
    const recoverPassphrase = rs.fn(
      (_signal: AbortSignal) => new Promise<string>((resolve) => (finishLogin = resolve)),
    );
    const { fn } = setupWith(runtime, recoverPassphrase);
    const session = new SetupSession({ fn, commit: rs.fn(async () => {}) });
    await session.started();

    await rs.waitFor(() => expect(recoverPassphrase).toHaveBeenCalled());
    const state = session.state;
    expect(state.status === "presenting" && state.view.title).toBe("Sign in to WeChat");
    expect(state.status === "presenting" && state.view.qr).toBeUndefined();
    expect(runtime.captureLoginQr).not.toHaveBeenCalled();

    finishLogin("a".repeat(64));
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
  });
});

describe("toWechatUserInboundMessage", () => {
  it("attributes an authorless notice to the chat it arrived in", () => {
    const message = toWechatUserInboundMessage({
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
    const message = toWechatUserInboundMessage({
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
      expect(runtime.installReader).not.toHaveBeenCalled();
    } finally {
      await talker.stop();
    }
  });

  it("keeps history available and retries a failed client launch without rejecting the grant", async () => {
    const runtime = fakeRuntime({
      statuses: [{ ...READY, state: "stopped", running: false }],
      readerJson: { messages: [] },
    });
    rs.mocked(runtime.start).mockRejectedValue(new Error("desktop unavailable"));
    const fault = rs.fn();
    const { talker, degradation } = buildTalker(runtime, fault, 5);
    try {
      await rs.waitFor(() =>
        expect(rs.mocked(runtime.start).mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      expect(degradation()?.reason).toContain("desktop unavailable");
      expect(await talker.feature("history")!.query({ limit: 1 })).toEqual([]);
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
    resolve({ ...READY, running: false });
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
      readerJson: {
        conversations: [
          { id: "45357963768@chatroom", name: "Karball", isGroup: true, unread: 1 },
          { id: "wxid_friend", name: "A Friend", isGroup: false, unread: 0 },
        ],
      },
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

  it("reads history through the reader", async () => {
    const runtime = fakeRuntime({
      statuses: [READY],
      readerJson: {
        messages: [
          {
            id: "wxid_friend:5",
            conversationId: "wxid_friend",
            conversationName: "A Friend",
            isGroup: false,
            senderId: "wxid_friend",
            senderName: "A Friend",
            isSelf: false,
            timestamp: 1789348325,
            type: "text",
            text: "hello",
          },
        ],
      },
    });
    const { talker } = buildTalker(runtime);

    const messages = await talker
      .feature("history")!
      .query({ conversationId: "wxid_friend" as ConversationId, limit: 10 });
    expect(messages[0]).toMatchObject({
      messageId: "wxid_friend:5",
      conversationId: "wxid_friend",
      senderId: "wxid_friend",
      text: "hello",
    });

    await talker.stop();
  });
});
