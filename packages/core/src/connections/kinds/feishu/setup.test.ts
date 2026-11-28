import { readFileSync } from "node:fs";
import { describe, expect, it, rs } from "@rstest/core";
import { SetupSession } from "../../setup/session.js";
import type { SetupForm, SetupGrant, SetupView } from "../../setup/types.js";
import { makeFeishuSetup, reviveFeishuProfile } from "./descriptor.js";

describe("Feishu credential setup", () => {
  it("validates manual credentials and grants without granting guardian authority", async () => {
    const probeCredentials = rs.fn(async () => {});
    const commit = rs.fn(async (_value: SetupGrant) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials,
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
        fetchBotName: async () => null,
      }),
      commit,
    });
    await session.started();
    await session.provideInput({ mode: "manual", domain: "lark" });
    await session.provideInput({ appId: "app", appSecret: "secret" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(probeCredentials).toHaveBeenCalledWith(
      { appId: "app", appSecret: "secret", domain: "lark" },
      expect.anything(),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).not.toHaveProperty("connectedBy");
  });

  it("renews an account by its own app's credentials, never by registering a new app", async () => {
    const commit = rs.fn(async (_value: SetupGrant) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
        fetchBotName: async () => null,
      }),
      commit,
      renewing: true,
    });
    await session.started();
    const form = session.state;
    expect(JSON.stringify(form)).not.toContain("agent-ready");
    await session.provideInput({ domain: "lark" });
    await session.provideInput({ appId: "app", appSecret: "secret" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit.mock.calls[0][0].profile).toMatchObject({ appId: "app" });
  });

  it("records the bot's name, which the account then shows", async () => {
    const commit = rs.fn(async (_value: SetupGrant) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
        fetchBotName: async () => "Rome Helper",
      }),
      commit,
    });
    await session.started();
    await session.provideInput({ mode: "manual", domain: "feishu" });
    await session.provideInput({ appId: "app", appSecret: "secret" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    const profile = commit.mock.calls[0][0].profile!;
    expect(profile).toMatchObject({ appId: "app", botName: "Rome Helper" });
    expect(reviveFeishuProfile(profile)).toMatchObject({
      displayName: "Rome Helper",
      handle: "app",
    });
  });

  it("finishes without a name when the bot's name cannot be read", async () => {
    const commit = rs.fn(async (_value: SetupGrant) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
        fetchBotName: async () => {
          throw new Error("bot info unavailable");
        },
      }),
      commit,
    });
    await session.started();
    await session.provideInput({ mode: "manual", domain: "feishu" });
    await session.provideInput({ appId: "app", appSecret: "secret" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    const profile = commit.mock.calls[0][0].profile!;
    expect(profile).not.toHaveProperty("botName");
    expect(reviveFeishuProfile(profile).handle).toBe("app");
  });

  it("commits nothing when cancelled while the bot's name is read", async () => {
    const fetchBotName = rs.fn(() => new Promise<never>(() => {}));
    const commit = rs.fn(async (_value: SetupGrant) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
        fetchBotName,
      }),
      commit,
    });
    await session.started();
    await session.provideInput({ mode: "manual", domain: "feishu" });
    const input = session.provideInput({ appId: "app", appSecret: "secret" });
    await rs.waitFor(() => expect(fetchBotName).toHaveBeenCalled());
    await session.cancel();
    await input;
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps QR registration cancellable with no durable write", async () => {
    const registerAgentApp = rs.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const commit = rs.fn(async (_value: SetupGrant) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp,
        fetchBotName: async () => null,
      }),
      commit,
    });
    await session.started();
    const input = session.provideInput({ mode: "agent-ready", domain: "feishu" });
    await rs.waitFor(() => expect(registerAgentApp).toHaveBeenCalled());
    await session.cancel();
    await input;
    expect(commit).not.toHaveBeenCalled();
  });

  it("emits semantic i18n ids and labeled domain/mode options across setup states", async () => {
    const commit = rs.fn(async (_value: SetupGrant) => {});
    let releaseQr!: () => void;
    const qrReady = new Promise<void>((resolve) => {
      releaseQr = resolve;
    });
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async ({ onQrCode }) => {
          onQrCode({
            url: "https://accounts.feishu.cn/qr/1",
            qrDataUrl: "data:image/png;base64,QQ==",
            expiresAt: "2026-11-27T18:00:00.000Z",
          });
          await qrReady;
          return { appId: "cli_qr", appSecret: "sec", domain: "feishu" };
        },
        fetchBotName: async () => "Rome",
      }),
      commit,
    });

    await session.started();
    expect(session.state).toMatchObject({
      status: "awaiting-input",
      form: {
        id: "feishu.mode",
        fields: [
          {
            name: "mode",
            options: [
              { value: "agent-ready", label: "Agent-ready (scan QR code)" },
              { value: "manual", label: "Manual (App ID & App Secret)" },
            ],
          },
          {
            name: "domain",
            options: [
              { value: "feishu", label: "Feishu (China · feishu.cn)" },
              { value: "lark", label: "Lark (Global · larksuite.com)" },
            ],
          },
        ],
      },
    });

    const inputPromise = session.provideInput({ mode: "agent-ready", domain: "feishu" });
    await rs.waitFor(() =>
      expect(session.state).toMatchObject({
        status: "presenting",
        view: {
          id: "feishu.qr",
          params: { expiresAt: "2026-11-27T18:00:00.000Z" },
          body: [
            { id: "scan", text: expect.stringContaining("Feishu/Lark") },
            { id: "expires", text: "The QR code expires at 2026-11-27T18:00:00.000Z." },
          ],
          links: [
            { id: "openCreatePage", url: "https://accounts.feishu.cn/qr/1" },
            { id: "qrCode", url: "data:image/png;base64,QQ==" },
          ],
        },
      }),
    );

    releaseQr();
    await inputPromise;
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(session.state).toMatchObject({
      status: "done",
      grant: {
        summary: {
          id: "feishu.connected",
          params: { appId: "cli_qr" },
          body: [{ id: "ready", text: expect.stringContaining("App cli_qr is live.") }],
        },
      },
    });
  });

  it("keeps English fallback copy aligned with web en/settings.json", async () => {
    const enSettingsPath = new URL(
      "../../../../../web/src/i18n/locales/en/settings.json",
      import.meta.url,
    );
    const enSettings = JSON.parse(readFileSync(enSettingsPath, "utf8")) as {
      connections: {
        setup: {
          forms: {
            feishu: Record<
              string,
              {
                instructions: string;
                fields: Record<string, { label: string; options?: Record<string, string> }>;
              }
            >;
          };
          views: {
            feishu: Record<
              string,
              { title: string; body: Record<string, string>; links?: Record<string, string> }
            >;
          };
        };
      };
    };
    const { forms, views } = enSettings.connections.setup;

    function assertFormMatchesLocale(form: SetupForm, localeKey: string) {
      const expected = forms.feishu[localeKey];
      expect(form.instructions).toBe(expected.instructions);
      for (const field of form.fields) {
        const expectedField = expected.fields[field.name];
        expect(field.label).toBe(expectedField.label);
        if (field.options) {
          for (const option of field.options) {
            const value = typeof option === "string" ? option : option.value;
            const label = typeof option === "string" ? option : option.label;
            expect(label).toBe(expectedField.options?.[value]);
          }
        }
      }
    }

    function assertViewMatchesLocale(
      view: SetupView,
      localeKey: string,
      params: Record<string, string> = {},
    ) {
      const expected = views.feishu[localeKey];
      expect(view.title).toBe(expected.title);
      for (const item of view.body ?? []) {
        expect(typeof item).toBe("object");
        if (typeof item === "object") {
          let expectedText = expected.body[item.id];
          for (const [k, v] of Object.entries(params)) {
            expectedText = expectedText.replace(`{{${k}}}`, v);
          }
          expect(item.text).toBe(expectedText);
        }
      }
      for (const link of view.links ?? []) {
        if (link.id) {
          expect(link.label).toBe(expected.links?.[link.id]);
        }
      }
    }

    // 1) Mode + manual credentials + finishing + connected
    let releaseBotName!: () => void;
    const botNameReady = new Promise<void>((resolve) => {
      releaseBotName = resolve;
    });
    const manualSession = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
        fetchBotName: async () => {
          await botNameReady;
          return "Rome";
        },
      }),
      commit: async () => {},
    });
    await manualSession.started();
    expect(manualSession.state.status).toBe("awaiting-input");
    if (manualSession.state.status === "awaiting-input") {
      assertFormMatchesLocale(manualSession.state.form, "mode");
    }
    await manualSession.provideInput({ mode: "manual", domain: "feishu" });
    expect(manualSession.state.status).toBe("awaiting-input");
    if (manualSession.state.status === "awaiting-input") {
      assertFormMatchesLocale(manualSession.state.form, "credentials");
    }
    const credsPromise = manualSession.provideInput({ appId: "cli_1", appSecret: "sec" });
    await rs.waitFor(() =>
      expect(manualSession.state).toMatchObject({
        status: "presenting",
        view: { id: "feishu.finishing" },
      }),
    );
    if (manualSession.state.status === "presenting") {
      assertViewMatchesLocale(manualSession.state.view, "finishing");
    }
    releaseBotName();
    await credsPromise;
    await rs.waitFor(() => expect(manualSession.state.status).toBe("done"));
    if (manualSession.state.status === "done" && manualSession.state.grant.summary) {
      assertViewMatchesLocale(manualSession.state.grant.summary, "connected", { appId: "cli_1" });
    }

    // 2) Renew form
    const renewSession = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
        fetchBotName: async () => null,
      }),
      commit: async () => {},
      renewing: true,
    });
    await renewSession.started();
    expect(renewSession.state.status).toBe("awaiting-input");
    if (renewSession.state.status === "awaiting-input") {
      assertFormMatchesLocale(renewSession.state.form, "renew");
    }
    await renewSession.cancel();

    // 3) Agent-ready preparing + QR views
    let emitQr!: () => void;
    const allowQr = new Promise<void>((resolve) => {
      emitQr = resolve;
    });
    const expiresAt = "2026-11-27T18:00:00.000Z";
    const qrSession = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials: async () => {},
        registerAgentApp: async ({ onQrCode, signal }) => {
          await allowQr;
          onQrCode({
            url: "https://accounts.feishu.cn/qr/1",
            qrDataUrl: "data:image/png;base64,QQ==",
            expiresAt,
          });
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
        fetchBotName: async () => null,
      }),
      commit: async () => {},
    });
    await qrSession.started();
    const qrInput = qrSession.provideInput({ mode: "agent-ready", domain: "feishu" });
    await rs.waitFor(() =>
      expect(qrSession.state).toMatchObject({
        status: "presenting",
        view: { id: "feishu.preparing" },
      }),
    );
    if (qrSession.state.status === "presenting") {
      assertViewMatchesLocale(qrSession.state.view, "preparing");
    }
    emitQr();
    await rs.waitFor(() =>
      expect(qrSession.state).toMatchObject({
        status: "presenting",
        view: { id: "feishu.qr" },
      }),
    );
    if (qrSession.state.status === "presenting") {
      assertViewMatchesLocale(qrSession.state.view, "qr", { expiresAt });
    }
    await qrSession.cancel();
    await qrInput;
  });
});
