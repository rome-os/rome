// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { SystemDiagnosisSection } from "./system-diagnosis-section";

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
    disk: { path: string; totalBytes: number; freeBytes: number; low: boolean } | null;
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
      disk: { path: "/data", totalBytes: 40 * GIB, freeBytes: 21 * GIB, low: false },
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
  return render(
    <QueryClientProvider client={queryClient}>
      <SystemDiagnosisSection />
    </QueryClientProvider>,
  );
}

describe("SystemDiagnosisSection", () => {
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
          disk: { path: "/data", totalBytes: 40 * GIB, freeBytes: 3 * GIB, low: true },
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
