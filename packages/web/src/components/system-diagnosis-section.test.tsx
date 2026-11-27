// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FormRows } from "@rome-os/ui/layout-form";
import i18n from "@/i18n";
import { beginInstanceEnroll } from "@/lib/instance-enroll";
import { SystemDiagnosisRow } from "./system-diagnosis-section";

rs.mock("@/lib/instance-enroll", { spy: true });

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

type Diagnosis = {
  status: "ok" | "degraded";
  checkedAt: string;
  uptimeSeconds: number;
  build: { version: string | null; sha: string | null; builtAt: string | null };
  upgradedSinceLastBoot: boolean;
  previousVersion: string | null;
  instance: {
    auth: string;
    accountId: string | null;
    instanceId: string | null;
  };
  database: { ok: boolean };
  relay: { configured: boolean; depositUrlConfigured: boolean };
  channels: string[];
  apps: { total: number; failed: string[]; broken: string[] };
  resources: {
    memory: { limitBytes: number; availableBytes: number; short: boolean } | null;
    disk: { totalBytes: number; freeBytes: number; low: boolean } | null;
  };
};

const GIB = 1024 ** 3;

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    status: "ok",
    checkedAt: "2026-06-16T12:00:00Z",
    uptimeSeconds: 3_660,
    build: { version: "1.2.0", sha: "abc1234", builtAt: "2026-06-01T12:00:00Z" },
    upgradedSinceLastBoot: false,
    previousVersion: null,
    instance: { auth: "ok", accountId: "acct_1", instanceId: "inst_1" },
    database: { ok: true },
    relay: { configured: true, depositUrlConfigured: true },
    channels: ["telegram", "webchat"],
    apps: { total: 5, failed: [], broken: [] },
    resources: {
      memory: { limitBytes: 4 * GIB, availableBytes: 2.6 * GIB, short: false },
      disk: { totalBytes: 40 * GIB, freeBytes: 21 * GIB, low: false },
    },
    ...overrides,
  };
}

function mockDiagnosis(...responses: Array<{ status: number; body: unknown }>) {
  const queue = [...responses];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/diagnosis") throw new Error(`unexpected request: ${input}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch);
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <FormRows>
        <SystemDiagnosisRow />
      </FormRows>
    </QueryClientProvider>,
  );
  // The checks live in the details sheet.
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  return view;
}

describe("SystemDiagnosisRow", () => {
  it("shows a healthy verdict with build identity, channels, and app health", async () => {
    mockDiagnosis({ status: 200, body: diagnosis() });
    renderSection();

    expect(await screen.findByText("Healthy")).toBeTruthy();
    expect(screen.getByText("1.2.0")).toBeTruthy();
    expect(screen.getByText("abc1234")).toBeTruthy();
    expect(screen.getByText("telegram, webchat")).toBeTruthy();
    expect(screen.getByText("Enrolled")).toBeTruthy();
    expect(screen.getByText("Reachable")).toBeTruthy();
    expect(screen.getByText("Relay deposit URL")).toBeTruthy();
    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText("5 loaded, none failed")).toBeTruthy();
    expect(screen.getByText("2.6 GB of 4.0 GB free")).toBeTruthy();
    expect(screen.getByText("21.0 GB of 40.0 GB free")).toBeTruthy();
    expect(screen.getAllByText("OK")).toHaveLength(2);
    expect(screen.queryByText(/Memory is short/)).toBeNull();
  });

  it("marks short memory and low disk and says what each means", async () => {
    mockDiagnosis({
      status: 200,
      body: diagnosis({
        resources: {
          memory: { limitBytes: 4 * GIB, availableBytes: 0.5 * GIB, short: true },
          disk: { totalBytes: 40 * GIB, freeBytes: 3 * GIB, low: true },
        },
      }),
    });
    renderSection();

    expect(await screen.findByText("Short")).toBeTruthy();
    expect(screen.getByText("Low")).toBeTruthy();
    expect(screen.getByText(/Memory is short/)).toBeTruthy();
    expect(screen.getByText(/Disk is nearly full/)).toBeTruthy();
  });

  it("leaves out a resource the host cannot read", async () => {
    mockDiagnosis({
      status: 200,
      body: diagnosis({ resources: { memory: null, disk: null } }),
    });
    renderSection();

    expect(await screen.findByText("Healthy")).toBeTruthy();
    expect(screen.queryByText("Memory")).toBeNull();
    expect(screen.queryByText("Disk")).toBeNull();
  });

  it("shows a degraded verdict and names the unreachable DB and failed apps", async () => {
    mockDiagnosis({
      status: 200,
      body: diagnosis({
        status: "degraded",
        database: { ok: false },
        apps: { total: 5, failed: ["calendar"], broken: ["weather"] },
      }),
    });
    renderSection();

    expect(await screen.findByText("Degraded")).toBeTruthy();
    expect(screen.getByText("Unreachable")).toBeTruthy();
    expect(screen.getByText(/failed: calendar, weather/)).toBeTruthy();
  });

  it("shows when the relay credential is missing its deposit URL", async () => {
    mockDiagnosis({
      status: 200,
      body: diagnosis({ relay: { configured: true, depositUrlConfigured: false } }),
    });
    renderSection();

    expect(await screen.findByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();
  });

  it("surfaces a load error with a refresh affordance and recovers on retry", async () => {
    mockDiagnosis({ status: 500, body: { error: "boom" } }, { status: 200, body: diagnosis() });
    renderSection();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Healthy")).toBeTruthy();
  });
});

describe("SystemDiagnosisRow reconnect", () => {
  function mockReconnect() {
    const start = rs.fn<typeof fetch>(async () =>
      Response.json({ authorizeUrl: window.location.href }),
    );
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      switch (String(input)) {
        case "/api/diagnosis":
          return Response.json(
            diagnosis({ instance: { auth: "revoked", accountId: null, instanceId: null } }),
          );
        case "/api/instance/enroll/start":
          return start(input, init);
        default:
          throw new Error(`unexpected request: ${input}`);
      }
    });
    return start;
  }

  it("starts once on rapid clicks and stays locked on success", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const start = mockReconnect().mockReturnValueOnce(promise);
    renderSection();
    const button = await screen.findByRole("button", { name: "Reconnect" });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("status", { name: "Reconnecting…" })).toBeTruthy();

    await act(async () => resolve(Response.json({ authorizeUrl: window.location.href })));
    const busy = screen.getByRole("button", { name: "Reconnecting…" });
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(start).toHaveBeenCalledExactlyOnceWith(
      "/api/instance/enroll/start",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    "HTTP failure",
    "rejection",
    "throw",
  ])("shows an error and allows retry after %s", async (failure) => {
    const start = mockReconnect();
    if (failure === "HTTP failure") {
      start.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    } else {
      rs.mocked(beginInstanceEnroll).mockImplementationOnce(() => {
        const error = new Error("unexpected enrollment failure");
        if (failure === "throw") throw error;
        return Promise.reject(error);
      });
    }
    renderSection();
    const button = await screen.findByRole("button", { name: "Reconnect" });

    await act(async () => {
      fireEvent.click(button);
    });
    const errorMessage = "Could not start reconnect. Please try again.";
    expect(screen.getByText(errorMessage)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Reconnect" });
    expect(retry.getAttribute("aria-busy")).toBeNull();
    expect(retry.getAttribute("aria-disabled")).toBeNull();

    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.queryByText(errorMessage)).toBeNull();
    const busy = screen.getByRole("button", { name: "Reconnecting…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(start).toHaveBeenCalledTimes(failure === "HTTP failure" ? 2 : 1);
  });
});
