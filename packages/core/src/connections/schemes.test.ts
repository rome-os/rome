// The shipped auth-scheme builders. `credentialsPaste` is the
// multi-field general case; `tokenPaste` is its single-`token` specialization.
// Both confer through a headless `GuardianInteraction` fake that echoes canned
// form answers, and both answer "re-confer" from renew().

import { describe, expect, it } from "@rstest/core";
import { credentialsPaste, romeCloudOAuth, tokenPaste } from "./schemes.js";
import type { GuardianInteraction } from "./types.js";

/** A prompt fake: records the requested form and answers with `answers`. */
function fakeInteract(answers: Record<string, string>): {
  interact: GuardianInteraction;
  forms: Parameters<GuardianInteraction["prompt"]>[0][];
} {
  const forms: Parameters<GuardianInteraction["prompt"]>[0][] = [];
  return {
    forms,
    interact: {
      async prompt(form) {
        forms.push(form);
        return answers;
      },
    },
  };
}

describe("credentialsPaste", () => {
  it("prompts every declared field (secret default true, line default) and returns the collected material", async () => {
    const scheme = credentialsPaste({
      instructions: "Paste your app credentials.",
      fields: [
        { name: "appId", label: "App ID", secret: false },
        { name: "appSecret", label: "App secret" },
        { name: "domain", label: "Domain", secret: false, options: ["feishu", "lark"] },
      ],
      validate: async () => {},
    });
    const { interact, forms } = fakeInteract({
      appId: "cli_x",
      appSecret: "s3cr3t",
      domain: "feishu",
    });

    const cred = await scheme.confer(interact);

    expect(forms).toEqual([
      {
        instructions: "Paste your app credentials.",
        fields: [
          { name: "appId", label: "App ID", secret: false, format: "line" },
          { name: "appSecret", label: "App secret", secret: true, format: "line" },
          {
            name: "domain",
            label: "Domain",
            secret: false,
            format: "line",
            options: ["feishu", "lark"],
          },
        ],
      },
    ]);
    expect(cred).toEqual({
      material: { appId: "cli_x", appSecret: "s3cr3t", domain: "feishu" },
      expiresAt: "never",
    });
  });

  it("runs validate with the collected material and surfaces its rejection", async () => {
    const seen: Record<string, string>[] = [];
    const scheme = credentialsPaste({
      fields: [{ name: "appId", label: "App ID" }],
      validate: async (material) => {
        seen.push(material);
        throw new Error("bad app credentials");
      },
    });
    const { interact } = fakeInteract({ appId: "cli_x" });

    await expect(scheme.confer(interact)).rejects.toThrow("bad app credentials");
    expect(seen).toEqual([{ appId: "cli_x" }]);
  });

  it("answers re-confer from renew (no headless renewal)", async () => {
    const scheme = credentialsPaste({
      fields: [{ name: "appId", label: "App ID" }],
      validate: async () => {},
    });
    await expect(scheme.renew({ material: {}, expiresAt: "never" })).resolves.toBe("re-confer");
  });
});

describe("tokenPaste", () => {
  it("prompts one secret `token` field and returns { token }", async () => {
    const scheme = tokenPaste({
      label: "Bot token",
      instructions: "Paste the bot token.",
      validate: async () => {},
    });
    const { interact, forms } = fakeInteract({ token: "abc123" });

    const cred = await scheme.confer(interact);

    expect(forms).toEqual([
      {
        instructions: "Paste the bot token.",
        fields: [{ name: "token", label: "Bot token", secret: true, format: "line" }],
      },
    ]);
    expect(cred).toEqual({ material: { token: "abc123" }, expiresAt: "never" });
  });

  it("validates the pasted token value and surfaces rejection", async () => {
    const seen: string[] = [];
    const scheme = tokenPaste({
      label: "Bot token",
      validate: async (token) => {
        seen.push(token);
        throw new Error("nope");
      },
    });
    const { interact } = fakeInteract({ token: "abc123" });

    await expect(scheme.confer(interact)).rejects.toThrow("nope");
    expect(seen).toEqual(["abc123"]);
  });

  it("answers re-confer from renew", async () => {
    const scheme = tokenPaste({ label: "Bot token", validate: async () => {} });
    await expect(scheme.renew({ material: {}, expiresAt: "never" })).resolves.toBe("re-confer");
  });
});

describe("romeCloudOAuth", () => {
  const fakeInteract2: GuardianInteraction = {
    async prompt() {
      return {};
    },
  };

  it.each([
    "github",
    "slack",
    "google",
  ])("throws from confer — conferral is driven by the oauth redeem route (%s)", async (provider) => {
    const scheme = romeCloudOAuth({ provider });
    await expect(scheme.confer(fakeInteract2)).rejects.toThrow(/oauth redeem route/);
    await expect(scheme.confer(fakeInteract2)).rejects.toThrow(provider);
  });

  it("answers re-confer from renew (no Rome Cloud refresh exchange yet)", async () => {
    const scheme = romeCloudOAuth({ provider: "github" });
    await expect(
      scheme.renew({
        material: { accessToken: "gho_x", refreshToken: "ghr_y" },
        expiresAt: "never",
      }),
    ).resolves.toBe("re-confer");
  });
});
