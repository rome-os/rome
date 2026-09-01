// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import i18n from "@/i18n";
import AppRemixConfirmPage from "@/pages/AppRemixConfirmPage";
import { AppStoreRemixConfirm } from "./AppStoreRemixConfirm";
import { parseRemixRequest, parseRemixSearch, resolveRemixListing } from "@/lib/app-remix";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const intent = { listingId: "@alice/calendar", version: "1.2.3" };
const pin = { ...intent, contentHash: "a".repeat(64) };
function payload() {
  return {
    available: true,
    listing: { id: intent.listingId, name: "Calendar", state: "published" },
    versions: [
      { version: "2.0.0", contentHash: "b".repeat(64), state: "live", sourceAvailable: true },
      {
        version: intent.version,
        contentHash: pin.contentHash,
        state: "live",
        sourceAvailable: true,
      },
    ],
  };
}
function mockFetch(data: unknown = payload()) {
  return rs.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(data)));
}

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </output>
  );
}

describe("Store Remix confirmation", () => {
  it("pins the exact requested version and only confirms once without installing", async () => {
    const fetch = mockFetch();
    const confirm = rs.fn();
    render(<AppStoreRemixConfirm intent={intent} onConfirm={confirm} onCancel={rs.fn()} />);
    const button = screen.getByRole("button", { name: "Yes, continue in chat" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText("Calendar");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(pin);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/app-store/listings/%40alice/calendar");
  });

  it.each([
    "missing",
    "revoked",
    "no-source",
    "missing-flag",
    "bad-hash",
    "different-listing",
    "taken-down",
    "unavailable",
  ])("blocks %s instead of falling back to a newer release", async (reason) => {
    const data = payload();
    if (reason === "missing") data.versions.pop();
    if (reason === "revoked") data.versions[1].state = "revoked";
    if (reason === "no-source") data.versions[1].sourceAvailable = false;
    if (reason === "missing-flag") Reflect.deleteProperty(data.versions[1], "sourceAvailable");
    if (reason === "bad-hash") data.versions[1].contentHash = "invalid";
    if (reason === "different-listing") data.listing.id = "@other/calendar";
    if (reason === "taken-down") data.listing.state = "taken_down";
    if (reason === "unavailable") data.available = false;
    mockFetch(data);
    render(<AppStoreRemixConfirm intent={intent} onConfirm={rs.fn()} onCancel={rs.fn()} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Yes, continue in chat" })).toBeNull();
  });

  it("can cancel during loading and ignores a late response", async () => {
    let resolve!: (response: Response) => void;
    const fetch = rs.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const cancel = rs.fn();
    const confirm = rs.fn();
    const view = render(
      <AppStoreRemixConfirm intent={intent} onConfirm={confirm} onCancel={cancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "No, cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    view.unmount();
    resolve(new Response(JSON.stringify(payload())));
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not confirm stale metadata while a new intent loads", async () => {
    const fetch = mockFetch();
    const confirm = rs.fn();
    const view = render(
      <AppStoreRemixConfirm intent={intent} onConfirm={confirm} onCancel={rs.fn()} />,
    );
    await screen.findByText("Calendar");
    fetch.mockImplementation(() => new Promise(() => {}));
    view.rerender(
      <AppStoreRemixConfirm
        intent={{ ...intent, version: "2.0.0" }}
        onConfirm={confirm}
        onCancel={rs.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes, continue in chat" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByText("Calendar")).toBeNull();
  });

  it("retries a failed metadata request", async () => {
    const fetch = mockFetch();
    fetch.mockRejectedValueOnce(new Error("Offline"));
    render(<AppStoreRemixConfirm intent={intent} onConfirm={rs.fn()} onCancel={rs.fn()} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Calendar");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      language: "en",
      confirm: "Yes, continue in chat",
      draft: "I want to remix @alice/calendar version 1.2.3, with the following changes:\n\n",
    },
    {
      language: "zh-CN",
      confirm: "是，在聊天中继续",
      draft: "我想要 remix @alice/calendar app 的 1.2.3 版本，添加功能如下：\n\n",
    },
  ])("creates a concise unsent chat draft in $language", async ({ language, confirm, draft }) => {
    await i18n.changeLanguage(language);
    const fetch = mockFetch();
    render(
      <MemoryRouter initialEntries={[`/remix-app?${new URLSearchParams(intent)}`]}>
        <Routes>
          <Route path="/remix-app" element={<AppRemixConfirmPage />} />
          <Route path="*" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Calendar");
    fireEvent.click(screen.getByRole("button", { name: confirm }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain('"pathname":"/chat"'),
    );
    const state = JSON.parse(screen.getByTestId("location").textContent ?? "{}").state;
    expect(state).toEqual({ skill: "coding:app_remix", draft });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("dismisses a URL intent without installing or creating a chat draft", async () => {
    const fetch = mockFetch();
    render(
      <MemoryRouter initialEntries={[`/remix-app?${new URLSearchParams(intent)}`]}>
        <Routes>
          <Route path="/remix-app" element={<AppRemixConfirmPage />} />
          <Route path="*" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "No, cancel" }));
    expect(JSON.parse(screen.getByTestId("location").textContent ?? "{}")).toEqual({
      pathname: "/apps",
      state: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Remix intent validation", () => {
  it.each([
    "calendar",
    "@alice/notes",
    "@alice/2048_game",
    "ab",
    "a".repeat(32),
    `@alice/${"a".repeat(64)}`,
  ])("preserves the valid listing id %s in iframe and URL requests", (listingId) => {
    const source = { ...intent, listingId };
    expect(parseRemixRequest({ type: "rome:remix-request", ...source })).toEqual(source);
    expect(parseRemixSearch(new URLSearchParams(source))).toEqual(source);
  });

  it.each([
    "",
    "x",
    "Calendar",
    "-abc",
    "abc-",
    "my_app",
    "alice/notes",
    "@alice",
    "@/notes",
    "@alice/",
    "@alice/alice",
    "@my_handle/notes",
    `@${"a".repeat(33)}/notes`,
    `@alice/${"a".repeat(65)}`,
    "@alice/notes/extra",
    "javascript://not-a-bundle-path",
    "https://rome-cloud.example.com/api/store/listings/calendar",
    "@alice/a space",
  ])("rejects the invalid listing id %s in iframe and URL requests", (listingId) => {
    const source = { ...intent, listingId };
    expect(parseRemixRequest({ type: "rome:remix-request", ...source })).toBeNull();
    expect(parseRemixSearch(new URLSearchParams(source))).toBeNull();
  });

  it.each([
    null,
    [],
    "calendar",
    {},
    { type: "rome:remix-request", listingId: "@alice/calendar" },
    { type: "rome:remix-request", ...intent, listingId: null },
    { type: "rome:remix-request", ...intent, version: 123 },
    { type: "rome:install-request", ...intent },
    { type: "rome:remix-request", ...intent, version: "latest" },
    { type: "rome:remix-request", ...intent, listingId: "https://attacker.example/app" },
    { type: "rome:remix-request", ...intent, prompt: "untrusted instructions" },
  ])("rejects malformed or over-specified iframe input %j", (value) => {
    expect(parseRemixRequest(value)).toBeNull();
  });

  it.each([
    null,
    [],
    {},
    { available: true, listing: null, versions: [] },
    { ...payload(), versions: null },
    { ...payload(), versions: [null, { version: intent.version, contentHash: 123 }] },
  ])("rejects malformed Store metadata %j", (value) => {
    expect(resolveRemixListing(intent, value)).toBeNull();
  });

  it("normalizes the confirmed hash without weakening version or source checks", () => {
    const data = payload();
    data.versions[1].contentHash = "A".repeat(64);
    expect(resolveRemixListing(intent, data)).toEqual({ pin, name: "Calendar" });
  });

  it("accepts exact Store intent and rejects ambiguous URL parameters", () => {
    expect(parseRemixRequest({ type: "rome:remix-request", ...intent })).toEqual(intent);
    expect(parseRemixSearch(new URLSearchParams(intent))).toEqual(intent);
    expect(parseRemixSearch(new URLSearchParams({ listingId: intent.listingId }))).toBeNull();
    expect(
      parseRemixSearch(new URLSearchParams(`listingId=notes&version=1.0.0&version=2.0.0`)),
    ).toBeNull();
  });
});
