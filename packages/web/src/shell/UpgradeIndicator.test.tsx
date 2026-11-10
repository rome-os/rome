// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

/** A fake backend at the fetch seam; `check` and `upgrade` are consumed in order (last repeats). */
function mockBackend(opts: { identity?: unknown; check: Scripted[]; upgrade?: Scripted[] }) {
  const checks = [...opts.check];
  const upgrades = [...(opts.upgrade ?? [])];
  const upgradeRequests: unknown[] = [];
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
      return json(next);
    }
    if (url === "/api/build-info") return json({ status: 200, body: { version: "1.1.0" } });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch);
  return { upgradeRequests };
}

function renderIndicator(suppressed = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UpgradeIndicator suppressed={suppressed} tooltipSide="bottom" />
    </QueryClientProvider>,
  );
}

const ARROW = "Milo can be upgraded";

describe("UpgradeIndicator", () => {
  it("shows the guardian an arrow named after the agent when a newer release exists", async () => {
    mockBackend({ check: [available("1.1.0", "1.2.0")] });
    renderIndicator();

    expect(await screen.findByRole("button", { name: ARROW })).toBeTruthy();
  });

  it("shows nothing when the latest release is not newer", async () => {
    // The server's own flag says "available" for any mismatch, a rollback too.
    mockBackend({ check: [available("1.3.0", "1.2.0")] });
    renderIndicator();

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/system/upgrade/check", expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: ARROW })).toBeNull();
  });

  it("shows nothing to a dashboard visitor, and does not check", async () => {
    mockBackend({
      identity: { kind: "visitor", accountId: "a", email: "v@example.com", avatarUrl: null },
      check: [available("1.1.0", "1.2.0")],
    });
    renderIndicator();

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/auth/me", expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: ARROW })).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/system/upgrade/check",
      expect.anything(),
    );
  });

  it("stays hidden while the nightly upgrade banner is up", async () => {
    mockBackend({ check: [available("1.1.0", "1.2.0")] });
    renderIndicator(true);

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/system/upgrade/check", expect.anything()),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: ARROW })).toBeNull();
  });

  it("confirms, then upgrades in the dialog and shows the restart", async () => {
    const backend = mockBackend({
      check: [available("1.1.0", "1.2.0")],
      upgrade: [{ status: 202, body: { status: "upgrading", target: "1.2.0" } }],
    });
    renderIndicator();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: ARROW }));
    expect(await screen.findByText("Upgrade Milo to 1.2.0?")).toBeTruthy();
    expect(backend.upgradeRequests).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Upgrade and restart" }));

    expect(await screen.findByText("Milo is restarting")).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }]);
    // Nothing to cancel any more: the page reloads on the new version.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
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

    await user.click(await screen.findByRole("button", { name: ARROW }));
    await user.click(await screen.findByRole("button", { name: "Upgrade and restart" }));

    expect(await screen.findByText("Upgrade Milo to 1.3.0?")).toBeTruthy();
    expect(
      screen.getByText(
        "A newer version (1.3.0) was published in the meantime — confirm again to upgrade to it.",
      ),
    ).toBeTruthy();
    const confirm = screen.getByRole("button", {
      name: "Upgrade and restart",
    }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    await user.click(confirm);

    expect(await screen.findByText("Milo is restarting")).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }, { target: "1.3.0" }]);
  });

  it("keeps the dialog open with the error when the request fails", async () => {
    mockBackend({
      check: [available("1.1.0", "1.2.0")],
      upgrade: [{ status: 409, body: { error: "upgrade_in_progress" } }],
    });
    renderIndicator();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: ARROW }));
    await user.click(await screen.findByRole("button", { name: "Upgrade and restart" }));

    expect(await screen.findByText("Upgrade request failed: upgrade_in_progress")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
