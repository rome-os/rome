import { describe, expect, it } from "@rstest/core";
import capture from "./feishu-text.capture.json" with { type: "json" };
import postCapture from "./feishu-post.capture.json" with { type: "json" };
import { createLarkServerStub, LARK_USER } from "./lark.js";

function normalizeResponse(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => {
      if (key === "content" && typeof item === "string") return JSON.parse(item);
      if (key === "create_time" || key === "update_time") {
        expect(item).toMatch(/^\d+$/);
        return "1700000000000";
      }
      if (key === "message_position") {
        expect(item).toMatch(/^\d+$/);
        return "1";
      }
      return item;
    }),
  );
}

describe("Feishu text capture", () => {
  it.each(["replay", "model"])("matches the real SDK responses through %s", async (mode) => {
    const fixture = await createLarkServerStub();
    const channel = fixture.createChannel();
    try {
      await channel.connect();
      if (mode === "replay") {
        const routes = [
          ["POST", "/open-apis/im/v1/messages"],
          ["GET", "/open-apis/im/v1/messages/om_1"],
          ["PUT", "/open-apis/im/v1/messages/om_1"],
          ["GET", "/open-apis/im/v1/messages/om_1"],
          ["POST", "/open-apis/im/v1/messages/om_1/reply"],
        ];
        routes.forEach(([method, path], index) => {
          fixture.server.once({ method, path, response: { body: capture.responses[index] } });
        });
      }
      const client = channel.rawClient;
      const created = await client.im.message.create({
        params: { receive_id_type: "open_id" },
        data: {
          receive_id: LARK_USER,
          msg_type: "text",
          content: JSON.stringify({ text: "Rome fixture capture: preview 中文" }),
        },
      });
      expect(created.data?.message_id).toBe("om_1");
      const path = { message_id: "om_1" };
      const before = await client.im.message.get({ path });
      const updated = await client.im.message.update({
        path,
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "Rome fixture capture: final 中文" }),
        },
      });
      const after = await client.im.message.get({ path });
      const reply = await client.im.message.reply({
        path,
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "Rome fixture capture: reply" }),
        },
      });
      expect(normalizeResponse([created, before, updated, after, reply])).toEqual(
        normalizeResponse(capture.responses),
      );
      if (mode === "model") {
        expect(fixture.messages.get("om_1")).toMatchObject({
          updated: true,
          body: { content: JSON.stringify({ text: "Rome fixture capture: final 中文" }) },
        });
        expect(fixture.messages.get("om_2")).toMatchObject({
          parent_id: "om_1",
          root_id: "om_1",
        });
      }
      fixture.server.assertClean();
    } finally {
      await channel.disconnect();
      await fixture.close();
    }
  });
});

describe("Feishu post capture", () => {
  for (const scenario of postCapture.cases) {
    for (const mode of ["invalid-message", "markdown"].includes(scenario.name)
      ? ["replay"]
      : ["replay", "model"]) {
      it(`${scenario.name} through ${mode}`, async () => {
        const fixture = await createLarkServerStub();
        const channel = fixture.createChannel();
        try {
          const client = channel.rawClient;
          for (const exchange of scenario.exchanges) {
            const operation = exchange.operation as "create" | "get" | "reply" | "update";
            const params = exchange.params;
            const messageId = "path" in params ? params.path?.message_id : undefined;
            const path = `/open-apis/im/v1/messages${messageId ? `/${messageId}` : ""}${operation === "reply" ? "/reply" : ""}`;
            if (mode === "replay") {
              fixture.server.once({
                method: operation === "get" ? "GET" : operation === "update" ? "PUT" : "POST",
                path,
                response: { status: exchange.status, body: exchange.response },
              });
            }
            const invoke = () => {
              switch (operation) {
                case "create":
                  return client.im.message.create(
                    params as Parameters<typeof client.im.message.create>[0],
                  );
                case "get":
                  return client.im.message.get(
                    params as Parameters<typeof client.im.message.get>[0],
                  );
                case "reply":
                  return client.im.message.reply(
                    params as Parameters<typeof client.im.message.reply>[0],
                  );
                case "update":
                  return client.im.message.update(
                    params as Parameters<typeof client.im.message.update>[0],
                  );
              }
            };
            if (exchange.status !== 200) {
              await expect(invoke()).rejects.toMatchObject({
                response: { status: exchange.status, data: exchange.response },
              });
            } else {
              expect(normalizeResponse(await invoke())).toEqual(
                normalizeResponse(exchange.response),
              );
            }
            expect(fixture.server.calls.at(-1)).toMatchObject({
              path,
              body: "data" in params ? params.data : {},
              status: exchange.status,
            });
          }
          fixture.server.assertClean();
        } finally {
          await channel.disconnect();
          await fixture.close();
        }
      });
    }
  }
});
