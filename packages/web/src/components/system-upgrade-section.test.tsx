// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { SystemUpgradeSection } from "./system-upgrade-section";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix dialog pokes pointer-capture and scrollIntoView, which jsdom omits.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

interface BuildInfoFixture {
  version: string | null;
  sha: string | null;
  builtAt: string | null;
  upgradedSinceLastBoot: boolean;
  previousVersion: string | null;
}

function buildInfo(overrides: Partial<BuildInfoFixture> = {}): BuildInfoFixture {
  return {
    version: "1.1.0",
    sha: "abc1234",
    builtAt: "2026-06-01T12:00:00Z",
    upgradedSinceLastBoot: false,
    previousVersion: null,
    ...overrides,
  };
}

interface ScriptedResponse {
  status: number;
  body: unknown;
  // Resolves before the response is sent, so a test can hold a request open
  // and prove what the UI allows while it is in flight.
  wait?: Promise<void>;
}

/**
 * Stateful fake backend at the fetch seam. `check` and `upgrade` are arrays
 * consumed in order so a test can script "409 first, then a new latest" and
 * prove the section re-reads server truth instead of trusting a stale answer.
 * `build` likewise accepts a scripted array (last entry repeats) to exercise
 * build-info failures.
 */
function mockBackend(opts: {
  build: BuildInfoFixture | ScriptedResponse[];
  check?: ScriptedResponse[];
  upgrade?: ScriptedResponse[];
}) {
  const buildResponses = Array.isArray(opts.build)
    ? [...opts.build]
    : [{ status: 200, body: opts.build }];
  const checkResponses = [...(opts.check ?? [])];
  const upgradeResponses = [...(opts.upgrade ?? [])];
  const upgradeRequests: unknown[] = [];

  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const respond = async (next: ScriptedResponse) => {
      await next.wait;
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "Content-Type": "application/json" },
      });
    };

    if (url === "/api/build-info") {
      const next = buildResponses.length > 1 ? buildResponses.shift() : buildResponses[0];
      if (!next) throw new Error("unexpected build-info request");
      return respond(next);
    }
    if (url === "/api/system/upgrade/check") {
      const next = checkResponses.length > 1 ? checkResponses.shift() : checkResponses[0];
      if (!next) throw new Error("unexpected upgrade check");
      return respond(next);
    }
    if (url === "/api/system/upgrade" && init?.method === "POST") {
      upgradeRequests.push(JSON.parse(String(init.body)));
      const next = upgradeResponses.shift();
      if (!next) throw new Error("unexpected upgrade request");
      return respond(next);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch);

  return { upgradeRequests };
}

// The check button starts disabled until build-info resolves, and a click on a
// disabled button is silently inert — wait for it to enable before clicking.
async function findEnabledButton(name: string): Promise<HTMLButtonElement> {
  const button = (await screen.findByRole("button", { name })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SystemUpgradeSection />
    </QueryClientProvider>,
  );
}

const CHECK_AVAILABLE = {
  status: 200,
  body: {
    current: { version: "1.1.0", sha: "abc1234" },
    latest: { version: "1.2.0" },
    upgradeAvailable: true,
  },
};

describe("SystemUpgradeSection", () => {
  it("shows the current version with its build date", async () => {
    mockBackend({ build: buildInfo() });
    renderSection();

    expect(await screen.findByText("1.1.0")).toBeTruthy();
    expect(screen.getByText(/Built /)).toBeTruthy();
  });

  it("explains that upgrades are unsupported on an unversioned build instead of offering a check", async () => {
    mockBackend({ build: buildInfo({ version: null, builtAt: null }) });
    renderSection();

    expect(await screen.findByText(/Unknown — source build or pre-versioned image/)).toBeTruthy();
    // Core rejects both upgrade verbs on an unversioned build, so the
    // dashboard must not offer the check at all.
    expect(screen.getByText(/upgrades aren't supported/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });

  it("shows an upgraded-since-last-boot notice", async () => {
    mockBackend({
      build: buildInfo({ upgradedSinceLastBoot: true, previousVersion: "1.0.0" }),
    });
    renderSection();

    expect(
      await screen.findByText("Rome was upgraded from 1.0.0 to 1.1.0 since the last boot."),
    ).toBeTruthy();
  });

  it("reports up-to-date when no upgrade is available", async () => {
    mockBackend({
      build: buildInfo(),
      check: [
        {
          status: 200,
          body: {
            current: { version: "1.1.0", sha: "abc1234" },
            latest: { version: "1.1.0" },
            upgradeAvailable: false,
          },
        },
      ],
    });
    renderSection();
    const user = userEvent.setup();

    await user.click(await findEnabledButton("Check for updates"));

    expect(
      await screen.findByText("You're up to date — 1.1.0 is the latest version."),
    ).toBeTruthy();
  });

  it("renders a not-managed message when Rome Cloud is unconfigured, not an error", async () => {
    mockBackend({
      build: buildInfo(),
      check: [{ status: 503, body: { error: "pantheon_unconfigured" } }],
    });
    renderSection();
    const user = userEvent.setup();

    await user.click(await findEnabledButton("Check for updates"));

    expect(
      await screen.findByText(
        "This instance is not managed by Rome Cloud, so upgrades can't be started from the dashboard.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Update check failed/)).toBeNull();
  });

  it("clears a previous check result when a re-check fails", async () => {
    mockBackend({
      build: buildInfo(),
      check: [CHECK_AVAILABLE, { status: 502, body: { error: "pantheon_unreachable" } }],
    });
    renderSection();
    const user = userEvent.setup();

    await user.click(await findEnabledButton("Check for updates"));
    expect(await screen.findByText("Version 1.2.0 is available.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    // The failed re-check must not leave the stale offer on screen — acting on
    // it would target a version the latest check couldn't validate.
    expect(await screen.findByText("Update check failed: pantheon_unreachable")).toBeTruthy();
    expect(screen.queryByText("Version 1.2.0 is available.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade to 1.2.0" })).toBeNull();
  });

  it("upgrades after a confirmation that warns about the restart, then shows the restarting state", async () => {
    const backend = mockBackend({
      build: buildInfo(),
      check: [CHECK_AVAILABLE],
      upgrade: [{ status: 202, body: { status: "upgrading", target: "1.2.0" } }],
    });
    renderSection();
    const user = userEvent.setup();

    await user.click(await findEnabledButton("Check for updates"));
    await user.click(await screen.findByRole("button", { name: "Upgrade to 1.2.0" }));

    // The confirmation states the consequences before anything is sent.
    expect(await screen.findByText(/Rome restarts to apply the upgrade/)).toBeTruthy();
    expect(backend.upgradeRequests).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Upgrade and restart" }));

    expect(await screen.findByText("Rome is restarting")).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }]);
  });

  it("reloads only once the backend reports the target version", async () => {
    rs.useFakeTimers({ shouldAdvanceTime: true });
    const reload = rs.fn();
    rs.stubGlobal("location", { ...window.location, reload });
    // The fixture is read at response time, so flipping `version` below
    // simulates the new container coming up.
    const build = buildInfo();
    mockBackend({
      build,
      check: [CHECK_AVAILABLE],
      upgrade: [{ status: 202, body: { status: "upgrading", target: "1.2.0" } }],
    });
    renderSection();
    const user = userEvent.setup({ advanceTimers: rs.advanceTimersByTime });

    try {
      await user.click(await findEnabledButton("Check for updates"));
      await user.click(await screen.findByRole("button", { name: "Upgrade to 1.2.0" }));
      await user.click(await screen.findByRole("button", { name: "Upgrade and restart" }));
      expect(await screen.findByText("Rome is restarting")).toBeTruthy();

      // The old backend is still serving its version — a reachable backend
      // alone must not trigger the reload.
      await rs.advanceTimersByTimeAsync(3_500);
      expect(reload).not.toHaveBeenCalled();

      build.version = "1.2.0";
      await rs.advanceTimersByTimeAsync(3_500);
      await waitFor(() => expect(reload).toHaveBeenCalled());
    } finally {
      rs.unstubAllGlobals();
      rs.useRealTimers();
    }
  });

  it("gives up after the restart timeout and points the guardian at Rome Cloud", async () => {
    rs.useFakeTimers({ shouldAdvanceTime: true });
    rs.stubEnv("ROME_CLOUD_ORIGIN", "https://rome-cloud.test");
    const reload = rs.fn();
    rs.stubGlobal("location", { ...window.location, reload });
    const build = buildInfo();
    mockBackend({
      build,
      check: [CHECK_AVAILABLE],
      upgrade: [{ status: 202, body: { status: "upgrading", target: "1.2.0" } }],
    });
    renderSection();
    const user = userEvent.setup({ advanceTimers: rs.advanceTimersByTime });

    try {
      await user.click(await findEnabledButton("Check for updates"));
      await user.click(await screen.findByRole("button", { name: "Upgrade to 1.2.0" }));
      await user.click(await screen.findByRole("button", { name: "Upgrade and restart" }));
      expect(await screen.findByText("Rome is restarting")).toBeTruthy();

      // The backend never comes back on the target version.
      await rs.advanceTimersByTimeAsync(10 * 60_000 + 3_000);

      await waitFor(() =>
        expect(screen.getByText("The upgrade is taking longer than expected")).toBeTruthy(),
      );
      const link = screen.getByRole("link", { name: "Check the instance status in Rome Cloud." });
      expect(link.getAttribute("href")).toBe("https://rome-cloud.test");

      // Polling has stopped: even the target version appearing no longer reloads.
      build.version = "1.2.0";
      await rs.advanceTimersByTimeAsync(10_000);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      rs.unstubAllGlobals();
      rs.unstubAllEnvs();
      rs.useRealTimers();
    }
  });

  it("re-fetches and asks to re-confirm with the new latest when the target is stale (409)", async () => {
    const backend = mockBackend({
      build: buildInfo(),
      check: [
        CHECK_AVAILABLE,
        {
          status: 200,
          body: {
            current: { version: "1.1.0", sha: "abc1234" },
            latest: { version: "1.3.0" },
            upgradeAvailable: true,
          },
        },
      ],
      upgrade: [
        { status: 409, body: { error: "target_not_latest", latest: "1.3.0" } },
        { status: 202, body: { status: "upgrading", target: "1.3.0" } },
      ],
    });
    renderSection();
    const user = userEvent.setup();

    await user.click(await findEnabledButton("Check for updates"));
    await user.click(await screen.findByRole("button", { name: "Upgrade to 1.2.0" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade and restart" }));

    // The stale target was rejected; the dialog now pins the re-fetched latest.
    expect(await screen.findByText("Upgrade Rome to 1.3.0?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Upgrade and restart" }));

    expect(await screen.findByText("Rome is restarting")).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }, { target: "1.3.0" }]);
  });

  it("shows an error with a retry when build info can't be loaded, not a loading placeholder", async () => {
    mockBackend({
      build: [
        { status: 500, body: { error: "boom" } },
        { status: 200, body: buildInfo() },
      ],
    });
    renderSection();
    const user = userEvent.setup();

    expect(await screen.findByText("Couldn't load version info.")).toBeTruthy();
    expect(screen.queryByText("…")).toBeNull();
    // Whether this build supports upgrades is unknown, so the check must not
    // be offered.
    const check = screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("1.1.0")).toBeTruthy();
    expect(screen.queryByText("Couldn't load version info.")).toBeNull();
    await waitFor(() => expect(check.disabled).toBe(false));
  });

  it("keeps the update check disabled until build info has resolved", async () => {
    let release!: () => void;
    const buildInFlight = new Promise<void>((resolve) => (release = resolve));
    mockBackend({
      build: [{ status: 200, body: buildInfo(), wait: buildInFlight }],
    });
    renderSection();

    // On an unversioned build a click here would reach the check core is
    // meant to reject — the button must be inert until the gate has data.
    const check = (await screen.findByRole("button", {
      name: "Check for updates",
    })) as HTMLButtonElement;
    expect(check.disabled).toBe(true);

    release();
    await waitFor(() => expect(check.disabled).toBe(false));
  });

  it("sends a single upgrade request when confirm is activated repeatedly", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    const backend = mockBackend({
      build: buildInfo(),
      check: [CHECK_AVAILABLE],
      upgrade: [{ status: 202, body: { status: "upgrading", target: "1.2.0" }, wait: inFlight }],
    });
    renderSection();
    const user = userEvent.setup();

    await user.click(await findEnabledButton("Check for updates"));
    await user.click(await screen.findByRole("button", { name: "Upgrade to 1.2.0" }));
    const confirm = await screen.findByRole("button", { name: "Upgrade and restart" });
    await user.click(confirm);

    // The POST is held open; confirmation must be disabled so further clicks
    // can't resubmit.
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    await user.click(confirm);
    await user.click(confirm);
    expect(backend.upgradeRequests).toHaveLength(1);

    release();
    expect(await screen.findByText("Rome is restarting")).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }]);
  });

  it("does not resend the stale target while the 409 recovery re-check is in flight", async () => {
    let release!: () => void;
    const recheckInFlight = new Promise<void>((resolve) => (release = resolve));
    const backend = mockBackend({
      build: buildInfo(),
      check: [
        CHECK_AVAILABLE,
        {
          status: 200,
          body: {
            current: { version: "1.1.0", sha: "abc1234" },
            latest: { version: "1.3.0" },
            upgradeAvailable: true,
          },
          wait: recheckInFlight,
        },
      ],
      upgrade: [
        { status: 409, body: { error: "target_not_latest", latest: "1.3.0" } },
        { status: 202, body: { status: "upgrading", target: "1.3.0" } },
      ],
    });
    renderSection();
    const user = userEvent.setup();

    await user.click(await findEnabledButton("Check for updates"));
    await user.click(await screen.findByRole("button", { name: "Upgrade to 1.2.0" }));
    const confirm = await screen.findByRole("button", { name: "Upgrade and restart" });
    await user.click(confirm);

    // The 409 triggered a re-check that is held open. `latest` still holds the
    // rejected target, so confirmation must be disabled until the re-fetched
    // truth lands.
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    await user.click(confirm);
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }]);

    release();
    expect(await screen.findByText("Upgrade Rome to 1.3.0?")).toBeTruthy();
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));

    await user.click(confirm);

    expect(await screen.findByText("Rome is restarting")).toBeTruthy();
    expect(backend.upgradeRequests).toEqual([{ target: "1.2.0" }, { target: "1.3.0" }]);
  });
});
