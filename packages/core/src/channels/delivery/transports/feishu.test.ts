import { describe, expect, it } from "@rstest/core";
import type { FeishuTransportOptions } from "./feishu.js";
import { FEISHU_MAX_EDITS, feishuMarkdown, feishuTransport } from "./feishu.js";

/** An Axios failure carrying Feishu's answer, as the SDK's client rejects with. */
const httpFailure = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers },
  });

/** The three message calls the transport makes, answering as `message` says. */
function transportOver(
  message: {
    create?: (payload: unknown) => Promise<unknown>;
    reply?: (payload: unknown) => Promise<unknown>;
    update?: (payload: unknown) => Promise<unknown>;
  },
  replyInThread: FeishuTransportOptions["replyInThread"] = async () => true,
) {
  const client = { im: { v1: { message } } } as unknown as FeishuTransportOptions["client"];
  const transport = feishuTransport({ client, replyInThread });
  if (!transport.edit) throw new Error("The Feishu transport declares edit");
  return { create: transport.create, edit: transport.edit };
}

const sent = { code: 0, msg: "success", data: { message_id: "om_9", chat_id: "oc_1" } };

describe("feishuTransport", () => {
  it("sends to a user by the id type its prefix names", async () => {
    const payloads: unknown[] = [];
    const { create } = transportOver({
      create: async (payload) => {
        payloads.push(payload);
        return sent;
      },
    });

    await create("ou_1", "hi");
    expect(payloads).toEqual([
      {
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: "ou_1",
          msg_type: "post",
          content: JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "md", text: "hi" }]] } }),
        },
      },
    ]);
  });

  it("names a refusal Feishu answered with 200 by its code", async () => {
    const { create } = transportOver({
      create: async () => ({ code: 230020, msg: "request trigger frequency limit" }),
    });

    await expect(create("oc_1", "hi")).rejects.toMatchObject({
      kind: "rate-limited",
      message: "request trigger frequency limit",
    });
  });

  it("names a create Feishu took without a message id as unknown", async () => {
    const { create } = transportOver({ create: async () => ({ code: 0, data: {} }) });

    await expect(create("oc_1", "hi")).rejects.toMatchObject({ kind: "unknown" });
  });

  it("waits as long as Feishu's rate-limit header asks", async () => {
    const { create } = transportOver({
      create: async () => {
        throw httpFailure(
          429,
          { code: 99991400, msg: "too many requests" },
          {
            "x-ogw-ratelimit-reset": "7",
          },
        );
      },
    });

    await expect(create("oc_1", "hi")).rejects.toMatchObject({
      kind: "rate-limited",
      retryAfterMs: 7000,
    });
  });

  it("names a failed settings lookup as unavailable before sending a reply", async () => {
    const writes: string[] = [];
    const { create } = transportOver(
      {
        create: async () => {
          writes.push("create");
          return sent;
        },
        reply: async () => {
          writes.push("reply");
          return sent;
        },
      },
      async () => {
        throw new Error("Settings store unavailable");
      },
    );

    await expect(create("oc_1", "hi", "om_user")).rejects.toMatchObject({
      kind: "unavailable",
      message: "Settings store unavailable",
    });
    expect(writes).toEqual([]);
  });

  it("names a token Feishu would not mint as unauthorized", async () => {
    const { create } = transportOver({
      create: async () => {
        throw new Error("failed to get tenant_access_token, code: 10014, msg: app secret invalid");
      },
    });

    await expect(create("oc_1", "hi")).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it.each([
    { failure: httpFailure(503, "Service Unavailable"), name: "HTTP 503" },
    {
      failure: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      name: "a reset",
    },
    { failure: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), name: "a timeout" },
  ])("names $name during the token request as unavailable", async ({ failure }) => {
    const fail = async () => {
      throw Object.assign(failure, {
        config: { url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" },
      });
    };
    const { create, edit } = transportOver({ create: fail, update: fail });

    await expect(create("oc_1", "hi")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(edit({ messageId: "om_9", chatId: "oc_1" }, "hi")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it.each([
    "https://open.feishu.cn/open-apis/im/v1/messages",
    "https://open.feishu.cn/open-apis/im/v1/messages/om_auth/reply",
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/extra",
    "https://open.feishu.cn/open-apis/im/v1/messages?next=/open-apis/auth/v3/tenant_access_token/internal",
    "not a URL",
    undefined,
  ])("keeps a server error outside the token endpoint unknown (%s)", async (url) => {
    const { create } = transportOver({
      create: async () => {
        throw Object.assign(httpFailure(503, "Service Unavailable"), { config: { url } });
      },
    });

    await expect(create("oc_1", "hi")).rejects.toMatchObject({ kind: "unknown" });
  });

  it("keeps a token credential refusal unauthorized", async () => {
    const { create } = transportOver({
      create: async () => {
        throw Object.assign(httpFailure(400, { code: 99991663, msg: "invalid token" }), {
          config: { url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" },
        });
      },
    });

    await expect(create("oc_1", "hi")).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("counts an edit whose result is unknown against the message", async () => {
    let edits = 0;
    const { edit } = transportOver({
      update: async () => {
        edits += 1;
        if (edits === 1) throw httpFailure(502, "Bad Gateway");
        return { code: 0 };
      },
    });
    const receipt = { messageId: "om_9", chatId: "oc_1" };

    await expect(edit(receipt, "0")).rejects.toMatchObject({ kind: "unknown" });
    for (let i = 1; i < FEISHU_MAX_EDITS; i += 1) await edit(receipt, String(i));
    await expect(edit(receipt, "last")).rejects.toMatchObject({ kind: "unsupported" });
    expect(edits).toBe(FEISHU_MAX_EDITS);
  });
});

describe("feishuMarkdown", () => {
  const render = (source: string) => feishuMarkdown.render(source, true);

  it("brings headings down when the text has a large one, as the SDK's send does", () => {
    expect(render("# Title\n## Part\n#### Small\ntext")).toBe(
      "#### Title\n##### Part\n##### Small\ntext",
    );
    expect(render("#### Small\n##### Smaller")).toBe("#### Small\n##### Smaller");
  });

  it("leaves fenced code alone, and shrinks runs of blank lines", () => {
    expect(render("# T\n```md\n# not a heading\n```\n\n\n\nend")).toBe(
      "#### T\n```md\n# not a heading\n```\n\nend",
    );
  });

  // The SDK looks for a large heading before it sets fences aside, so one in a
  // fence brings the headings outside it down too.
  it("counts a large heading inside a fence, as the SDK's send does", () => {
    expect(render("```\n# inside\n```\n## outside")).toBe("```\n# inside\n```\n##### outside");
  });

  it("measures UTF-16 code units", () => {
    expect(feishuMarkdown.measure("😀中")).toBe(3);
  });
});
