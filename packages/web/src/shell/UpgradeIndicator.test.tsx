// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { UpgradeIndicator } from "./UpgradeIndicator";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  rs.stubGlobal("requestIdleCallback", (cb: () => void) => {
    cb();
    return 1;
  });
  rs.stubGlobal("cancelIdleCallback", () => {});
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

interface Scripted {
  status: number;
  body: unknown;
}

const json = ({ status, body }: Scripted) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function available(current: string, latest: string): Scripted {
  return {
    status: 200,
    body: {
      current: { version: current, sha: "abc1234" },
      latest: { version: latest },
      upgradeAvailable: current !== latest,
    },
  };
}

const GUARDIAN = { kind: "guardian", userId: "g", displayName: "Ray", avatarUrl: null };

/**
 * A fake backend at the fetch seam; `check` and `upgrade` are consumed in
 * order (the last check repeats). `build` is the version build-info reports,
 * read on every probe, so a test moves it to finish the upgrade.
 */
function mockBackend(opts: {
  identity?: unknown;
  check: Scripted[];
  // "timeout" plays the request's own deadline firing (fetch rejects).
  upgrade?: (Scripted | "timeout")[];
  // Each build-info probe answers this late (on the test's timers).
  buildDelayMs?: number;
}) {
  const checks = [...opts.check];
  const upgrades = [...(opts.upgrade ?? [])];
  const upgradeRequests: unknown[] = [];
  const state = { build: "1.1.0" };
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url === "/api/auth/me") return json({ status: 200, body: opts.identity ?? GUARDIAN });
    if (url === "/api/settings") return json({ status: 200, body: { agentName: "Milo" } });
    if (url === "/api/system/upgrade/check") {
      const next = checks.length > 1 ? checks.shift() : checks[0];
      if (!next) throw new Error("unexpected upgrade check");
      return json(next);
    }
    if (url === "/api/system/upgrade" && init?.method === "POST") {
      upgradeRequests.push(JSON.parse(String(init.body)));
      const next = upgrades.shift();
      if (!next) throw new Error("unexpected upgrade request");
      if (next === "timeout") throw new DOMException("signal timed out", "TimeoutError");
      return json(next);
    }
    if (url === "/api/build-info") {
      if (opts.buildDelayMs) await new Promise((r) => setTimeout(r, opts.buildDelayMs));
      return json({ status: 200, body: { version: state.build } });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch);
  return { upgradeRequests, state };
}

function renderIndicator({ suppressed = false, labelled = true } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpgradeIndicator suppressed={suppressed} labelled={labelled} />
    </QueryClientProvider>,
  );
}

const OFFER = "Update Milo to 1.2.0";
const UPDATING = "Milo is updating to 1.2.0…";
const FAILED = "Update to 1.2.0 failed · Retry";
const UPDATED = "Milo updated to 1.2.0 · Reload";
const ACCEPTED: Scripted = { status: 202, body: { status: "upgrading", target: "1.2.0" } };

/** Opens the confirmation from the row and confirms it. */
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: OFFER }));
  await user.click(await screen.findByRole("button", { name: "Upgrade and restart" }));
}

describe("UpgradeIndicator", () => {
  it("offers the guardian the newer release on one short line, the agent named in full", async () => {
    mockBackend({ check: [available("1.1.0", "1.2.0")] });
    renderIndicator();
    const user = userEvent.setup();

    const row = await screen.findByRole("button", { name: OFFER });
    expect(row.textContent).toBe("Update to 1.2.0");
    await user.hover(row);
    expect((await screen.findByRole("tooltip")).textContent).toContain(OFFER);
  });

  it("shows the icon alone in the bare rail, with the text in its tooltip", async () => {
    mockBackend({ check: [available("1.1.0", "1.2.0")] });
    renderIndicator({ labelled: false });
    const user = userEvent.setup();

    const row = await screen.findByRole("button", { name: OFFER });
    expect(row.textContent).toBe("");
    await user.hover(row);
    expect((await screen.findByRole("tooltip")).textContent).toContain(OFFER);
  });

  it("shows nothing when the latest release is not newer", async () => {
    // The server's own flag says "available" for any mismatch, a rollback too.
    mockBackend({ check: [available("1.3.0", "1.2.0")] });
    renderIndicator();

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/system/upgrade/check", expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
  });

  it("offers a dashboard visitor the same row and confirmation", async () => {
    const backend = mockBackend({
      identity: { kind: "visitor", accountId: "a", email: "v@example.com", avatarUrl: null },
      check: [available("1.1.0", "1.2.0")],
      upgrade: [ACCEPTED],
    });
    renderIndicator();
    await confirm(userEvent.setup());

    expect(await screen.findByRole("status", { name: UPDATING })).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }]);
  });

  it("does not check before anyone is signed in", async () => {
    mockBackend({ identity: { kind: "anonymous" }, check: [available("1.1.0", "1.2.0")] });
    renderIndicator();

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/me", expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/system/upgrade/check",
      expect.anything(),
    );
  });

  it("hides the offer while the nightly upgrade banner is up", async () => {
    mockBackend({ check: [available("1.1.0", "1.2.0")] });
    renderIndicator({ suppressed: true });

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/system/upgrade/check", expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
  });

  it("confirms, then closes the dialog and shows the upgrade in the row", async () => {
    const backend = mockBackend({ check: [available("1.1.0", "1.2.0")], upgrade: [ACCEPTED] });
    renderIndicator();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: OFFER }));
    expect(await screen.findByText("Upgrade Milo to 1.2.0?")).toBeTruthy();
    expect(backend.upgradeRequests).toHaveLength(0);
    // The Rome logo marks the dialog, not a lettered placeholder tile.
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("svg[viewBox='0 0 51 48']")).toBeTruthy();
    expect(within(dialog).queryByText("R")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Upgrade and restart" }));

    const status = await screen.findByRole("status", { name: UPDATING });
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }]);
    expect(status.querySelector(".animate-spin")).toBeTruthy();
    // Nothing blocks the page: the dialog is gone.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says updated with Reload once the backend is on the target, and reloads only on a click", async () => {
    const reload = rs.fn();
    rs.stubGlobal("location", { ...window.location, reload });
    rs.useFakeTimers({ shouldAdvanceTime: true });
    const backend = mockBackend({ check: [available("1.1.0", "1.2.0")], upgrade: [ACCEPTED] });
    renderIndicator();
    const user = userEvent.setup({ advanceTimers: rs.advanceTimersByTime });

    try {
      await confirm(user);
      expect(await screen.findByRole("status", { name: UPDATING })).toBeTruthy();

      backend.state.build = "1.2.0";
      await rs.advanceTimersByTimeAsync(3_000);

      const done = await screen.findByRole("button", { name: UPDATED });
      expect(done.textContent).toBe("UpdatedReload");
      // It stays: no reload and no timer takes it away.
      await rs.advanceTimersByTimeAsync(10 * 60_000);
      expect(screen.getByRole("button", { name: UPDATED })).toBe(done);
      expect(reload).not.toHaveBeenCalled();

      await user.click(done);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      rs.useRealTimers();
    }
  });

  it("re-checks and asks again with the new latest when the target is stale (409)", async () => {
    const backend = mockBackend({
      check: [available("1.1.0", "1.2.0"), available("1.1.0", "1.3.0")],
      upgrade: [
        { status: 409, body: { error: "target_not_latest", latest: "1.3.0" } },
        { status: 202, body: { status: "upgrading", target: "1.3.0" } },
      ],
    });
    renderIndicator();
    const user = userEvent.setup();
    await confirm(user);

    expect(await screen.findByText("Upgrade Milo to 1.3.0?")).toBeTruthy();
    expect(
      screen.getByText(
        "A newer version (1.3.0) was published in the meantime — confirm again to upgrade to it.",
      ),
    ).toBeTruthy();
    const button = screen.getByRole("button", {
      name: "Upgrade and restart",
    }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);

    expect(await screen.findByRole("status", { name: "Milo is updating to 1.3.0…" })).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }, { target: "1.3.0" }]);
  });

  it("keeps the dialog open with the error when the request fails", async () => {
    mockBackend({
      check: [available("1.1.0", "1.2.0")],
      upgrade: [{ status: 502, body: { error: "pantheon_unreachable" } }],
    });
    renderIndicator();
    await confirm(userEvent.setup());

    expect(await screen.findByText("Upgrade request failed: pantheon_unreachable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("reads an upgrade already in progress as updating", async () => {
    mockBackend({
      check: [available("1.1.0", "1.2.0")],
      upgrade: [{ status: 409, body: { error: "upgrade_in_progress" } }],
    });
    renderIndicator();
    await confirm(userEvent.setup());

    expect(await screen.findByRole("status", { name: UPDATING })).toBeTruthy();
  });

  it("gives the dialog back when the upgrade request times out", async () => {
    mockBackend({ check: [available("1.1.0", "1.2.0")], upgrade: ["timeout"] });
    renderIndicator();
    await confirm(userEvent.setup());

    // A lost request must not leave the dialog locked: the error shows and both
    // buttons work again.
    expect(await screen.findByText("Upgrade request failed: request_timeout")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    const button = screen.getByRole("button", {
      name: "Upgrade and restart",
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it("fails after 40 minutes of wall-clock time, and Retry asks again", async () => {
    rs.useFakeTimers({ shouldAdvanceTime: true });
    // The old backend never comes back on the target, and every probe takes 4 s.
    const backend = mockBackend({
      check: [available("1.1.0", "1.2.0")],
      upgrade: [ACCEPTED, ACCEPTED],
      buildDelayMs: 4_000,
    });
    renderIndicator();
    const user = userEvent.setup({ advanceTimers: rs.advanceTimersByTime });

    try {
      await confirm(user);
      expect(await screen.findByRole("status", { name: UPDATING })).toBeTruthy();

      await rs.advanceTimersByTimeAsync(40 * 60_000 + 8_000);

      const failed = await screen.findByRole("button", { name: FAILED });
      await user.click(failed);
      // Retry first asks build-info whether the upgrade landed after all.
      await rs.advanceTimersByTimeAsync(4_000);

      expect(await screen.findByRole("status", { name: UPDATING })).toBeTruthy();
      await waitFor(() =>
        expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }, { target: "1.2.0" }]),
      );
    } finally {
      rs.useRealTimers();
    }
  });

  it("finishes on Retry without asking again when the backend is already on the target", async () => {
    rs.useFakeTimers({ shouldAdvanceTime: true });
    const backend = mockBackend({
      check: [available("1.1.0", "1.2.0")],
      upgrade: [ACCEPTED],
      buildDelayMs: 4_000,
    });
    renderIndicator();
    const user = userEvent.setup({ advanceTimers: rs.advanceTimersByTime });

    try {
      await confirm(user);
      await rs.advanceTimersByTimeAsync(40 * 60_000 + 8_000);
      const failed = await screen.findByRole("button", { name: FAILED });

      backend.state.build = "1.2.0";
      await user.click(failed);
      await rs.advanceTimersByTimeAsync(4_000);

      expect(await screen.findByRole("button", { name: UPDATED })).toBeTruthy();
      expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }]);
    } finally {
      rs.useRealTimers();
    }
  });
});
