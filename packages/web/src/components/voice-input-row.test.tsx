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
      place: null,
      placeUnknown: "rome-cloud-unreachable",
    });
    expect(text).toContain("cannot be reached right now");
    expect(text).not.toContain("Soniox");
  });

  it("asks the guardian to sign in again when Rome Cloud does not accept this Rome", async () => {
    const text = await rowText({
      available: true,
      place: null,
      placeUnknown: "rome-cloud-signed-out",
    });
    expect(text).toContain("Sign in to Rome Cloud again");
  });

  it("says nothing about voice input where there is none, such as an account Rome Cloud does not allow", async () => {
    expect(await rowText({ available: false, place: null })).toBe("");
  });
});

describe("choosing the microphone in Settings", () => {
  afterEach(() => localStorage.clear());

  function devices(list: Array<Partial<MediaDeviceInfo>>, getUserMedia = rs.fn()) {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: rs.fn(async () => list),
        getUserMedia,
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      },
    });
  }

  it("offers to show the microphones while the browser hides their names", async () => {
    devices([{ kind: "audioinput", deviceId: "x", label: "" }]);
    await rowText({ available: true, place: { provider: "Soniox", host: "stt-rt.soniox.com" } });
    expect(await screen.findByRole("button", { name: "Show microphones" })).toBeTruthy();
  });

  it("shows the system default when no microphone is chosen", async () => {
    devices([{ kind: "audioinput", deviceId: "usb", label: "USB Microphone" }]);
    await rowText({ available: true, place: { provider: "Soniox", host: "stt-rt.soniox.com" } });
    const select = await screen.findByRole("combobox", { name: "Microphone" });
    await waitFor(() => expect(select.textContent).toContain("System default"));
  });

  it("says when the chosen microphone is not connected", async () => {
    localStorage.setItem("rome.voiceInput.microphone", "gone");
    devices([{ kind: "audioinput", deviceId: "usb", label: "USB Microphone" }]);
    const text = await rowText({
      available: true,
      place: { provider: "Soniox", host: "stt-rt.soniox.com" },
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("The chosen microphone isn't connected"),
    );
    expect(text).toContain("Microphone");
  });
});
