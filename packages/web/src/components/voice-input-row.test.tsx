// @rstest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import type { VoiceInputInfo } from "@rome/api-types/voice-input";
import i18n from "@/i18n";
import { VoiceInputRow } from "./voice-input-row";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

async function rowText(info: VoiceInputInfo): Promise<string> {
  rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(info)) as typeof fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <VoiceInputRow />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
  await waitFor(() => expect(client.getQueryState(["voice-input"])?.status).toBe("success"));
  return document.body.textContent ?? "";
}

describe("the voice input row in Settings", () => {
  it("names the provider and host and says Rome Cloud provides it", async () => {
    const text = await rowText({
      available: true,
      via: "rome-cloud",
      place: { provider: "Soniox", host: "stt-rt.soniox.com" },
    });
    expect(text).toContain("Voice input");
    expect(text).toContain(
      "Speech dictated into a message goes through Rome to Soniox at stt-rt.soniox.com, provided through Rome Cloud.",
    );
  });

  it("says Rome Cloud cannot be reached rather than naming a provider", async () => {
    const text = await rowText({
      available: true,
      via: "rome-cloud",
      place: null,
      placeUnknown: "rome-cloud-unreachable",
    });
    expect(text).toContain("cannot be reached right now");
    expect(text).not.toContain("Soniox");
  });

  it("says nothing about voice input where there is none, such as an account Rome Cloud does not allow", async () => {
    expect(await rowText({ available: false, via: null, place: null })).toBe("");
  });
});
