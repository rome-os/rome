import { describe, expect, it } from "@rstest/core";
import { allowsMedia, installMicrophonePermission } from "./microphone-permission";

const ROME = "https://rome.example.com";
const ask = (overrides: Partial<Parameters<typeof allowsMedia>[0]> = {}) =>
  allowsMedia(
    {
      url: "https://rome.example.com/chat/abc",
      isMainFrame: true,
      mediaTypes: ["audio"],
      ...overrides,
    },
    ROME,
  );

describe("allowsMedia", () => {
  it("gives the microphone to the Rome this launch opened", () => {
    expect(ask()).toBe(true);
  });

  it("refuses another origin, such as a sign-in page", () => {
    expect(ask({ url: "https://github.com/login" })).toBe(false);
    expect(ask({ url: "https://rome.example.com:8443/chat" })).toBe(false);
  });

  it("refuses a frame inside the dashboard", () => {
    expect(ask({ isMainFrame: false })).toBe(false);
  });

  it("refuses the camera and screen capture", () => {
    expect(ask({ mediaTypes: ["video"] })).toBe(false);
    expect(ask({ mediaTypes: ["audio", "video"] })).toBe(false);
    expect(ask({ mediaTypes: [] })).toBe(false);
  });

  it("refuses everything before a Rome is open, Rome Cloud included", () => {
    expect(
      allowsMedia(
        { url: "https://romeos.cc/login", isMainFrame: true, mediaTypes: ["audio"] },
        null,
      ),
    ).toBe(false);
  });
});

/** The two handlers a session was given, called the way Electron calls them. */
function installed(origin: string | null = ROME) {
  let request: ((...args: never[]) => void) | undefined;
  let check: ((...args: never[]) => boolean) | undefined;
  installMicrophonePermission(
    {
      setPermissionRequestHandler: (handler) => {
        request = handler as never;
      },
      setPermissionCheckHandler: (handler) => {
        check = handler as never;
      },
    },
    () => origin,
  );
  const requested = (permission: string, details: Record<string, unknown> = {}) => {
    let answer: boolean | undefined;
    (request as (...args: unknown[]) => void)(
      {},
      permission,
      (granted: boolean) => {
        answer = granted;
      },
      details,
    );
    return answer;
  };
  const checked = (permission: string, details: Record<string, unknown> = {}) =>
    (check as (...args: unknown[]) => boolean)({}, permission, ROME, details);
  return { requested, checked };
}

describe("installMicrophonePermission", () => {
  it("gives the open Rome's main frame the microphone", () => {
    const { requested, checked } = installed();
    expect(
      requested("media", {
        requestingUrl: `${ROME}/chat`,
        isMainFrame: true,
        mediaTypes: ["audio"],
      }),
    ).toBe(true);
    expect(checked("media", { securityOrigin: ROME, isMainFrame: true, mediaType: "audio" })).toBe(
      true,
    );
  });

  it("refuses screen capture to every page, the open Rome included", () => {
    const { requested, checked } = installed();
    expect(requested("display-capture", { requestingUrl: `${ROME}/chat`, isMainFrame: true })).toBe(
      false,
    );
    expect(checked("display-capture", { securityOrigin: ROME, isMainFrame: true })).toBe(false);
  });

  it("keeps Electron's refusal of synchronous clipboard reads", () => {
    const { requested, checked } = installed();
    expect(requested("deprecated-sync-clipboard-read")).toBe(false);
    expect(checked("deprecated-sync-clipboard-read")).toBe(false);
  });

  it("keeps Electron's grant for other permissions", () => {
    const { requested, checked } = installed();
    expect(requested("notifications")).toBe(true);
    expect(checked("fullscreen")).toBe(true);
  });

  it("refuses the microphone while no Rome is open", () => {
    const { requested } = installed(null);
    expect(
      requested("media", {
        requestingUrl: `${ROME}/chat`,
        isMainFrame: true,
        mediaTypes: ["audio"],
      }),
    ).toBe(false);
  });
});
