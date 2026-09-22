import { describe, expect, it } from "@rstest/core";
import {
  isRomeCompatiblePiModel,
  listEligiblePiModels,
  listInstalledOneTokenProviders,
  type PiCatalogRuntime,
  type PiSdkModel,
  type PiSdkProvider,
} from "./catalog.js";

function provider(id: string, supportsLogin = true): PiSdkProvider {
  return {
    id,
    auth: { apiKey: supportsLogin ? { login() {} } : {} },
  };
}

function model(
  providerId: string,
  id: string,
  api = "anthropic-messages",
  input: PiSdkModel["input"] = ["text"],
): PiSdkModel {
  return { id, name: id, provider: providerId, api, input, reasoning: false };
}

function runtime(providers: PiSdkProvider[], models: PiSdkModel[]): PiCatalogRuntime {
  return {
    getProviders: () => providers,
    getProvider: (providerId) => providers.find((item) => item.id === providerId),
    getModels: (providerId) =>
      providerId ? models.filter((item) => item.provider === providerId) : models,
  };
}

describe("Pi catalog policy", () => {
  it("offers only the reviewed and installed one-token provider intersection", () => {
    const installed = runtime(
      [provider("anthropic"), provider("future-provider"), provider("openai", false)],
      [],
    );

    expect(listInstalledOneTokenProviders(installed).map((item) => item.id)).toEqual(["anthropic"]);
  });

  it("defaults unknown APIs and non-text models out of the Rome capability policy", () => {
    expect(isRomeCompatiblePiModel(model("anthropic", "ok"))).toBe(true);
    expect(isRomeCompatiblePiModel(model("anthropic", "unknown", "future-api"))).toBe(false);
    expect(
      isRomeCompatiblePiModel(model("anthropic", "image-only", "anthropic-messages", ["image"])),
    ).toBe(false);
  });

  it("intersects reviewed, installed, configured, and capable models", () => {
    const installed = runtime(
      [provider("anthropic"), provider("openai"), provider("future-provider")],
      [
        model("anthropic", "shared/model"),
        model("openai", "shared/model", "openai-responses"),
        model("openai", "unknown-api", "future-api"),
        model("future-provider", "future", "openai-responses"),
      ],
    );

    const models = listEligiblePiModels(
      installed,
      new Set(["anthropic", "openai", "future-provider"]),
    );
    expect(models.map((item) => item.qualifiedModelId)).toEqual([
      "anthropic/shared%2Fmodel",
      "openai/shared%2Fmodel",
    ]);
  });

  it("omits models for failed providers while retaining successful partial discovery", () => {
    const installed = runtime(
      [provider("anthropic"), provider("openai")],
      [model("anthropic", "claude"), model("openai", "gpt", "openai-responses")],
    );

    expect(
      listEligiblePiModels(installed, new Set(["anthropic", "openai"]), new Set(["openai"])).map(
        (item) => item.qualifiedModelId,
      ),
    ).toEqual(["anthropic/claude"]);
  });
});
