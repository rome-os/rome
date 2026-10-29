// @rstest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, rs } from "@rstest/core";
import { render } from "@/test/query-render";
import i18n from "@/i18n";
import { CodexDeviceLoginModal } from "./codex-device-login-modal";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});
it("detects a device login completing through the shared cache poll", async () => {
  let loggedIn = false;
  const onConnected = rs.fn();
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) === "/api/ai-tools/status") return Response.json({ codex: { loggedIn } });
    return Response.json({ userCode: "TEST-CODE", verificationUrl: "https://example.com/verify" });
  });
  render(<CodexDeviceLoginModal open onClose={() => {}} onConnected={onConnected} />);
  loggedIn = true;
  await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1), { timeout: 5000 });
});
