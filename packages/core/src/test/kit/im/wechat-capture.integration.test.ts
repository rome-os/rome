import { describe, expect, it } from "@rstest/core";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import capture from "./wechat-text.capture.json" with { type: "json" };
import { WechatApiFixture, WECHAT_ORIGIN } from "./wechat.js";

describe("WeChat text capture", () => {
  for (const [index, exchange] of capture.exchanges.entries()) {
    it(`replays send response ${index + 1}`, async () => {
      await using directory = await mkdtempDisposable(join(tmpdir(), "rome-wechat-capture-"));
      const msg = exchange.body.msg;
      await writeFile(
        join(directory.path, "context_tokens.json"),
        JSON.stringify({ [msg.to_user_id]: msg.context_token }),
      );
      const fixture = await new WechatApiFixture().start();
      const adapter = fixture.createAdapter(directory.path);
      try {
        await adapter.start();
        await fixture.untilPolling();
        fixture.server.once({
          method: "POST",
          path: exchange.path,
          response: { status: exchange.status, body: exchange.response },
        });
        if (exchange.response.ret) {
          const response = await fixture.fetch(`${WECHAT_ORIGIN}${exchange.path}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
            body: JSON.stringify(exchange.body),
          });
          expect(response.status).toBe(exchange.status);
          expect(await response.json()).toEqual(exchange.response);
        } else {
          await expect(
            adapter.sendMessage(msg.to_user_id, msg.to_user_id, {
              text: msg.item_list[0].text_item.text,
            }),
          ).resolves.toBeUndefined();
        }
        const call = fixture.server.calls.find((call) => call.path === exchange.path);
        expect(call).toMatchObject({
          status: exchange.status,
          body: {
            msg: {
              ...msg,
              client_id: expect.stringMatching(/^rome-wechat:/),
              context_token: "[redacted]",
            },
            base_info: {
              channel_version: exchange.body.base_info.channel_version,
              bot_agent: expect.stringMatching(/^Rome\//),
            },
          },
        });
        fixture.server.assertClean();
      } finally {
        await adapter.stop();
        await fixture.close();
      }
    });
  }
});
