import crypto from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  isWechatAuthError,
  normalizeWechatBaseUrl,
  normalizeWechatMessage,
  WechatAdapter,
  type WechatMessage,
} from "./wechat.js";

const profileDirs = rs.hoisted(() => ({ profileDir: "", memoryDir: "" }));
const loggerMocks = rs.hoisted(() => ({
  debug: rs.fn(),
  info: rs.fn(),
  warn: rs.fn(),
  error: rs.fn(),
}));

rs.mock("../logger.js", () => ({
  createLogger: () => loggerMocks,
}));

rs.mock("../paths.js", () => ({
  getProfileDir: () => profileDirs.profileDir,
  getProfileMemoryDir: () => profileDirs.memoryDir,
}));

function makeWechatMessage(overrides: Partial<WechatMessage> = {}): WechatMessage {
  return {
    client_id: "msg-1",
    from_user_id: "alice@im.wechat",
    message_type: 1,
    create_time_ms: 1700000000000,
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "hello from wechat" } }],
    ...overrides,
  };
}

describe("normalizeWechatMessage", () => {
  it("normalizes a private text message", () => {
    const msg = normalizeWechatMessage(makeWechatMessage());

    expect(msg).toEqual({
      id: "msg-1",
      channel: "wechat",
      channelUserId: "alice@im.wechat",
      displayName: "alice",
      threadId: "alice@im.wechat",
      threadName: undefined,
      threadType: "private",
      timestamp: new Date(1700000000000),
      text: "hello from wechat",
      attachments: [],
      addressing: "direct",
      rawEvent: expect.any(Object),
    });
  });

  it("uses the item message id as the platform message id", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        message_id: 9001,
        client_id: "client-1",
        item_list: [{ type: 1, msg_id: "item-1", text_item: { text: "hello" } }],
      }),
    );

    expect(msg?.id).toBe("item-1");
  });

  it("falls back to the envelope message id when the item has no id", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        message_id: 9001,
        client_id: "client-1",
      }),
    );

    expect(msg?.id).toBe("9001");
  });

  it("extracts the referenced item id and content from a quoted reply", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 1,
            msg_id: "current-item",
            text_item: { text: "my reply" },
            ref_msg: {
              title: "original summary",
              message_item: {
                type: 1,
                msg_id: "original-item",
                text_item: { text: "original text" },
              },
            },
          },
        ],
      }),
    );

    expect(msg).toEqual(
      expect.objectContaining({
        id: "current-item",
        text: "my reply",
        replyTo: {
          messageId: "original-item",
          content: "original text",
        },
      }),
    );
  });

  it("includes exact quoted content when WeChat omits the referenced item id", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 1,
            text_item: { text: "my reply" },
            ref_msg: {
              title: "Rome",
              message_item: {
                type: 1,
                text_item: { text: "original text" },
              },
            },
          },
        ],
      }),
    );

    expect(msg?.text).toBe("[Quoted: Rome | original text]\nmy reply");
    expect(msg?.replyTo).toBeUndefined();
  });

  it("reads a populated text payload when a quoted item reports type NONE", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 1,
            text_item: { text: "my reply" },
            ref_msg: {
              message_item: {
                type: 0,
                msg_id: "original-item",
                text_item: { text: "original text" },
              },
            },
          },
        ],
      }),
    );

    expect(msg?.text).toBe("my reply");
    expect(msg?.replyTo).toEqual({
      messageId: "original-item",
      content: "original text",
    });
  });

  it("treats a zero quoted item id as unavailable and keeps its content inline", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 1,
            text_item: { text: "my reply" },
            ref_msg: {
              message_item: {
                type: 0,
                msg_id: 0,
                text_item: { text: "original text" },
              },
            },
          },
        ],
      }),
    );

    expect(msg?.text).toBe("[Quoted: original text]\nmy reply");
    expect(msg?.replyTo).toBeUndefined();
  });

  it("uses the iLink quote summary when the referenced item has no payload", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 1,
            text_item: { text: "my reply" },
            ref_msg: {
              title: "original summary",
              message_item: { type: 0, msg_id: "original-item" },
            },
          },
        ],
      }),
    );

    expect(msg?.replyTo).toEqual({
      messageId: "original-item",
      content: "original summary",
    });
  });

  it("does not expose an empty type NONE quote as an unknown message", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 1,
            text_item: { text: "my reply" },
            ref_msg: { message_item: { type: 0, msg_id: 0 } },
          },
        ],
      }),
    );

    expect(msg?.text).toBe("my reply");
    expect(msg?.replyTo).toBeUndefined();
  });

  it("uses sender id as thread id for group messages", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        group_id: "room-1@chatroom",
        from_user_id: "bob@im.wechat",
      }),
    );

    expect(msg?.channelUserId).toBe("bob@im.wechat");
    expect(msg?.threadId).toBe("bob@im.wechat");
    expect(msg?.threadType).toBe("group");
    expect(msg?.threadName).toBe("room-1@chatroom");
    expect(msg?.addressing).toBe("direct");
  });

  it("treats empty group id as private metadata", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        group_id: "",
        from_user_id: "bob@im.wechat",
      }),
    );

    expect(msg?.channelUserId).toBe("bob@im.wechat");
    expect(msg?.threadId).toBe("bob@im.wechat");
    expect(msg?.threadType).toBe("private");
    expect(msg?.threadName).toBeUndefined();
  });

  it("keeps media-only image attachments when only encrypted CDN metadata is present", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 2,
            image_item: {
              width: 640,
              height: 480,
              media: {
                encrypt_query_param: "encrypted-param",
                aes_key: "MDEyMzQ1Njc4OWFiY2RlZg==",
              },
            },
          },
        ],
      }),
    );

    expect(msg?.text).toBe("[Image (640x480)]");
    expect(msg?.attachments).toEqual([
      expect.objectContaining({
        type: "image",
        fileName: "wechat-image.jpg",
        mimeType: "image/jpeg",
      }),
    ]);
    expect(msg?.attachments[0].url).toContain("encrypted_query_param=encrypted-param");
  });

  it("normalizes voice transcripts as text plus audio attachment metadata", () => {
    const msg = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 3,
            voice_item: {
              text: "transcribed words",
              cdn_url: "https://cdn.example/audio",
            },
          },
        ],
      }),
    );

    expect(msg?.text).toBe("[Voice transcript] transcribed words");
    expect(msg?.attachments).toEqual([
      {
        type: "audio",
        url: "https://cdn.example/audio",
        mimeType: "audio/*",
      },
    ]);
  });

  it("ignores bot messages", () => {
    expect(normalizeWechatMessage(makeWechatMessage({ message_type: 2 }))).toBeNull();
  });
});

describe("WechatAdapter reply diagnostics", () => {
  it("logs the reply shape without message content or media credentials", async () => {
    loggerMocks.info.mockClear();
    const adapter = new WechatAdapter({
      token: "token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "account",
      connectedAt: "2026-05-09T00:00:00.000Z",
    }) as unknown as {
      handleRawMessage(message: WechatMessage): Promise<void>;
    };

    await adapter.handleRawMessage(
      makeWechatMessage({
        message_id: 123,
        context_token: undefined,
        item_list: [
          {
            type: 1,
            msg_id: "current-item",
            text_item: { text: "my reply" },
            ref_msg: {
              title: "original summary",
              message_item: {
                type: 0,
                msg_id: 0,
                text_item: { text: "original text" },
                image_item: {
                  media: {
                    aes_key: "secret-key",
                    encrypt_query_param: "secret-query",
                  },
                },
              },
            },
          },
        ],
      }),
    );

    expect(loggerMocks.info).toHaveBeenCalledWith("reply reference received", {
      envelopeMessageId: 123,
      itemIndex: 0,
      currentItemType: 1,
      currentItemMessageId: "current-item",
      refTitlePresent: true,
      referencedItemType: 0,
      referencedItemMessageId: 0,
      referencedPayloadFields: ["text_item", "image_item"],
      referencedTextPresent: true,
      referencedVoiceTextPresent: false,
    });
    const logged = JSON.stringify(loggerMocks.info.mock.calls);
    expect(logged).not.toContain("original summary");
    expect(logged).not.toContain("original text");
    expect(logged).not.toContain("secret-key");
    expect(logged).not.toContain("secret-query");
  });
});

describe("WechatAdapter inbound attachments", () => {
  const originalFetch = globalThis.fetch;

  function encryptForTest(data: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  afterEach(async () => {
    rs.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    await rm(profileDirs.memoryDir, { recursive: true, force: true });
    await rm(profileDirs.profileDir, { recursive: true, force: true });
    profileDirs.memoryDir = "";
    profileDirs.profileDir = "";
  });

  it("downloads, decrypts, and saves encrypted CDN media", async () => {
    profileDirs.profileDir = await mkdtemp(join(tmpdir(), "rome-wechat-profile-"));
    profileDirs.memoryDir = await mkdtemp(join(tmpdir(), "rome-wechat-memory-"));

    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.from("image bytes");
    const encrypted = encryptForTest(plaintext, key);
    const fetchMock = rs.fn(async () => {
      return new Response(new Uint8Array(encrypted), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    });
    rs.stubGlobal("fetch", fetchMock);

    const message = normalizeWechatMessage(
      makeWechatMessage({
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: "encrypted-param",
                aes_key: key.toString("base64"),
              },
            },
          },
        ],
      }),
    );
    expect(message).not.toBeNull();

    const adapter = new WechatAdapter({
      token: "token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "account",
      connectedAt: "2026-05-09T00:00:00.000Z",
    });

    const attachments = await adapter.saveIncomingAttachments(message!);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("encrypted_query_param=encrypted-param"),
      expect.any(Object),
    );
    expect(attachments[0]).toEqual(
      expect.objectContaining({
        type: "image",
        fileName: "wechat-image.jpg",
        mimeType: "image/jpeg",
        localPath: expect.any(String),
      }),
    );
    expect((attachments[0] as { wechatMedia?: unknown }).wechatMedia).toBeUndefined();
    await expect(readFile(attachments[0].localPath!)).resolves.toEqual(plaintext);
  });
});

describe("WechatAdapter sendMessage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    rs.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("sends proactive text to the channel user with the latest cached context token", async () => {
    const fetchMock = rs.fn(async () => new Response("{}", { status: 200 }));
    rs.stubGlobal("fetch", fetchMock);

    const adapter = new WechatAdapter({
      token: "token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "account",
      connectedAt: "2026-05-09T00:00:00.000Z",
    }) as unknown as {
      sendMessage(
        channelUserId: string,
        threadId: string,
        message: { text: string },
      ): Promise<void>;
      rememberContextToken(key: string, contextToken: string, typingTarget: string): void;
    };

    adapter.rememberContextToken("room-1@chatroom", "ctx-room", "alice@im.wechat");
    adapter.rememberContextToken("alice@im.wechat", "ctx-alice", "alice@im.wechat");

    await adapter.sendMessage("alice@im.wechat", "room-1@chatroom", { text: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer token",
        AuthorizationType: "ilink_bot_token",
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": "132099",
      }),
    );
    const body = JSON.parse(String(init.body)) as {
      msg: {
        to_user_id?: string;
        context_token?: string;
        client_id?: string;
        message_type?: number;
        message_state?: number;
        item_list?: unknown[];
      };
      base_info?: { channel_version?: string; bot_agent?: string };
    };
    expect(body.msg).toEqual(
      expect.objectContaining({
        to_user_id: "alice@im.wechat",
        context_token: "ctx-alice",
        message_type: 2,
        message_state: 2,
      }),
    );
    expect(body.msg.client_id).toMatch(/^rome-wechat:/);
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: "hello" } }]);
    expect(body.base_info).toEqual({ channel_version: "2.4.3", bot_agent: "Rome/0.1.1" });
  });
});

describe("isWechatAuthError", () => {
  it("recognizes only ilinkai HTTP 401/403 apiFetch errors", () => {
    expect(isWechatAuthError(new Error("HTTP 401: unauthorized"))).toBe(true);
    expect(isWechatAuthError(new Error("HTTP 403: forbidden"))).toBe(true);
    expect(isWechatAuthError(new Error("HTTP 500: server error"))).toBe(false);
    expect(isWechatAuthError(new Error("ECONNRESET"))).toBe(false);
    expect(isWechatAuthError("HTTP 401")).toBe(false);
  });
});

describe("WechatAdapter fault surfacing", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    rs.unstubAllGlobals();
    rs.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("surfaces a terminal HTTP 401 poll failure through onFault (auth) and stops looping", async () => {
    const fetchMock = rs.fn(async () => new Response("unauthorized", { status: 401 }));
    rs.stubGlobal("fetch", fetchMock);

    const faults: unknown[] = [];
    const adapter = new WechatAdapter({
      token: "bad-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "account",
      connectedAt: "2026-05-09T00:00:00.000Z",
      onFault: (err) => faults.push(err),
    });

    await adapter.start();
    // Let the poll loop run, throw HTTP 401, break out, and reach start()'s catch.
    await new Promise((r) => setTimeout(r, 10));
    await adapter.stop();

    expect(faults).toHaveLength(1);
    expect(isWechatAuthError(faults[0])).toBe(true);
  });

  it("pauses errcode -14 for one hour, blocks outbound calls, then retries", async () => {
    rs.useFakeTimers();
    loggerMocks.warn.mockClear();
    loggerMocks.error.mockClear();
    const fetchMock = rs.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(
          JSON.stringify({
            ret: 0,
            errcode: -14,
            errmsg: "session timeout",
            msgs: [],
          }),
          { status: 200 },
        );
      }
      return new Response("unauthorized", { status: 401 });
    });
    rs.stubGlobal("fetch", fetchMock);

    const faults: unknown[] = [];
    const adapter = new WechatAdapter({
      token: "stale-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "account",
      connectedAt: "2026-05-09T00:00:00.000Z",
      onFault: (err) => faults.push(err),
    });

    await adapter.start();
    await rs.waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(faults).toHaveLength(0);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "wechat session paused",
      expect.objectContaining({
        accountId: "account",
        errcode: -14,
        errmsg: "session timeout",
        retryAt: expect.any(String),
      }),
    );
    await expect(
      adapter.sendMessage("alice@im.wechat", "alice@im.wechat", { text: "hello" }),
    ).rejects.toThrow("WeChat session paused after errcode -14; retry in 60 min");

    const pauseData = loggerMocks.warn.mock.calls[0]?.[1] as { retryAt: string };
    expect(adapter.getRuntimeDegradation()).toEqual({
      reason: "WeChat reported a stale session. Rome will retry automatically after the cooldown.",
      retryAt: pauseData.retryAt,
    });
    const remainingPauseMs = Date.parse(pauseData.retryAt) - Date.now();
    expect(remainingPauseMs).toBeGreaterThan(0);
    await rs.advanceTimersByTimeAsync(remainingPauseMs - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(faults).toHaveLength(0);

    await rs.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(faults).toHaveLength(1);
    expect(isWechatAuthError(faults[0])).toBe(true);
    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(adapter.getRuntimeDegradation()).toBeNull();

    await adapter.stop();
    expect(rs.getTimerCount()).toBe(0);
  });

  it("stop cancels a stale-session cooldown timer", async () => {
    rs.useFakeTimers();
    loggerMocks.warn.mockClear();
    const fetchMock = rs.fn(
      async () =>
        new Response(
          JSON.stringify({
            ret: 0,
            errcode: -14,
            errmsg: "session timeout",
            msgs: [],
          }),
          { status: 200 },
        ),
    );
    rs.stubGlobal("fetch", fetchMock);

    const adapter = new WechatAdapter({
      token: "stale-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "account",
      connectedAt: "2026-05-09T00:00:00.000Z",
    });

    await adapter.start();
    await rs.waitFor(() => expect(loggerMocks.warn).toHaveBeenCalledTimes(1));
    await adapter.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rs.getTimerCount()).toBe(0);
  });
});

describe("normalizeWechatBaseUrl", () => {
  it("accepts https WeChat ilink hosts and normalizes to origin", () => {
    expect(normalizeWechatBaseUrl("https://ilinkai.weixin.qq.com/path")).toBe(
      "https://ilinkai.weixin.qq.com",
    );
  });

  it("rejects non-WeChat, internal, and non-https URLs", () => {
    expect(() => normalizeWechatBaseUrl("http://ilinkai.weixin.qq.com")).toThrow(
      "Invalid WeChat baseUrl",
    );
    expect(() => normalizeWechatBaseUrl("https://localhost:3000")).toThrow(
      "Invalid WeChat baseUrl",
    );
    expect(() => normalizeWechatBaseUrl("https://169.254.169.254")).toThrow(
      "Invalid WeChat baseUrl",
    );
    expect(() => normalizeWechatBaseUrl("https://weixin.qq.com.evil.example")).toThrow(
      "Invalid WeChat baseUrl",
    );
    expect(() => normalizeWechatBaseUrl("https://token@ilinkai.weixin.qq.com")).toThrow(
      "Invalid WeChat baseUrl",
    );
    expect(() => normalizeWechatBaseUrl("https://ilinkai.weixin.qq.com:8443")).toThrow(
      "Invalid WeChat baseUrl",
    );
  });
});

describe("WechatAdapter state hygiene", () => {
  it("caps remembered context tokens and evicts the oldest entries", () => {
    const adapter = new WechatAdapter({
      token: "token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "account",
      connectedAt: "2026-05-09T00:00:00.000Z",
    }) as unknown as {
      contextTokens: Map<string, string>;
      typingTargets: Map<string, string>;
      rememberContextToken(key: string, contextToken: string, typingTarget: string): void;
    };

    for (let i = 0; i < 1_100; i += 1) {
      adapter.rememberContextToken(`thread-${i}`, `ctx-${i}`, `user-${i}`);
    }

    expect(adapter.contextTokens.size).toBe(1_000);
    expect(adapter.typingTargets.size).toBe(1_000);
    expect(adapter.contextTokens.has("thread-0")).toBe(false);
    expect(adapter.contextTokens.get("thread-100")).toBe("ctx-100");
    expect(adapter.contextTokens.get("thread-1099")).toBe("ctx-1099");
  });

  it("writes persisted context tokens with owner-only permissions", async () => {
    const statePath = await mkdtemp(join(tmpdir(), "rome-wechat-test-"));
    try {
      const adapter = new WechatAdapter({
        token: "token",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "account",
        connectedAt: "2026-05-09T00:00:00.000Z",
        statePath,
      }) as unknown as {
        rememberContextToken(key: string, contextToken: string, typingTarget: string): void;
        saveContextTokens(): Promise<void>;
      };

      adapter.rememberContextToken("thread", "ctx", "user");
      await adapter.saveContextTokens();

      const mode = (await stat(join(statePath, "context_tokens.json"))).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(statePath, { recursive: true, force: true });
    }
  });
});
