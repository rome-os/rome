import { describe, expect, it } from "@rstest/core";
import { canRunModel, modelFamily, runnableLargeModelOptions } from "./chat-constants";

const signedIn = (anthropic: boolean, openai: boolean, rome_credits: boolean) => ({
  anthropic,
  openai,
  rome_credits,
});

describe("runnable models", () => {
  it("knows the provider family of a model id", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("anthropic");
    expect(modelFamily("gpt-6-astra")).toBe("openai");
    expect(modelFamily("auto")).toBeNull();
  });

  it("runs ChatGPT models on a ChatGPT sign-in or on Rome credits", () => {
    expect(canRunModel("gpt-6-astra", signedIn(true, false, false))).toBe(false);
    expect(canRunModel("gpt-6-astra", signedIn(false, true, false))).toBe(true);
    expect(canRunModel("gpt-6-astra", signedIn(false, false, true))).toBe(true);
    expect(canRunModel("claude-opus", signedIn(false, true, true))).toBe(false);
    expect(canRunModel("auto", signedIn(false, false, false))).toBe(true);
  });

  it("hides nothing while the sign-ins are unknown", () => {
    expect(canRunModel("claude-opus", null)).toBe(true);
  });

  it("offers signed-in providers' models and keeps the chat's own pick", () => {
    const ids = runnableLargeModelOptions(signedIn(true, false, false), "gpt-6-luna").map(
      (option) => option.id,
    );
    expect(ids).toContain("auto");
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).toContain("gpt-6-luna");
    expect(ids).not.toContain("gpt-6-astra");
  });
});
